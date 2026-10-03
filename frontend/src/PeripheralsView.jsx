import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { copyText, createLatestRequest, requestJson } from './peripherals/api.js'
import { canRefreshCatalog, catalogIdentity, createCatalogPolicy, deviceTypes, formatTime, isExportableMode, modeKey, modeLabel, normalizeError, resolveSelection, typeLabel } from './peripherals/model.js'
import { Callout, ErrorNotice, Pill } from './peripherals/ui.jsx'

const CATALOG_POLL_MS = 2000

function deviceLabel(device) {
  const details = device?.[device?.type] || {}
  return details.model || details.camera_name || details.name || device?.id || 'Unknown device'
}

function ModeTable({ camera, selected, onSelect }) {
  const modes = Array.isArray(camera?.modes) ? camera.modes : []
  if (!modes.length) return <p className="hint">This camera did not report any modes.</p>
  return (
    <div className="periph-mode-list" aria-label="Camera modes">
      {modes.map((mode, index) => {
        const exportable = isExportableMode(camera, mode)
        const active = selected === index
        return (
          <button
            key={`${modeLabel(mode)}-${index}`}
            type="button"
            aria-pressed={active}
            className={active ? 'periph-mode active' : 'periph-mode'}
            onClick={() => onSelect(index)}
          >
            <span>{modeLabel(mode)}</span>
            <Pill tone={mode.supported === true ? 'ok' : 'warn'}>{mode.supported === true ? 'Supported' : 'Unsupported'}</Pill>
            {!exportable && <small>{mode.reason || (mode.size_range ? 'Choose a discrete size before export.' : 'This mode cannot be exported.')}</small>}
          </button>
        )
      })}
    </div>
  )
}

function ExportPanel({ result, error, onCopy }) {
  if (error) return <ErrorNotice error={error} />
  if (!result) return null
  return (
    <section className="periph-exports" aria-label="CameraInput examples">
      <h3>CameraInput examples</h3>
      <p className="section-note">Generated from the exact catalog revision shown above.</p>
      {result.exports.map((item) => (
        <details key={item.id} open={item.id === 'python'}>
          <summary>{item.label}</summary>
          <div className="periph-code-head"><span>{item.filename}</span><button type="button" className="btn-ghost" onClick={() => onCopy(item)}>Copy</button></div>
          <pre className="periph-code"><code>{item.content}</code></pre>
        </details>
      ))}
    </section>
  )
}

export default function PeripheralsView({ board, boardError, boardLoading, onOpenBoard, onReloadBoard, onStatus }) {
  const [catalog, setCatalog] = useState(null)
  const [error, setError] = useState(null)
  const [pollError, setPollError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [type, setType] = useState('camera')
  const [deviceId, setDeviceId] = useState('')
  const [wantedMode, setWantedMode] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState(null)
  const [exportError, setExportError] = useState(null)
  const mounted = useRef(true)
  const catalogRequests = useRef(null)
  const refreshRequests = useRef(null)
  const exportRequests = useRef(null)
  const catalogPolicy = useRef(null)
  if (!catalogRequests.current) catalogRequests.current = createLatestRequest()
  if (!refreshRequests.current) refreshRequests.current = createLatestRequest()
  if (!exportRequests.current) exportRequests.current = createLatestRequest()
  if (!catalogPolicy.current) catalogPolicy.current = createCatalogPolicy()

  const commitCatalog = useCallback((next, request) => {
    const selected = catalogPolicy.current.merge(next, request)
    if (selected === next) setCatalog(next)
    return selected
  }, [])

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!board?.target) return null
    const catalogRequest = catalogPolicy.current.begin()
    if (!quiet) setLoading(true)
    let current = true
    try {
      const result = await catalogRequests.current.run((signal) => requestJson('/api/peripherals', { signal }))
      if (!result.current || !mounted.current) {
        current = false
        return null
      }
      const next = result.value
      const selected = commitCatalog(next, catalogRequest)
      setError(null)
      setPollError(null)
      return selected
    } catch (nextError) {
      if (mounted.current) setError(normalizeError(nextError))
      return null
    } finally {
      if (current && mounted.current && !quiet) setLoading(false)
    }
  }, [board?.generation, board?.target, commitCatalog])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      catalogRequests.current.cancel()
      refreshRequests.current.cancel()
      exportRequests.current.cancel()
    }
  }, [])

  useEffect(() => {
    catalogPolicy.current.reset()
    refreshRequests.current.cancel()
    setCatalog(null)
    setDeviceId('')
    setWantedMode('')
    exportRequests.current.cancel()
    setExporting(false)
    setExportResult(null)
    setExportError(null)
    if (board?.target) load()
  }, [board?.generation, board?.target, load])

  // Sentinel has no event stream: while the page is visible, poll with the held
  // revision and instance_id. Sentinel answers `unchanged`, or the full catalog
  // when anything changed or it restarted (a new instance_id).
  useEffect(() => {
    if (!catalog?.instance_id || !board?.target) return undefined
    const controller = new AbortController()
    const query = new URLSearchParams({ since_revision: catalog.revision, instance_id: catalog.instance_id, board_generation: catalog.board_generation })
    let timer
    async function poll() {
      if (document.visibilityState !== 'hidden') {
        const catalogRequest = catalogPolicy.current.begin()
        try {
          const reply = await requestJson(`/api/peripherals?${query}`, { signal: controller.signal })
          if (controller.signal.aborted) return
          setPollError(null)
          if (reply.unchanged !== true) commitCatalog(reply, catalogRequest)
        } catch (nextError) {
          if (controller.signal.aborted) return
          setPollError(normalizeError(nextError))
        }
      }
      timer = setTimeout(poll, CATALOG_POLL_MS)
    }
    timer = setTimeout(poll, CATALOG_POLL_MS)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [board?.generation, board?.target, catalog?.instance_id, catalog?.revision, catalog?.board_generation, commitCatalog])

  const tabs = useMemo(() => deviceTypes(catalog?.devices), [catalog?.devices])
  const activeType = tabs.some((item) => item.id === type) ? type : tabs[0]?.id || ''
  const devices = (catalog?.devices || []).filter((device) => device.type === activeType)
  const { device: selectedDevice, modeIndex } = resolveSelection(devices, deviceId, wantedMode)
  const camera = selectedDevice?.type === 'camera' ? selectedDevice.camera : null
  const selectedMode = camera?.modes?.[modeIndex] || null
  const canExport = isExportableMode(camera, selectedMode)
  const selectionEpoch = catalogIdentity(catalog)
  const support = catalog?.support

  // Examples are bound to one catalog revision, so a new revision clears them;
  // the selection itself survives while its device and mode still exist.
  useEffect(() => {
    exportRequests.current.cancel()
    setExporting(false)
    setExportResult(null)
    setExportError(null)
  }, [activeType, selectionEpoch])

  async function refresh() {
    if (!catalog?.instance_id) return
    const catalogRequest = catalogPolicy.current.begin()
    setRefreshing(true)
    setError(null)
    try {
      const result = await refreshRequests.current.run((signal) => requestJson('/api/peripherals/refresh', {
        method: 'POST', signal,
        body: { board_generation: catalog?.board_generation ?? board.generation }
      }))
      if (result.current) {
        const selected = commitCatalog(result.value, catalogRequest)
        onStatus(`Peripheral catalog refreshed at revision ${selected.revision}.`)
      }
    } catch (nextError) {
      setError(normalizeError(nextError))
    } finally {
      setRefreshing(false)
      onReloadBoard()
    }
  }

  async function exportMode() {
    if (!canExport) return
    setExporting(true)
    setExportError(null)
    let ownsState = true
    try {
      const response = await exportRequests.current.run((signal) => requestJson('/api/peripherals/cameras/export', {
        method: 'POST', signal,
        body: {
          board_generation: catalog.board_generation,
          instance_id: catalog.instance_id,
          revision: catalog.revision,
          device_id: selectedDevice.id,
          format: selectedMode.format,
          width: selectedMode.width,
          height: selectedMode.height,
          framerate_num: selectedMode.framerate_num,
          framerate_den: selectedMode.framerate_den
        }
      }))
      if (!response.current) {
        ownsState = false
        return
      }
      setExportResult(response.value)
    } catch (nextError) {
      setExportResult(null)
      setExportError(normalizeError(nextError))
    } finally {
      if (ownsState) setExporting(false)
    }
  }

  function selectDevice(id) {
    exportRequests.current.cancel()
    setExporting(false)
    setDeviceId(id)
    setWantedMode('')
    setExportResult(null)
    setExportError(null)
  }

  function selectMode(index) {
    exportRequests.current.cancel()
    setExporting(false)
    setDeviceId(selectedDevice?.id || '')
    setWantedMode(modeKey(camera?.modes?.[index]))
    setExportResult(null)
    setExportError(null)
  }

  function copyExport(item) {
    copyText(item.content).then(() => onStatus(`Copied ${item.filename}.`), (copyError) => setExportError(normalizeError(copyError)))
  }

  if (boardLoading && !board) return <section className="panel"><p className="hint">Loading selected board…</p></section>
  if (boardError) return <section className="panel"><ErrorNotice error={boardError}><button type="button" className="btn-ghost" onClick={onOpenBoard}>Board settings</button></ErrorNotice></section>
  if (!board?.target) return (
    <section className="panel periph-empty"><h2>Peripherals</h2><p>Select a board before reading its peripheral catalog from SiMa Sentinel.</p><button type="button" className="btn-tonal" onClick={onOpenBoard}>Select board</button></section>
  )

  return (
    <div className="periph-page">
      <section className="panel periph-heading">
        <div>
          <p className="sysinfo-eyebrow">SiMa Sentinel device catalog</p>
          <h2>Peripherals</h2>
          <p className="section-note">Read from <strong>{board.target.label}</strong> through SiMa Sentinel.</p>
        </div>
        <div className="periph-actions">
          <button type="button" className="btn-ghost" onClick={onOpenBoard}>Change board</button>
          <button type="button" className="btn-tonal" onClick={refresh} disabled={!canRefreshCatalog(catalog, refreshing)}>{refreshing ? 'Refreshing…' : 'Refresh catalog'}</button>
        </div>
      </section>

      <ErrorNotice error={error}>
        <button type="button" className="btn-ghost" onClick={() => load()}>Retry</button>
      </ErrorNotice>
      {pollError && <Callout tone="warn" title="Live updates are temporarily unavailable"><p>{pollError.message}</p>{pollError.hint && <p>{pollError.hint}</p>}</Callout>}
      {loading && !catalog && <section className="panel"><p className="hint">Reading the Sentinel peripheral catalog…</p></section>}

      {catalog && (
        <>
          <section className="panel periph-catalog-status">
            <div><Pill tone={catalog.state === 'ready' ? 'ok' : 'warn'}>{catalog.state}</Pill>{catalog.stale && <Pill tone="warn">Stale last-good catalog</Pill>}{support?.state && <Pill tone={support.state === 'applied' ? 'ok' : 'warn'}>Support rules: {support.state === 'applied' ? support.source || 'applied' : support.state.replace('_', ' ')}</Pill>}</div>
            <dl>
              <div><dt>Revision</dt><dd>{catalog.revision}</dd></div>
              <div><dt>Scan</dt><dd>{catalog.scan_sequence}</dd></div>
              <div><dt>Last success</dt><dd>{formatTime(catalog.last_success_at)}</dd></div>
              <div><dt>Last attempt</dt><dd>{formatTime(catalog.last_attempt_at)}</dd></div>
            </dl>
            {support?.state === 'not_installed' && <Callout tone="warn" title="Neat Core is not installed on this board"><p>Sentinel cannot tell which camera modes CameraInput accepts, so every mode is unsupported and no CameraInput example can be generated. Install Neat Core on the board; this page updates once Sentinel applies its rules.</p></Callout>}
            {catalog.error && <Callout tone="warn" title={catalog.error.code || 'Discovery warning'}><p>{catalog.error.reason || 'Sentinel retained its last successful catalog.'}</p></Callout>}
            {(catalog.issues || []).map((issue, index) => <Callout key={`${issue.provider || 'provider'}-${index}`} tone="warn" title={issue.provider || issue.code}><p>{issue.reason}</p></Callout>)}
          </section>

          {!catalog.ready && <Callout tone="warn" title="The first scan has not completed"><p>Sentinel is running, but its first peripheral scan has not finished yet.</p></Callout>}
          {catalog.ready && catalog.devices.length === 0 && <section className="panel periph-empty"><h3>No peripherals found</h3><p>Sentinel completed a scan and found no peripherals.</p></section>}

          {catalog.devices.length > 0 && (
            <section className="panel periph-browser">
              <nav className="periph-type-tabs" aria-label="Peripheral types">
                {tabs.map((item) => <button type="button" key={item.id} className={item.id === activeType ? 'active' : ''} onClick={() => setType(item.id)}>{item.label}<span>{item.count}</span></button>)}
              </nav>
              <div className="periph-device-list" aria-label={typeLabel(activeType)}>
                {devices.map((device) => (
                  <button type="button" aria-pressed={device.id === selectedDevice?.id} key={device.id} className={device.id === selectedDevice?.id ? 'active' : ''} onClick={() => selectDevice(device.id)}>
                    <strong>{deviceLabel(device)}</strong><span>{device.provider}</span><small>{device.id}</small>
                  </button>
                ))}
              </div>
              <article className="periph-details">
                <header><div><p className="sysinfo-eyebrow">{selectedDevice.provider}</p><h3>{deviceLabel(selectedDevice)}</h3><code>{selectedDevice.id}</code></div></header>
                {camera ? (
                  <>
                    <dl className="periph-facts"><div><dt>Backend</dt><dd>{camera.backend}</dd></div><div><dt>CameraInput name</dt><dd>{camera.camera_name || 'Not available'}</dd></div><div><dt>Modes</dt><dd>{camera.modes?.length || 0}</dd></div></dl>
                    <ModeTable camera={camera} selected={modeIndex} onSelect={selectMode} />
                    <div className="periph-actions"><button type="button" className="btn-tonal" onClick={exportMode} disabled={!canExport || exporting}>{exporting ? 'Generating…' : 'Generate CameraInput example'}</button></div>
                    {!canExport && selectedMode && <p className="hint">Export is available only for a supported discrete mode with a CameraInput name.</p>}
                    <ExportPanel result={exportResult} error={exportError} onCopy={copyExport} />
                  </>
                ) : (
                  <><p>This device type is preserved by the generic catalog.</p><pre className="periph-code"><code>{JSON.stringify(selectedDevice[activeType] || {}, null, 2)}</code></pre></>
                )}
              </article>
            </section>
          )}
        </>
      )}
    </div>
  )
}
