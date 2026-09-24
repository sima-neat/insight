import { useEffect, useMemo, useRef, useState } from 'react'
import CameraDetail, { cameraSubtitle } from './peripherals/CameraDetail.jsx'
import KindIcon from './peripherals/KindIcon.jsx'
import { requestJson } from './peripherals/api.js'
import {
  CONNECTION_ERROR_CODES,
  PREVIEW_IDLE,
  availabilityInfo,
  changeSummary,
  countLabel,
  deviceTabs,
  groupCameras,
  heartbeatDelay,
  heartbeatFailureEvent,
  isSnapshotStale,
  modeLabel,
  nextPreviewState,
  normalizeError,
  previewNeedsRestart,
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

// Must match the breakpoint in styles.css where the rail turns into a row.
const RAIL_ROW_QUERY = '(max-width: 640px)'

function useMediaQuery(query) {
  const get = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches)
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    const list = typeof window !== 'undefined' ? window.matchMedia?.(query) : null
    if (!list) return undefined
    const update = () => setMatches(list.matches)
    update()
    list.addEventListener?.('change', update)
    return () => list.removeEventListener?.('change', update)
  }, [query])
  return matches
}

function DeviceKindNav({ tabs, activeId, onSelect }) {
  const refs = useRef(new Map())
  // Greyed kinds stay focusable (aria-disabled, not disabled) so a keyboard or
  // screen-reader user can read why they are not selectable.
  const [focused, setFocused] = useState(null)
  const horizontal = useMediaQuery(RAIL_ROW_QUERY)
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
    const next = {
      ArrowDown: index + 1,
      ArrowRight: index + 1,
      ArrowUp: index - 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: order.length - 1
    }[event.key]
    if (next === undefined || !order.length) return
    event.preventDefault()
    move(order[Math.max(0, Math.min(order.length - 1, next))])
  }

  return (
    <div
      className="periph-kinds"
      role="tablist"
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-label="Device kinds"
      onKeyDown={onKeyDown}
    >
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
          aria-label={tab.name}
          aria-describedby={tab.note ? `periph-kind-note-${tab.id}` : undefined}
          tabIndex={tab.id === focusId ? 0 : -1}
          className={tab.id === activeId ? 'periph-kind active' : 'periph-kind'}
          onClick={() => move(tab.id)}
        >
          <span className="periph-kind-icon">
            <KindIcon icon={tab.icon} />
            {tab.badge && <span className="periph-kind-badge" aria-hidden="true">{tab.badge}</span>}
          </span>
          {/* The tip is for sighted users (hover and keyboard focus); assistive tech gets the
              same words from aria-label and the description below. */}
          <span className="periph-kind-tip" aria-hidden="true">{tab.tooltip}</span>
          {tab.note && <span id={`periph-kind-note-${tab.id}`} className="sr-only">{tab.note}</span>}
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
  const [preview, setPreview] = useState(PREVIEW_IDLE)
  const autoRefreshed = useRef(false)
  const previewRef = useRef(PREVIEW_IDLE)
  const mounted = useRef(false)

  const tabs = useMemo(() => deviceTabs(snapshot?.items, { scanned: Boolean(snapshot?.scanned_at) }), [snapshot])
  const activeKind = resolveDeviceKind(tabs, kind)
  const groups = useMemo(() => groupCameras(snapshot?.items), [snapshot])
  const activeId = resolveCameraId(snapshot, selectedId)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const boardGenerationRef = useRef(board?.generation)
  boardGenerationRef.current = board?.generation
  const camera = groups.flatMap((group) => group.items).find((item) => item.id === activeId) || null
  const selection = useMemo(() => {
    const resolved = camera && resolveSelection(camera, wanted?.id === camera.id ? wanted : null)
    return resolved ? { id: camera.id, ...resolved } : null
  }, [camera, wanted])
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const selectionNotice = selection && wanted?.id === selection.id && !sameSelection(wanted, selection)
    ? `${modeLabel(wanted)} is no longer offered; showing ${modeLabel(selection)}.`
    : ''
  const target = board?.target || null
  const stale = isSnapshotStale(board, snapshot)
  const issues = useMemo(() => sortIssues(snapshot?.issues), [snapshot])
  const connectionError = scanError && CONNECTION_ERROR_CODES.has(scanError.code) ? scanError : null
  const scannedLabel = snapshot?.board?.label || target?.label || 'the board'

  useEffect(() => {
    previewRef.current = preview
  }, [preview])

  function dispatchPreview(event) {
    setPreview((prev) => nextPreviewState(prev, event))
  }

  async function stopPreview(sessionId = previewRef.current.session?.id, knownSession = null) {
    if (!sessionId) return true
    dispatchPreview({ type: 'stopping', for: sessionId, session: knownSession })
    try {
      await requestJson(previewUrl(sessionId, 'stop'), { method: 'POST' })
    } catch (err) {
      // Keep ownership visible so the user can retry. The board-side TTL remains the final safety
      // net, but it must not make a failed remote stop look successful.
      dispatchPreview({ type: 'stop-failed', for: sessionId, error: normalizeError(err) })
      return false
    }
    dispatchPreview({ type: 'stopped', for: sessionId })
    return true
  }

  async function startPreview(mode = selection) {
    if (!camera || !mode) return
    dispatchPreview({ type: 'start' })
    try {
      const data = await requestJson(PREVIEW_BASE, {
        method: 'POST',
        body: { id: camera.id, format: mode.format, width: mode.width, height: mode.height, fps: mode.fps }
      })
      // The user can select another camera while the board is starting this one. Adopting the
      // session anyway would label camera A's video as camera B's. The same applies to a mode
      // changed while the POST was in flight: the returned picture must match the menus.
      const latestSelection = selectionRef.current
      if (sessionMatches(data.session, activeIdRef.current, boardGenerationRef.current, latestSelection)) {
        dispatchPreview({ type: 'session', session: data.session })
      } else {
        const stopped = await stopPreview(data.session?.id, data.session)
        if (
          stopped &&
          activeIdRef.current === camera.id &&
          latestSelection?.id === camera.id &&
          !sameSelection(data.session?.mode, latestSelection)
        ) {
          await startPreview(latestSelection)
        } else if (stopped) {
          dispatchPreview({ type: 'reset' })
        }
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

  async function changeSelection(partial) {
    const next = resolveSelection(camera, partial)
    const wantedSelection = next ? { id: camera.id, ...next } : null
    selectionRef.current = wantedSelection
    setWanted(wantedSelection)
    // A running preview was started with the old mode and keeps streaming it, so the picture would
    // disagree with the menus above it. Restart it on the mode that is now selected.
    if (!previewNeedsRestart(previewRef.current, camera.id, next)) return
    if (await stopPreview(previewRef.current.session.id)) await startPreview(next)
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
      fetch(previewUrl(session.id, 'stop'), { method: 'POST' }).catch((error) => {
        console.debug('Preview stop on page exit failed; the board heartbeat timeout will release the camera.', error)
      })
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
        const event = heartbeatFailureEvent(normalizeError(err), beatSessionId)
        if (event) dispatchPreview(event)
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
            stale={stale}
            target={target}
            selection={selection}
            selectionNotice={selectionNotice}
            onSelectionChange={changeSelection}
            preview={preview}
            onStartPreview={startPreview}
            onStopPreview={() => stopPreview()}
            onOpenBoardPanel={onOpenBoardPanel}
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
          {scanning ? `Scanning ${target?.label || 'the board'}` : stale ? 'The board changed. Refresh before starting a preview.' : ''}
        </p>

        {stale && (
          <Callout title="Board changed — refresh">
            <p>These results are from {scannedLabel}; the selected board is now {target?.label || 'not set'}. Preview is disabled until you refresh.</p>
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
