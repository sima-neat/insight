import { useEffect, useMemo, useRef, useState } from 'react'
import BoardTargetCard from './peripherals/BoardTargetCard.jsx'
import { copyText, downloadText, requestJson } from './peripherals/api.js'
import {
  CONNECTION_ERROR_CODES,
  availabilityInfo,
  cameraDeviceId,
  changeSummary,
  countLabel,
  deviceRows,
  formatDuration,
  formatOptions,
  formatRelativeTime,
  fpsOptions,
  groupCameras,
  isSnapshotStale,
  modeLabel,
  normalizeError,
  resolveCameraId,
  resolveSelection,
  sameSelection,
  severityInfo,
  sizeKey,
  sizeLabel,
  sizeOptions,
  sortIssues,
  tierInfo
} from './peripherals/model.js'
import { Callout, ErrorNotice, Pill, SupportLinks } from './peripherals/ui.jsx'

function subtitle(camera) {
  const deviceId = cameraDeviceId(camera)
  return [camera.model, deviceId !== camera.name && deviceId].filter(Boolean).join(' · ')
}

function IssueList({ issues }) {
  if (!issues.length) return null
  return (
    <ul className="periph-issues">
      {issues.map((issue, index) => {
        const severity = severityInfo(issue.severity)
        return (
          <li key={`${issue.code || 'issue'}-${index}`}>
            <Pill tone={severity.tone}>{severity.label}</Pill>
            <div>
              <p>{issue.message}</p>
              {issue.hint && <p className="hint">{issue.hint}</p>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function CameraList({ groups, selectedId, onSelect }) {
  const rowRefs = useRef(new Map())
  const order = groups.flatMap((group) => group.items.map((camera) => camera.id))
  const focusId = order.includes(selectedId) ? selectedId : order[0]

  function onKeyDown(event) {
    const index = order.indexOf(focusId)
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: order.length - 1 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    const id = order[Math.max(0, Math.min(order.length - 1, next))]
    onSelect(id)
    rowRefs.current.get(id)?.focus()
  }

  return (
    <div className="periph-list" role="listbox" aria-label="Detected cameras" onKeyDown={onKeyDown}>
      {groups.map((group) => (
        <div key={group.id} className="periph-group" role="group" aria-labelledby={`periph-group-${group.id}`}>
          <div id={`periph-group-${group.id}`} className="periph-group-title" role="presentation">{group.label}</div>
          {group.items.map((camera) => {
            const availability = availabilityInfo(camera.availability)
            const tier = tierInfo(camera.support?.tier)
            return (
              <div
                key={camera.id}
                ref={(node) => (node ? rowRefs.current.set(camera.id, node) : rowRefs.current.delete(camera.id))}
                role="option"
                aria-selected={camera.id === selectedId}
                tabIndex={camera.id === focusId ? 0 : -1}
                className={camera.id === selectedId ? 'periph-camera-row active' : 'periph-camera-row'}
                onClick={() => onSelect(camera.id)}
              >
                <span className="periph-camera-name">{camera.name}</span>
                <span className="periph-camera-id">{subtitle(camera)}</span>
                <span className="periph-pills">
                  <Pill tone={availability.tone}>{availability.label}</Pill>
                  <Pill tone={tier.tone}>{tier.label}</Pill>
                </span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function ModePicker({ camera, selection, notice, onChange }) {
  const formats = formatOptions(camera)
  const blocked = formats.filter((f) => f.disabled)
  const range = formats.find((f) => f.value === selection?.format)?.range
  const sizes = selection ? sizeOptions(camera, selection.format) : []
  const rates = selection ? fpsOptions(camera, selection.format, selection.width, selection.height) : []
  const blockedList = blocked.length > 0 && (
    <ul className="periph-blocked">
      {blocked.map((f) => <li key={f.value}><strong>{f.value}</strong> cannot be exported: {f.reason}</li>)}
    </ul>
  )

  if (!selection) {
    return (
      <Callout title="No exportable modes">
        <p>{camera.modes_source === 'live' ? 'None of the formats this camera reports can be exported. Reasons are listed below.' : 'Modes could not be read from this camera; the error above says why and how to fix it.'}</p>
        {blockedList}
      </Callout>
    )
  }

  return (
    <fieldset className="periph-modes">
      <legend>Input mode</legend>
      <div className="periph-mode-fields">
        <label>
          Pixel format
          <select value={selection.format} onChange={(e) => onChange({ ...selection, format: e.target.value })}>
            {formats.map((f) => <option key={f.value} value={f.value} disabled={f.disabled}>{f.label}</option>)}
          </select>
        </label>
        <label>
          Resolution
          <select
            value={sizeKey(selection.width, selection.height)}
            onChange={(e) => {
              const size = sizes.find((s) => s.value === e.target.value)
              onChange({ format: selection.format, width: size.width, height: size.height, fps: selection.fps })
            }}
          >
            {sizes.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label>
          Frame rate
          <select value={String(selection.fps)} onChange={(e) => onChange({ ...selection, fps: Number(e.target.value) })}>
            {rates.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
      </div>
      {notice && <p className="hint" role="status">{notice}</p>}
      {range && (
        <p className="hint">
          This format also accepts sizes from {sizeLabel(range.min_width, range.min_height)} to {sizeLabel(range.max_width, range.max_height)};
          only the listed sizes can be exported.
        </p>
      )}
      {blockedList}
    </fieldset>
  )
}

function ExportPanel({ camera, state, onCopy, onDownload, onRetry }) {
  const [activeTab, setActiveTab] = useState('')
  if (state.status === 'error') {
    return (
      <ErrorNotice error={state.error}>
        <button type="button" className="btn-ghost" onClick={onRetry}>Retry</button>
      </ErrorNotice>
    )
  }
  const data = state.data?.camera_id === camera.id ? state.data : null
  if (!data) return state.status === 'loading' ? <p className="hint" role="status">Preparing configuration…</p> : null
  const busy = state.status === 'loading'
  const { support, warnings = [], exports = [] } = data
  const current = exports.find((item) => item.id === activeTab) || exports[0]
  const tier = tierInfo(support?.tier)
  const coreUnsupported = camera.connection === 'usb' || support?.tier === 'unsupported'

  return (
    <section className="periph-export" aria-labelledby="periph-export-title" aria-busy={busy}>
      <div className="periph-export-head">
        <h3 id="periph-export-title">Input configuration</h3>
        <Pill tone={tier.tone}>{tier.label}</Pill>
      </div>
      {coreUnsupported && (
        <Callout tone="danger" title="Not a Core CameraInput config">
          <p>
            {support?.reason || 'Core CameraInput supports MIPI (libcamera) cameras only.'} This descriptor records the device and
            mode for your own capture code; Neat applications cannot open it with CameraInput.
          </p>
          <SupportLinks links={support?.links} />
        </Callout>
      )}
      {warnings.length > 0 && (
        <ul className="periph-warnings">
          {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
        </ul>
      )}
      <div className="periph-export-tabs" role="group" aria-label="Configuration format">
        {exports.map((item) => (
          <button key={item.id} type="button" aria-pressed={item.id === current?.id} onClick={() => setActiveTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {current && (
        <>
          <pre className="periph-code" tabIndex={0} aria-label={`${current.label} configuration`}><code>{current.content}</code></pre>
          <div className="periph-actions">
            <button type="button" className="btn-tonal" onClick={() => onCopy(current)} disabled={busy}>Copy</button>
            <button type="button" className="btn-ghost" onClick={() => onDownload(current)} disabled={busy}>Download {current.filename}</button>
          </div>
        </>
      )}
    </section>
  )
}

function CameraDetail({ camera, stale, selection, selectionNotice, onSelectionChange, exportState, onCopy, onDownload, onRetryExport }) {
  const availability = availabilityInfo(camera.availability)
  const tier = tierInfo(camera.support?.tier)

  return (
    <section className="periph-detail" aria-labelledby="periph-detail-title">
      <div className="periph-detail-head">
        <div>
          <h3 id="periph-detail-title">{camera.name}</h3>
          <p className="hint">{subtitle(camera)}</p>
        </div>
        <span className="periph-pills">
          <Pill tone={availability.tone}>{availability.label}</Pill>
          <Pill tone={tier.tone}>{tier.label}</Pill>
        </span>
      </div>

      {camera.availability?.state === 'in_use' && (
        <p className="hint">Another process has this camera open. Stop it before running an application on this camera; exporting a configuration still works.</p>
      )}
      {camera.availability?.state === 'unknown' && availability.reason && <p className="hint">Availability unknown: {availability.reason}</p>}

      {camera.support?.tier === 'verified' ? (
        camera.support.reason && <p className="hint">{camera.support.reason}</p>
      ) : (
        <Callout title={tier.label}>
          {camera.support?.reason && <p>{camera.support.reason}</p>}
          <SupportLinks links={camera.support?.links} />
        </Callout>
      )}
      {camera.notes?.length > 0 && (
        <ul className="periph-notes">
          {camera.notes.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
      )}
      <IssueList issues={(camera.errors || []).map((e) => ({ ...e, severity: 'error' }))} />

      <details className="periph-identity">
        <summary>Device details</summary>
        <table className="sysinfo-table key-value">
          <tbody>
            {deviceRows(camera).map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <ModePicker camera={camera} selection={selection} notice={selectionNotice} onChange={onSelectionChange} />
      {stale ? (
        <p className="hint">Export is paused: the board changed after this scan. Refresh to export for the current board.</p>
      ) : (
        <ExportPanel camera={camera} state={exportState} onCopy={onCopy} onDownload={onDownload} onRetry={onRetryExport} />
      )}
    </section>
  )
}

export default function PeripheralsView({ onError, onStatus }) {
  const [board, setBoard] = useState(null)
  const [boardError, setBoardError] = useState(null)
  const [snapshot, setSnapshot] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanStartedAt, setScanStartedAt] = useState(0)
  const [scanError, setScanError] = useState(null)
  const [serverStale, setServerStale] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [selectedId, setSelectedId] = useState(null)
  const [wanted, setWanted] = useState(null)
  const [exportState, setExportState] = useState({ status: 'idle' })
  const [exportAttempt, setExportAttempt] = useState(0)
  const autoRefreshed = useRef(false)
  const exportSeq = useRef(0)
  const mounted = useRef(false)

  const groups = useMemo(() => groupCameras(snapshot?.items), [snapshot])
  const activeId = resolveCameraId(snapshot, selectedId)
  const camera = groups.flatMap((group) => group.items).find((item) => item.id === activeId) || null
  const selection = useMemo(() => {
    const resolved = camera && resolveSelection(camera, wanted?.id === camera.id ? wanted : null)
    return resolved ? { id: camera.id, ...resolved } : null
  }, [camera, wanted])
  const selectionNotice = selection && wanted?.id === selection.id && !sameSelection(wanted, selection)
    ? `${modeLabel(wanted)} is no longer offered; showing ${modeLabel(selection)}.`
    : ''
  const target = board?.target || null
  const stale = serverStale || isSnapshotStale(board, snapshot)
  const issues = useMemo(() => sortIssues(snapshot?.issues), [snapshot])
  const connectionError = scanError && CONNECTION_ERROR_CODES.has(scanError.code) ? scanError : null
  const scannedLabel = snapshot?.board?.label || target?.label || 'the board'
  const exportKey = selection && !stale ? `${snapshot.generation}|${snapshot.scanned_at}|${selection.id}|${modeLabel(selection)}|${exportAttempt}` : ''

  async function loadBoard() {
    try {
      const data = await requestJson('/api/board')
      setBoard(data)
      setBoardError(null)
      return data
    } catch (err) {
      setBoardError(normalizeError(err))
      return null
    }
  }

  async function refresh() {
    setScanning(true)
    setScanStartedAt(Date.now())
    setScanError(null)
    try {
      const data = await requestJson('/api/peripherals/refresh', { method: 'POST' })
      setSnapshot(data)
      setServerStale(false)
      setLoadError(null)
      const count = groupCameras(data.items).reduce((total, group) => total + group.items.length, 0)
      onStatus?.(`Scan complete: ${countLabel(count, 'camera')} on ${data.board?.label || 'the board'}.`)
    } catch (err) {
      setScanError(normalizeError(err))
    } finally {
      setScanning(false)
      loadBoard()
    }
  }

  function handleBoardChange(data) {
    setBoard(data)
    setScanError((prev) => (prev && CONNECTION_ERROR_CODES.has(prev.code) ? null : prev))
  }

  function changeSelection(partial) {
    const next = resolveSelection(camera, partial)
    setWanted(next ? { id: camera.id, ...next } : null)
  }

  function copyExport(item) {
    copyText(item.content).then(() => onStatus?.(`Copied ${item.label} configuration.`), (err) => onError?.(err.message))
  }

  function downloadExport(item) {
    downloadText(item.filename, item.content)
    onStatus?.(`Downloaded ${item.filename}.`)
  }

  async function loadInitial() {
    const [boardData, snap] = await Promise.all([
      loadBoard(),
      requestJson('/api/peripherals').then(
        (data) => {
          setLoadError(null)
          return data
        },
        (err) => {
          const error = normalizeError(err)
          setLoadError(error.code === 'no_target' ? null : error)
          return null
        }
      )
    ])
    if (!mounted.current) return
    setSnapshot((prev) => snap || prev)
    setLoading(false)
    if (snap && !snap.scanned_at && boardData?.target && !autoRefreshed.current) {
      autoRefreshed.current = true
      refresh()
    }
  }

  useEffect(() => {
    mounted.current = true
    loadInitial()
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), scanning ? 1000 : 30000)
    return () => clearInterval(timer)
  }, [scanning])

  useEffect(() => {
    if (!exportKey) {
      exportSeq.current += 1
      setExportState({ status: 'idle' })
      return
    }
    const seq = ++exportSeq.current
    const { id, format, width, height, fps } = selection
    setExportState((prev) => ({ status: 'loading', data: prev.data?.camera_id === id ? prev.data : null }))
    requestJson('/api/peripherals/cameras/export', { method: 'POST', body: { id, format, width, height, fps } })
      .then((data) => {
        if (seq !== exportSeq.current) return
        setExportState({ status: 'ready', data })
      })
      .catch((err) => {
        if (seq !== exportSeq.current) return
        const error = normalizeError(err)
        if (error.code === 'stale_snapshot') {
          setServerStale(true)
          loadBoard()
        }
        setExportState({ status: 'error', error })
      })
  }, [exportKey])

  const elapsed = Math.max(0, Math.round((now - scanStartedAt) / 1000))
  const scannedAt = snapshot?.scanned_at
  const changes = changeSummary(snapshot?.changes)
  const removedName = snapshot?.changes?.removed?.find((item) => item.id === activeId)?.name || 'The selected camera'

  let body = null
  if (loading) body = <p className="hint">Loading peripherals…</p>
  else if (!board) body = <p className="hint">Board information is unavailable. Use Retry in the Board panel.</p>
  else if (!target) body = <p className="hint">Select a board above to discover its cameras.</p>
  else if (!scannedAt && scanning) body = <p className="hint">Scanning {target.label}…</p>
  else if (!scannedAt) body = !scanError && <p className="hint">Not scanned yet. Refresh to discover cameras on {target.label}.</p>
  else if (!groups.length) {
    body = (
      <Callout tone="info" title={`No cameras detected on ${scannedLabel}`}>
        <p>{issues.length > 0 && 'Check the notes above. '}Connect a camera (power the board off before attaching a MIPI camera), then refresh.</p>
      </Callout>
    )
  } else {
    body = (
      <div className="periph-grid">
        <CameraList groups={groups} selectedId={activeId} onSelect={setSelectedId} />
        {camera ? (
          <CameraDetail
            camera={camera}
            stale={stale}
            selection={selection}
            selectionNotice={selectionNotice}
            onSelectionChange={changeSelection}
            exportState={exportState}
            onCopy={copyExport}
            onDownload={downloadExport}
            onRetryExport={() => setExportAttempt((n) => n + 1)}
          />
        ) : (
          <div className="periph-detail">
            <Callout title={`${removedName} is no longer detected`}>
              <p>It was disconnected since the last refresh. Reconnect it and refresh, or pick another camera from the list.</p>
            </Callout>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="periph-view">
      <BoardTargetCard
        board={board}
        loading={loading}
        error={boardError}
        connectionError={connectionError}
        onBoardChange={handleBoardChange}
        onRetry={loadInitial}
        onReload={loadBoard}
        onStatus={onStatus}
        onError={onError}
      />

      <section className="panel periph-scan" aria-labelledby="periph-scan-title" aria-busy={scanning}>
        <div className="panel-topbar">
          <div>
            <h2 id="periph-scan-title">Cameras</h2>
            <p className="section-note">Discovery only reads device information. It never captures video or changes sensor settings.</p>
          </div>
          <button
            type="button"
            className="btn-tonal periph-refresh"
            onClick={() => !scanning && refresh()}
            disabled={!target}
            aria-disabled={scanning ? 'true' : undefined}
            title={target ? undefined : 'Select a board first'}
          >
            {scanning ? `Scanning… ${elapsed} s` : 'Refresh'}
          </button>
        </div>
        <p className="sr-only" role="status">
          {scanning ? `Scanning ${target?.label || 'the board'}` : stale ? 'The board changed. Refresh before exporting.' : ''}
        </p>

        {scannedAt && (
          <p className="periph-meta">
            Scanned <time dateTime={scannedAt} title={new Date(scannedAt).toLocaleString()}>{formatRelativeTime(scannedAt, now)}</time>
            {' '}from <strong>{scannedLabel}</strong>
            {snapshot.board?.hostname ? ` (${snapshot.board.hostname})` : ''}
            {Number.isFinite(snapshot.scan_ms) ? ` in ${formatDuration(snapshot.scan_ms)}` : ''}.
          </p>
        )}
        {stale && (
          <Callout title="Board changed — refresh">
            <p>These results are from {scannedLabel}; the selected board is now {target?.label || 'not set'}. Export is disabled until you refresh.</p>
            {target && <button type="button" className="btn-tonal" onClick={() => !scanning && refresh()}>Refresh now</button>}
          </Callout>
        )}
        <ErrorNotice error={loadError} />
        {scanError && (connectionError ? (
          <Callout tone="danger" title={`Scan failed: ${scanError.message}`} role="alert">
            <p>Fix the connection in the Board panel above, then refresh.</p>
          </Callout>
        ) : (
          <ErrorNotice error={{ ...scanError, message: `Scan failed: ${scanError.message}` }} />
        ))}
        {changes.length > 0 && (
          <Callout tone="info" role="status">
            {changes.map((line) => <p key={line}>{line}</p>)}
          </Callout>
        )}
        <IssueList issues={issues} />
        {body}
      </section>
    </div>
  )
}
