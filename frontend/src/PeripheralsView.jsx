import { useEffect, useMemo, useRef, useState } from 'react'
import CameraDetail, { cameraSubtitle } from './peripherals/CameraDetail.jsx'
import { requestJson } from './peripherals/api.js'
import {
  CONNECTION_ERROR_CODES,
  availabilityInfo,
  changeSummary,
  countLabel,
  deviceTabs,
  groupCameras,
  isSnapshotStale,
  modeLabel,
  normalizeError,
  resolveCameraId,
  resolveDeviceKind,
  resolveSelection,
  sameSelection,
  severityInfo,
  sortIssues,
  tierInfo
} from './peripherals/model.js'
import { Callout, ErrorNotice, Pill } from './peripherals/ui.jsx'

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
                {/* An empty subtitle must not render: the row is a grid, and a blank span would
                    leave this row taller than its neighbours. */}
                {cameraSubtitle(camera) && <span className="periph-camera-id">{cameraSubtitle(camera)}</span>}
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
  onStatus
}) {
  const [snapshot, setSnapshot] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanStartedAt, setScanStartedAt] = useState(0)
  const [scanError, setScanError] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const [kind, setKind] = useState('camera')
  const [selectedId, setSelectedId] = useState(null)
  const [wanted, setWanted] = useState(null)
  const autoRefreshed = useRef(false)
  const mounted = useRef(false)

  const tabs = useMemo(() => deviceTabs(snapshot?.items), [snapshot])
  const activeKind = resolveDeviceKind(tabs, kind)
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
  const stale = isSnapshotStale(board, snapshot)
  const issues = useMemo(() => sortIssues(snapshot?.issues), [snapshot])
  const connectionError = scanError && CONNECTION_ERROR_CODES.has(scanError.code) ? scanError : null
  const scannedLabel = snapshot?.board?.label || target?.label || 'the board'

  async function loadBoard() {
    return onReloadBoard ? onReloadBoard() : null
  }

  async function refresh() {
    setScanning(true)
    setScanStartedAt(Date.now())
    setScanError(null)
    try {
      const data = await requestJson('/api/peripherals/refresh', { method: 'POST' })
      setSnapshot(data)
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
    // Only the "Scanning… N s" counter needs a clock now that nothing on the page shows a relative time.
    if (!scanning) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [scanning])

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
            selection={selection}
            selectionNotice={selectionNotice}
            onSelectionChange={changeSelection}
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
              Detect devices attached to the board and see what they report.
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

        <p className="sr-only" role="status">
          {scanning ? `Scanning ${target?.label || 'the board'}` : stale ? 'The board changed. Refresh to scan the board that is selected now.' : ''}
        </p>

        {stale && (
          <Callout title="Board changed — refresh">
            <p>These results are from {scannedLabel}; the selected board is now {target?.label || 'not set'}.</p>
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
