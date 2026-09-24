import { useEffect, useMemo, useRef, useState } from 'react'
import CameraDetail, { cameraSubtitle } from './peripherals/CameraDetail.jsx'
import { copyText, downloadText, requestJson } from './peripherals/api.js'
import {
  CONNECTION_ERROR_CODES,
  PREVIEW_IDLE,
  availabilityInfo,
  boardIndicator,
  changeSummary,
  countLabel,
  deviceTabs,
  formatDuration,
  formatRelativeTime,
  groupCameras,
  heartbeatDelay,
  isSnapshotStale,
  modeLabel,
  nextPreviewState,
  normalizeError,
  resolveCameraId,
  resolveDeviceKind,
  resolveSelection,
  sameSelection,
  sessionMatches,
  severityInfo,
  sortIssues,
  tierInfo
} from './peripherals/model.js'
import { Callout, ErrorNotice, Pill } from './peripherals/ui.jsx'

const PREVIEW_BASE = '/api/peripherals/cameras/preview'

function previewUrl(sessionId, action) {
  return `${PREVIEW_BASE}/${encodeURIComponent(sessionId)}/${action}`
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

function DeviceKindNav({ tabs, activeId, onSelect }) {
  const refs = useRef(new Map())
  // Unbuilt kinds stay focusable (aria-disabled, not disabled) so a keyboard or
  // screen-reader user can read why they are not selectable.
  const [focused, setFocused] = useState(null)
  const order = tabs.map((tab) => tab.id)
  const focusId = order.includes(focused) ? focused : order.includes(activeId) ? activeId : order[0]

  function move(id) {
    setFocused(id)
    refs.current.get(id)?.focus()
    const tab = tabs.find((item) => item.id === id)
    if (tab && !tab.disabled) onSelect(id)
  }

  function onKeyDown(event) {
    const index = order.indexOf(focusId)
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: order.length - 1 }[event.key]
    if (next === undefined || !order.length) return
    event.preventDefault()
    move(order[Math.max(0, Math.min(order.length - 1, next))])
  }

  return (
    <div className="periph-kinds" role="tablist" aria-orientation="vertical" aria-label="Device kinds" onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`periph-kind-${tab.id}`}
          aria-controls="periph-kind-panel"
          ref={(node) => (node ? refs.current.set(tab.id, node) : refs.current.delete(tab.id))}
          aria-selected={tab.id === activeId}
          aria-disabled={tab.disabled ? 'true' : undefined}
          tabIndex={tab.id === focusId ? 0 : -1}
          className={tab.id === activeId ? 'periph-kind active' : 'periph-kind'}
          onClick={() => move(tab.id)}
        >
          <span className="periph-kind-label">{tab.label}</span>
          {tab.disabled ? (
            <span className="periph-kind-note">{tab.note}</span>
          ) : (
            <span className="periph-kind-count">{countLabel(tab.count, 'device')}</span>
          )}
        </button>
      ))}
    </div>
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
                <span className="periph-camera-id">{cameraSubtitle(camera)}</span>
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

export default function PeripheralsView({
  board,
  boardLoading = false,
  boardError = null,
  onReloadBoard,
  onOpenBoardPanel,
  onError,
  onStatus
}) {
  const [snapshot, setSnapshot] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanStartedAt, setScanStartedAt] = useState(0)
  const [scanError, setScanError] = useState(null)
  const [serverStale, setServerStale] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [kind, setKind] = useState('camera')
  const [selectedId, setSelectedId] = useState(null)
  const [wanted, setWanted] = useState(null)
  const [integrationOpen, setIntegrationOpen] = useState(false)
  const [exportState, setExportState] = useState({ status: 'idle' })
  const [exportAttempt, setExportAttempt] = useState(0)
  const [preview, setPreview] = useState(PREVIEW_IDLE)
  const autoRefreshed = useRef(false)
  const exportSeq = useRef(0)
  const previewRef = useRef(PREVIEW_IDLE)
  const mounted = useRef(false)

  const tabs = useMemo(() => deviceTabs(snapshot?.items), [snapshot])
  const activeKind = resolveDeviceKind(tabs, kind)
  const groups = useMemo(() => groupCameras(snapshot?.items), [snapshot])
  const activeId = resolveCameraId(snapshot, selectedId)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
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
  const exportKey = integrationOpen && selection && !stale
    ? `${snapshot.generation}|${snapshot.scanned_at}|${selection.id}|${modeLabel(selection)}|${exportAttempt}`
    : ''
  const boardSummary = boardIndicator(boardLoading && !board ? null : board)

  useEffect(() => {
    previewRef.current = preview
  }, [preview])

  function dispatchPreview(event) {
    setPreview((prev) => nextPreviewState(prev, event))
  }

  async function stopPreview(sessionId = previewRef.current.session?.id) {
    if (!sessionId) return
    dispatchPreview({ type: 'stopping', for: sessionId })
    try {
      await requestJson(previewUrl(sessionId, 'stop'), { method: 'POST' })
    } catch {
      // The board-side worker expires on its own, so a failed stop is not fatal.
    }
    dispatchPreview({ type: 'stopped', for: sessionId })
  }

  async function startPreview() {
    if (!camera || !selection) return
    dispatchPreview({ type: 'start' })
    try {
      const data = await requestJson(PREVIEW_BASE, {
        method: 'POST',
        body: { id: camera.id, format: selection.format, width: selection.width, height: selection.height, fps: selection.fps }
      })
      // The user can select another camera while the board is starting this one. Adopting the
      // session anyway would label camera A's video as camera B's.
      if (sessionMatches(data.session, activeIdRef.current, board?.generation)) {
        dispatchPreview({ type: 'session', session: data.session })
      } else {
        stopPreview(data.session?.id)
      }
    } catch (err) {
      dispatchPreview({ type: 'failed', error: normalizeError(err) })
    }
  }

  async function loadBoard() {
    return onReloadBoard ? onReloadBoard() : null
  }

  async function refresh() {
    await stopPreview()
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
    const [boardData, snap, existing] = await Promise.all([
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
      ),
      requestJson('/api/peripherals/preview').then((data) => data.session, () => null)
    ])
    if (!mounted.current) return
    setSnapshot((prev) => snap || prev)
    setLoading(false)
    if (existing) {
      dispatchPreview({ type: 'adopt', session: existing })
      // Follow the running preview, so opening the page does not stop it.
      if (existing.camera_id) setSelectedId(existing.camera_id)
    }
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

  useEffect(() => () => {
    const session = previewRef.current.session
    if (session?.id) {
      // Best effort on unmount: there is no UI left to report a failure to, and the board stops
      // capturing by itself once the heartbeats stop, so a lost stop cannot strand the camera.
      fetch(previewUrl(session.id, 'stop'), { method: 'POST' }).catch(() => {})
    }
  }, [])


  // Stop the preview when the selected camera, the device kind, or the board changes.
  useEffect(() => {
    const session = previewRef.current.session
    if (session && activeId && session.camera_id !== activeId) stopPreview(session.id)
  }, [activeId])

  useEffect(() => {
    if (activeKind !== 'camera') {
      const session = previewRef.current.session
      if (session) stopPreview(session.id)
    }
  }, [activeKind])

  useEffect(() => {
    const session = previewRef.current.session
    if (!session || board?.generation === undefined || session.generation === undefined) return
    if (Number(session.generation) !== Number(board.generation)) dispatchPreview({ type: 'reset' })
  }, [board?.generation])

  const beatSessionId = preview.session?.id || ''
  const beatMs = heartbeatDelay(preview.session)
  const beating = Boolean(beatSessionId) && (preview.status === 'starting' || preview.status === 'live')

  useEffect(() => {
    // A hidden tab keeps beating on purpose: the board frees the camera 45 s after the last
    // heartbeat, so pausing here would kill a preview the user only briefly switched away from.
    if (!beating) return
    let cancelled = false
    async function beat() {
      try {
        const data = await requestJson(previewUrl(beatSessionId, 'heartbeat'), { method: 'POST' })
        if (!cancelled) dispatchPreview({ type: 'session', session: data.session })
      } catch (err) {
        if (cancelled) return
        const error = normalizeError(err)
        // A 404 for an id we no longer hold must never stop a newer session.
        if (error.code === 'not_found') dispatchPreview({ type: 'expired', for: beatSessionId })
      }
    }
    beat()
    const timer = setInterval(beat, beatMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [beating, beatSessionId, beatMs])

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
  if (loading || (boardLoading && !board)) body = <p className="hint">Loading peripherals…</p>
  else if (boardError) {
    body = (
      <ErrorNotice error={boardError}>
        <button type="button" className="btn-ghost" onClick={onOpenBoardPanel}>Open board settings</button>
      </ErrorNotice>
    )
  } else if (!target) {
    body = (
      <Callout tone="info" title="No board selected">
        <p>Insight needs a board before it can discover peripherals.</p>
        <button type="button" className="btn-tonal" onClick={onOpenBoardPanel}>Choose a board</button>
      </Callout>
    )
  } else if (activeKind !== 'camera') body = <p className="hint">Insight does not read this device kind yet.</p>
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
            target={target}
            selection={selection}
            selectionNotice={selectionNotice}
            onSelectionChange={changeSelection}
            preview={preview}
            onStartPreview={startPreview}
            onStopPreview={() => stopPreview()}
            exportState={exportState}
            onCopy={copyExport}
            onDownload={downloadExport}
            onRetryExport={() => setExportAttempt((n) => n + 1)}
            onOpenBoardPanel={onOpenBoardPanel}
            integrationOpen={integrationOpen}
            onIntegrationToggle={setIntegrationOpen}
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
      <section className="panel periph-scan" aria-labelledby="periph-scan-title" aria-busy={scanning}>
        <div className="panel-topbar">
          <div>
            <h2 id="periph-scan-title">Peripherals</h2>
            <p className="section-note">
              Discovery only reads device information. Preview is the one action that opens a camera, and only while you run it.
            </p>
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

        <p className="periph-board-line">
          Board <strong>{boardSummary.label}</strong>
          {' '}<Pill tone={boardSummary.state.tone}>{boardSummary.state.short}</Pill>{' '}
          <button type="button" className="periph-link-btn" onClick={onOpenBoardPanel}>Board settings</button>
        </p>

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
            <p>These results are from {scannedLabel}; the selected board is now {target?.label || 'not set'}. Export and preview are disabled until you refresh.</p>
            {target && <button type="button" className="btn-tonal" onClick={() => !scanning && refresh()}>Refresh now</button>}
          </Callout>
        )}
        <ErrorNotice error={loadError} />
        {scanError && (connectionError ? (
          <Callout tone="danger" title={`Scan failed: ${scanError.message}`} role="alert">
            <p>{scanError.hint || 'Insight could not reach the board.'}</p>
            <button type="button" className="btn-ghost" onClick={onOpenBoardPanel}>Open board settings</button>
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

        <div className="periph-kind-layout">
          <DeviceKindNav tabs={tabs} activeId={activeKind} onSelect={setKind} />
          <div
            className="periph-kind-panel"
            id="periph-kind-panel"
            role="tabpanel"
            aria-labelledby={activeKind ? `periph-kind-${activeKind}` : undefined}
          >
            {body}
          </div>
        </div>
      </section>
    </div>
  )
}
