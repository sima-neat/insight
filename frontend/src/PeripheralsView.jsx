import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { copyText, createLatestRequest, requestJson } from './peripherals/api.js'
import { canRefreshCatalog, catalogIdentity, createCatalogPolicy, deviceTypes, formatTime, isExportableMode, modeLabel, normalizeError, typeLabel } from './peripherals/model.js'
import { Callout, ErrorNotice, Pill } from './peripherals/ui.jsx'

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
      <p className="section-note">Generated from the exact daemon catalog revision shown above.</p>
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
  const [eventError, setEventError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [type, setType] = useState('camera')
  const [deviceId, setDeviceId] = useState('')
  const [modeIndex, setModeIndex] = useState(0)
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

  const commitCatalog = useCallback((next) => {
    const selected = catalogPolicy.current.merge(next)
    if (selected === next) setCatalog(next)
    return selected
  }, [])

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!board?.target) return null
    if (!quiet) setLoading(true)
    let current = true
    try {
      const result = await catalogRequests.current.run((signal) => requestJson('/api/peripherals', { signal }))
      if (!result.current || !mounted.current) {
        current = false
        return null
      }
      const next = result.value
      const selected = commitCatalog(next)
      setError(null)
      setEventError(null)
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
    exportRequests.current.cancel()
    setExporting(false)
    setExportResult(null)
    setExportError(null)
    if (board?.target) load()
  }, [board?.generation, board?.target, load])

  useEffect(() => {
    if (!catalog?.instance_id || !board?.target) return undefined
    const controller = new AbortController()
    let cursor = catalog.sequence
    let instanceId = catalog.instance_id

    async function watch() {
      while (!controller.signal.aborted) {
        const query = new URLSearchParams({
          board_generation: String(catalog.board_generation),
          instance_id: instanceId,
          after_sequence: String(cursor),
          wait_ms: '30000'
        })
        try {
          const response = await requestJson(`/api/peripherals/events?${query}`, { signal: controller.signal })
          if (controller.signal.aborted) return
          const changed = response.resync_required || response.shutting_down || response.instance_id !== instanceId || response.events.length > 0
          cursor = response.sequence
          instanceId = response.instance_id
          setEventError(null)
          if (changed) {
            const next = await load({ quiet: true })
            if (next) {
              cursor = next.sequence
              instanceId = next.instance_id
            }
          }
        } catch (nextError) {
          if (nextError?.name === 'AbortError') return
          setEventError(normalizeError(nextError))
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      }
    }
    watch()
    return () => controller.abort()
  }, [board?.generation, board?.target, catalog?.instance_id, load])

  const tabs = useMemo(() => deviceTypes(catalog?.devices), [catalog?.devices])
  const activeType = tabs.some((item) => item.id === type) ? type : tabs[0]?.id || ''
  const devices = (catalog?.devices || []).filter((device) => device.type === activeType)
  const selectedDevice = devices.find((device) => device.id === deviceId) || devices[0] || null
  const camera = selectedDevice?.type === 'camera' ? selectedDevice.camera : null
  const selectedMode = camera?.modes?.[modeIndex] || camera?.modes?.[0] || null
  const canExport = isExportableMode(camera, selectedMode)
  const selectionEpoch = catalogIdentity(catalog)

  useEffect(() => {
    exportRequests.current.cancel()
    setExporting(false)
    setDeviceId(devices[0]?.id || '')
    setModeIndex(0)
    setExportResult(null)
    setExportError(null)
  }, [activeType, selectionEpoch])

  async function refresh() {
    if (!catalog?.instance_id) return
    setRefreshing(true)
    setError(null)
    try {
      const result = await refreshRequests.current.run((signal) => requestJson('/api/peripherals/refresh', {
        method: 'POST', signal,
        body: { board_generation: catalog?.board_generation ?? board.generation }
      }))
      if (result.current) {
        const selected = commitCatalog(result.value)
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
    setModeIndex(0)
    setExportResult(null)
    setExportError(null)
  }

  function selectMode(index) {
    exportRequests.current.cancel()
    setExporting(false)
    setModeIndex(index)
    setExportResult(null)
    setExportError(null)
  }

  function copyExport(item) {
    copyText(item.content).then(() => onStatus(`Copied ${item.filename}.`), (copyError) => setExportError(normalizeError(copyError)))
  }

  if (boardLoading && !board) return <section className="panel"><p className="hint">Loading selected board…</p></section>
  if (boardError) return <section className="panel"><ErrorNotice error={boardError}><button type="button" className="btn-ghost" onClick={onOpenBoard}>Board settings</button></ErrorNotice></section>
  if (!board?.target) return (
    <section className="panel periph-empty"><h2>Peripherals</h2><p>Select a board before reading its peripheral daemon.</p><button type="button" className="btn-tonal" onClick={onOpenBoard}>Select board</button></section>
  )

  return (
    <div className="periph-page">
      <section className="panel periph-heading">
        <div>
          <p className="sysinfo-eyebrow">Authoritative device catalog</p>
          <h2>Peripherals</h2>
          <p className="section-note">Read from <strong>{board.target.label}</strong> through the local peripheral daemon.</p>
        </div>
        <div className="periph-actions">
          <button type="button" className="btn-ghost" onClick={onOpenBoard}>Change board</button>
          <button type="button" className="btn-tonal" onClick={refresh} disabled={!canRefreshCatalog(catalog, refreshing)}>{refreshing ? 'Refreshing…' : 'Refresh catalog'}</button>
        </div>
      </section>

      <ErrorNotice error={error}>
        <button type="button" className="btn-ghost" onClick={() => load()}>Retry</button>
      </ErrorNotice>
      {eventError && <Callout tone="warn" title="Live updates are temporarily unavailable"><p>{eventError.message}</p></Callout>}
      {loading && !catalog && <section className="panel"><p className="hint">Reading the peripheral daemon…</p></section>}

      {catalog && (
        <>
          <section className="panel periph-catalog-status">
            <div><Pill tone={catalog.state === 'ready' ? 'ok' : 'warn'}>{catalog.state}</Pill>{catalog.stale && <Pill tone="warn">Stale last-good catalog</Pill>}</div>
            <dl>
              <div><dt>Revision</dt><dd>{catalog.revision}</dd></div>
              <div><dt>Scan</dt><dd>{catalog.scan_sequence}</dd></div>
              <div><dt>Last success</dt><dd>{formatTime(catalog.last_success_at)}</dd></div>
              <div><dt>Last attempt</dt><dd>{formatTime(catalog.last_attempt_at)}</dd></div>
            </dl>
            {catalog.error && <Callout tone="warn" title={catalog.error.code || 'Discovery warning'}><p>{catalog.error.reason || 'The daemon retained its last successful catalog.'}</p></Callout>}
            {(catalog.issues || []).map((issue, index) => <Callout key={`${issue.provider || 'provider'}-${index}`} tone="warn" title={issue.provider || issue.code}><p>{issue.reason}</p></Callout>)}
          </section>

          {!catalog.ready && <Callout tone="warn" title="The first scan has not completed"><p>The daemon is running, but no authoritative catalog is ready yet.</p></Callout>}
          {catalog.ready && catalog.devices.length === 0 && <section className="panel periph-empty"><h3>No peripherals found</h3><p>The daemon completed a scan and returned an empty catalog.</p></section>}

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
