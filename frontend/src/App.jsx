import { useEffect, useMemo, useRef, useState } from 'react'

const SOURCE_COUNT = 16
const TABS = [
  { id: 'media', label: 'Media Library', icon: '/icons/media.png' },
  { id: 'rtsp', label: 'RTSP Source', icon: '/icons/rtsp.png' },
  { id: 'viewer', label: 'Video Viewer', icon: '/icons/viewer.png' },
  { id: 'visualizer', label: 'Stats', icon: '/icons/visualizer.png' }
]
const TAB_STORAGE_KEY = 'neat-insight:selected-tab'

function flattenFiles(tree, acc = []) {
  for (const node of tree || []) {
    if (node.type === 'file') acc.push(node.path)
    if (node.type === 'folder') flattenFiles(node.children || [], acc)
  }
  return acc
}

function prettyKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

function prettyValue(key, value) {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'number' && key.includes('size')) {
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
  }
  if (typeof value === 'number' && key.includes('duration')) return `${(value / 1000).toFixed(2)} sec`
  return String(value)
}

async function fetchJson(url, init) {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || body.message || `Request failed: ${res.status}`)
  return body
}

function extractNumericFields(obj, prefix = '', out = {}) {
  if (obj === null || obj === undefined) return out
  if (typeof obj === 'number' && Number.isFinite(obj) && prefix) {
    out[prefix] = obj
    return out
  }
  if (Array.isArray(obj)) return out
  if (typeof obj !== 'object') return out

  for (const [key, value] of Object.entries(obj)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key
    extractNumericFields(value, nextPrefix, out)
  }
  return out
}

function radialOffset(radius, percent) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0))
  const circumference = 2 * Math.PI * radius
  return circumference - (circumference * pct) / 100
}

function GaugeCard({ label, percent }) {
  const radius = 28
  const circumference = 2 * Math.PI * radius
  const hasPercent = Number.isFinite(percent)
  const safePercent = hasPercent ? Math.max(0, Math.min(100, percent)) : 0
  const offset = radialOffset(radius, safePercent)

  return (
    <article className="gauge-card">
      <h3>{label}</h3>
      <div className="gauge-visual" aria-hidden="true">
        <svg viewBox="0 0 72 72" className="gauge-svg">
          <circle cx="36" cy="36" r={radius} className="gauge-track" />
          <circle
            cx="36"
            cy="36"
            r={radius}
            className="gauge-progress"
            style={{
              strokeDasharray: `${circumference} ${circumference}`,
              strokeDashoffset: offset
            }}
          />
        </svg>
        <div className="gauge-center">{hasPercent ? `${safePercent.toFixed(1)}%` : '--'}</div>
      </div>
    </article>
  )
}

function MiniSeriesCard({ name, samples }) {
  const numericSamples = samples.filter((v) => Number.isFinite(v))
  if (numericSamples.length < 2) {
    return (
      <article className="series-card">
        <header>
          <h4>{name}</h4>
          <span>--</span>
        </header>
        <div className="series-empty">Insufficient data</div>
      </article>
    )
  }

  const width = 320
  const height = 120
  const padX = 6
  const padY = 10
  const min = Math.min(...numericSamples)
  const max = Math.max(...numericSamples)
  const range = Math.max(1e-9, max - min)
  const points = []

  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]
    if (!Number.isFinite(v)) continue
    const x = padX + ((width - padX * 2) * i) / Math.max(1, samples.length - 1)
    const y = height - padY - ((v - min) / range) * (height - padY * 2)
    points.push(`${x},${y}`)
  }

  const latest = numericSamples[numericSamples.length - 1]
  return (
    <article className="series-card">
      <header>
        <h4>{name}</h4>
        <span>{latest.toFixed(2)}</span>
      </header>
      <svg viewBox={`0 0 ${width} ${height}`} className="series-svg" role="img" aria-label={`${name} trend`}>
        <polyline points={points.join(' ')} className="series-line" />
      </svg>
      <footer>
        <span>min {min.toFixed(2)}</span>
        <span>max {max.toFixed(2)}</span>
      </footer>
    </article>
  )
}

export default function App() {
  const [tab, setTab] = useState(() => {
    try {
      const saved = window.localStorage.getItem(TAB_STORAGE_KEY)
      if (saved && TABS.some((t) => t.id === saved)) return saved
    } catch {}
    return 'media'
  })
  const [mediaTree, setMediaTree] = useState([])
  const [mediaFilter, setMediaFilter] = useState('')
  const [sources, setSources] = useState([])
  const [selectedFile, setSelectedFile] = useState('')
  const [mediaInfo, setMediaInfo] = useState(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [bulkStartOpen, setBulkStartOpen] = useState(false)
  const [bulkStartCount, setBulkStartCount] = useState('1')
  const [selectedSource, setSelectedSource] = useState(1)
  const [uploadStatus, setUploadStatus] = useState('')
  const [viewerUrl, setViewerUrl] = useState('')
  const [rtspBase, setRtspBase] = useState('rtsp://127.0.0.1:8554')
  const [metrics, setMetrics] = useState(null)
  const [metricEvents, setMetricEvents] = useState([])
  const [selectedProfileSeries, setSelectedProfileSeries] = useState([])
  const [error, setError] = useState('')
  const metricEs = useRef(null)

  const allFiles = useMemo(() => flattenFiles(mediaTree), [mediaTree])
  const videoFiles = useMemo(() => allFiles.filter((p) => /\.(mp4|mov|avi|mkv|webm)$/i.test(p)), [allFiles])
  const filteredFiles = useMemo(() => {
    const q = mediaFilter.trim().toLowerCase()
    if (!q) return allFiles
    return allFiles.filter((f) => f.toLowerCase().includes(q))
  }, [allFiles, mediaFilter])
  const currentSource = sources.find((s) => s.index === selectedSource) || { index: selectedSource, file: '', state: 'stopped' }

  async function loadMedia(forceSelectFirst = false) {
    const data = await fetchJson('/api/media-files')
    setMediaTree(data)
    const flat = flattenFiles(data)
    if (forceSelectFirst) {
      setSelectedFile(flat[0] || '')
      return
    }
    if (!selectedFile && flat.length > 0) {
      setSelectedFile(flat[0])
    }
  }

  async function loadSources() {
    const data = await fetchJson('/api/mediasrc')
    const filled = Array.from({ length: SOURCE_COUNT }, (_, i) => data.find((x) => x.index === i + 1) || { index: i + 1, file: '', state: 'stopped' })
    setSources(filled)
  }

  async function loadViewerUrl() {
    const allSources = Array.from({ length: SOURCE_COUNT }, (_, i) => i).join(',')
    const params = new URLSearchParams({ src: allSources })
    const data = await fetchJson(`/api/viewer-url?${params.toString()}`)
    setViewerUrl(data.url)
  }

  async function loadRtspBase() {
    try {
      const data = await fetchJson('/api/server-ip')
      setRtspBase(`rtsp://${data.ip}:8554`)
    } catch {
      setRtspBase('rtsp://127.0.0.1:8554')
    }
  }

  async function loadMediaInfo(path) {
    if (!path) {
      setMediaInfo(null)
      return
    }
    try {
      const data = await fetchJson('/api/media-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      })
      setMediaInfo(data)
    } catch (e) {
      setMediaInfo({ error: e.message })
    }
  }

  async function refreshMetrics() {
    try {
      const data = await fetchJson('/api/metrics')
      setMetrics(data)
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => {
    Promise.all([loadMedia(), loadSources(), loadViewerUrl(), loadRtspBase(), refreshMetrics()]).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, tab)
    } catch {}
  }, [tab])

  useEffect(() => {
    if (!uploadStatus) return
    const t = setTimeout(() => setUploadStatus(''), 3200)
    return () => clearTimeout(t)
  }, [uploadStatus])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(''), 4600)
    return () => clearTimeout(t)
  }, [error])

  useEffect(() => {
    loadMediaInfo(selectedFile)
  }, [selectedFile])

  useEffect(() => {
    if (tab !== 'visualizer') return
    refreshMetrics()

    const timer = setInterval(refreshMetrics, 2000)
    metricEs.current?.close()

    const es = new EventSource('/api/neat-metrics')
    metricEs.current = es
    es.onmessage = (event) => {
      let parsed = null
      try {
        parsed = JSON.parse(event.data)
      } catch {}
      setMetricEvents((prev) =>
        [{ ts: new Date().toLocaleTimeString(), payload: event.data, parsed }, ...prev].slice(0, 180)
      )
    }
    es.onerror = () => es.close()

    return () => {
      clearInterval(timer)
      es.close()
    }
  }, [tab])

  async function onUpload(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return

    try {
      setUploadStatus(`Uploading ${files.length} file(s)...`)
      const results = await Promise.allSettled(
        files.map(async (file) => {
          const fd = new FormData()
          fd.append('file', file)
          const res = await fetch('/api/upload/media', { method: 'POST', body: fd })
          const text = await res.text()
          if (!res.ok) throw new Error(text || 'Upload failed')
          return text
        })
      )

      const okCount = results.filter((r) => r.status === 'fulfilled').length
      const failed = results
        .filter((r) => r.status === 'rejected')
        .map((r) => (r.reason?.message ? String(r.reason.message).trim() : 'Upload failed'))

      await loadMedia()
      if (!failed.length) {
        setUploadStatus(`Uploaded ${okCount} file(s).`)
      } else {
        setUploadStatus(`Uploaded ${okCount}/${files.length} file(s).`)
        setError(failed[0])
      }
    } catch (err) {
      setUploadStatus(err.message)
    }

    e.target.value = ''
  }

  async function onDelete() {
    if (!selectedFile) return
    try {
      await fetchJson('/api/delete-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile })
      })
      const deletedFile = selectedFile
      setDeleteConfirmOpen(false)
      await Promise.all([loadMedia(true), loadSources()])
      setUploadStatus(`Removed: ${deletedFile}`)
    } catch (e) {
      setError(e.message)
    }
  }

  async function updateSource(index, file) {
    await fetchJson('/api/mediasrc/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index, file })
    })
    await loadSources()
  }

  async function startSource(index) {
    await fetchJson('/api/mediasrc/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    })
    await loadSources()
  }

  async function stopSource(index) {
    await fetchJson('/api/mediasrc/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    })
    await loadSources()
  }

  async function autoAssignAllSources() {
    try {
      const data = await fetchJson('/api/mediasrc/auto-assign-all', { method: 'POST' })
      await loadSources()
      setUploadStatus(data.message || `Assigned ${data.assigned_count || 0} source(s).`)
    } catch (e) {
      setError(e.message)
    }
  }

  async function startSourcesBulk() {
    const count = Number.parseInt(bulkStartCount, 10)
    if (!Number.isFinite(count) || count < 1) {
      setError('Enter a valid stream count (>= 1).')
      return
    }
    try {
      const data = await fetchJson('/api/mediasrc/start-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count })
      })
      setBulkStartOpen(false)
      await loadSources()
      setUploadStatus(data.message || `Requested ${count} stream(s) to start.`)
      if (data.errors?.length) {
        setError(`Failed: ${data.errors.map((item) => `src${item.index}`).join(', ')}`)
      }
    } catch (e) {
      setError(e.message)
    }
  }

  async function stopAllSources() {
    try {
      const data = await fetchJson('/api/mediasrc/stop-all', { method: 'POST' })
      await loadSources()
      setUploadStatus(data.message || 'Stopped all sources.')
    } catch (e) {
      setError(e.message)
    }
  }

  async function resetAllSources() {
    try {
      const data = await fetchJson('/api/mediasrc/reset', { method: 'POST' })
      await loadSources()
      setSelectedSource(1)
      setUploadStatus(data.message || 'Reset all assignments.')
    } catch (e) {
      setError(e.message)
    }
  }

  async function copyRtsp(index) {
    const text = `${rtspBase}/src${index}`
    await navigator.clipboard.writeText(text)
    setUploadStatus(`Copied: ${text}`)
  }

  const sourcePreviewExt = (currentSource.file || '').split('.').pop()?.toLowerCase()
  const sourcePreviewIsVideo = ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(sourcePreviewExt)
  const sourcePreviewIsImage = ['jpg', 'jpeg', 'png'].includes(sourcePreviewExt)

  const previewExt = selectedFile.split('.').pop()?.toLowerCase()
  const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(previewExt)
  const isImage = ['jpg', 'jpeg', 'png'].includes(previewExt)

  const availableProfileKeys = useMemo(() => {
    const keySet = new Set()
    for (const event of metricEvents) {
      if (!event.parsed) continue
      const fields = extractNumericFields(event.parsed)
      for (const key of Object.keys(fields)) keySet.add(key)
    }
    return Array.from(keySet)
      .filter((key) => !/(^|[._-])(ts|timestamp|time_ms|time_us|time_ns|time)([._-]|$)/i.test(key))
      .sort()
  }, [metricEvents])

  useEffect(() => {
    setSelectedProfileSeries((prev) => {
      const kept = prev.filter((key) => availableProfileKeys.includes(key))
      if (kept.length > 0) return kept
      return availableProfileKeys.slice(0, 4)
    })
  }, [availableProfileKeys])

  const profileSamplesByKey = useMemo(() => {
    const ordered = metricEvents.slice().reverse()
    const rows = ordered.map((event) => (event.parsed ? extractNumericFields(event.parsed) : {}))
    const out = {}
    for (const key of selectedProfileSeries) {
      out[key] = rows.map((row) => (Number.isFinite(row[key]) ? row[key] : null))
    }
    return out
  }, [metricEvents, selectedProfileSeries])

  const cpuPct = Number.isFinite(Number(metrics?.cpu_load)) ? Number(metrics?.cpu_load) : null
  const memPct = Number.isFinite(Number(metrics?.memory?.percent)) ? Number(metrics.memory.percent) : null
  const diskPct = Number.isFinite(Number(metrics?.disk?.percent)) ? Number(metrics.disk.percent) : null
  const mlaBytes = Number.isFinite(Number(metrics?.mla_allocated_bytes)) ? Number(metrics.mla_allocated_bytes) : 0
  const mlaPct =
    Number.isFinite(Number(metrics?.memory?.total)) && Number(metrics.memory.total) > 0
      ? Math.min(100, (mlaBytes / Number(metrics.memory.total)) * 100)
      : null

  const temperatureValue = metrics?.temperature_celsius_avg

  return (
    <div className="app-shell">
      <header className="masthead">
        <div>
          <div className="masthead-title-row">
            <img src="/sima-logo.png" alt="Sima.ai" className="masthead-logo" />
            <h1>NEAT Insight</h1>
          </div>
          <p className="subhead">Runtime Monitoring and Test Console</p>
        </div>
      </header>

      <div className="toast-stack" aria-live="polite">
        {error && <div className="toast error">{error}</div>}
        {uploadStatus && <div className="toast status">{uploadStatus}</div>}
      </div>

      <nav className="tab-toolbar" role="tablist" aria-label="Main sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            aria-label={t.label}
            title={t.label}
            className={tab === t.id ? 'tab-icon-btn active' : 'tab-icon-btn'}
            onClick={() => setTab(t.id)}
          >
            <img src={t.icon} alt="" className="tab-icon" />
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>

      <main className="content">
        <div key={tab} className="tab-stage">
        {tab === 'media' && (
          <div className="grid two">
            <section className="panel">
              <div className="panel-topbar">
                <div>
                  <h2>Media Library</h2>
                  <p className="section-note">Browse, preview, and manage local media assets.</p>
                </div>
                <label className="upload-icon-btn" title="Upload Media" aria-label="Upload Media">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 3l4.5 4.5-1.4 1.4-2.1-2.1V16h-2V6.8L8.9 8.9 7.5 7.5 12 3zM5 18h14v2H5v-2z" />
                  </svg>
                  <span className="sr-only">Upload Media</span>
                  <input type="file" multiple onChange={onUpload} />
                </label>
              </div>
              <p className="meta-count">{filteredFiles.length} files</p>

              <div className="media-toolbar">
                <input className="search-input" placeholder="Filter files..." value={mediaFilter} onChange={(e) => setMediaFilter(e.target.value)} />
              </div>

              <div className="media-list">
                {filteredFiles.map((path) => (
                  <button key={path} className={path === selectedFile ? 'media-row active' : 'media-row'} onClick={() => setSelectedFile(path)}>
                    <span className="media-name">{path}</span>
                    <span className="media-ext">{path.split('.').pop()?.toUpperCase() || 'FILE'}</span>
                  </button>
                ))}
                {filteredFiles.length === 0 && <p className="empty">No files match the filter.</p>}
              </div>
            </section>

            <section className="panel">
              <h2>Selected Media</h2>
              {selectedFile && <p className="section-note">{selectedFile}</p>}

              <div className="preview">
                {selectedFile && isVideo && <video controls src={`/media/${selectedFile}`} />}
                {selectedFile && isImage && <img src={`/media/${selectedFile}`} alt={selectedFile} />}
                {!selectedFile && <p>Select a file.</p>}
              </div>

              <div className="actions">
                <button className="delete-icon-btn" onClick={() => setDeleteConfirmOpen(true)} disabled={!selectedFile} aria-label="Delete Selected" title="Delete Selected">
                  <img src="/icons/delete.png" alt="" />
                  <span className="sr-only">Delete</span>
                </button>
              </div>

              {mediaInfo && (
                <table className="kv-table">
                  <tbody>
                    {Object.entries(mediaInfo).map(([key, val]) => (
                      <tr key={key}>
                        <th>{prettyKey(key)}</th>
                        <td>{prettyValue(key, val)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        )}

        {tab === 'rtsp' && (
          <div className="grid two">
            <section className="panel">
              <div className="panel-topbar">
                <div>
                  <h2>RTSP Source Control</h2>
                  <p className="section-note">Assign streams and control source playback.</p>
                </div>
                <div className="rtsp-actions">
                  <button className="btn-ghost" onClick={autoAssignAllSources} title="Auto assign unique media files to all sources">
                    Auto Assign
                  </button>
                  <button className="btn-tonal" onClick={() => setBulkStartOpen(true)} disabled={!videoFiles.length}>
                    Bulk Start
                  </button>
                  <button className="btn-tonal" onClick={stopAllSources}>
                    Stop All
                  </button>
                  <button className="btn-ghost" onClick={resetAllSources}>
                    Reset
                  </button>
                </div>
              </div>
              <p className="hint">Base: <code>{rtspBase}</code></p>

              <div className="sources">
                {sources.map((src) => (
                  <div key={src.index} className={src.index === selectedSource ? 'source-row active' : 'source-row'} onClick={() => setSelectedSource(src.index)}>
                    <span className="src-label">src{src.index}</span>
                    <span className={src.state === 'playing' ? 'src-state playing' : 'src-state stopped'}>
                      {src.state === 'playing' ? 'Live' : 'Idle'}
                    </span>
                    <select value={src.file || ''} onChange={(e) => updateSource(src.index, e.target.value)}>
                      <option value="">Not assigned</option>
                      {videoFiles.map((file) => (
                        <option key={file} value={file}>{file}</option>
                      ))}
                    </select>
                    {src.state === 'playing' ? (
                      <button
                        className="icon-action-btn stop"
                        onClick={(e) => { e.stopPropagation(); stopSource(src.index) }}
                        aria-label={`Stop src${src.index}`}
                        title={`Stop src${src.index}`}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <rect x="6" y="6" width="12" height="12" rx="1.5" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        className="icon-action-btn play"
                        onClick={(e) => { e.stopPropagation(); startSource(src.index) }}
                        disabled={!src.file}
                        aria-label={`Start src${src.index}`}
                        title={`Start src${src.index}`}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M8 6v12l10-6-10-6z" />
                        </svg>
                      </button>
                    )}
                    <button
                      className="icon-action-btn copy"
                      onClick={(e) => { e.stopPropagation(); copyRtsp(src.index) }}
                      disabled={!src.file}
                      aria-label={`Copy RTSP for src${src.index}`}
                      title={`Copy RTSP for src${src.index}`}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M9 9h10v12H9z" />
                        <path d="M5 3h10v2H7v10H5z" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <h2>Source Preview: src{currentSource.index}</h2>
              <p className="hint">File: {currentSource.file || 'Not assigned'}</p>

              <div className="preview">
                {currentSource.file && sourcePreviewIsVideo && <video controls autoPlay muted loop src={`/media/${currentSource.file}`} />}
                {currentSource.file && sourcePreviewIsImage && <img src={`/media/${currentSource.file}`} alt={currentSource.file} />}
                {!currentSource.file && <p>Assign a media file to preview.</p>}
              </div>
            </section>
          </div>
        )}

        {tab === 'viewer' && (
          <section className="panel viewer-panel">
            <h2>Video Viewer</h2>
            <p className="section-note">Monitor active channels with low-latency WebRTC playback.</p>
            {viewerUrl ? <iframe title="viewer" src={viewerUrl} /> : <p>Viewer unavailable.</p>}
          </section>
        )}

        {tab === 'visualizer' && (
          <div className="visualizer-layout">
            <section className="panel">
              <div className="panel-topbar">
                <div>
                  <h2>System Load</h2>
                  <p className="section-note">Current device utilization snapshot.</p>
                </div>
              </div>
              <div className="gauge-grid">
                <GaugeCard
                  label="CPU Load"
                  percent={cpuPct}
                />
                <GaugeCard
                  label="Memory Usage"
                  percent={memPct}
                />
                <GaugeCard
                  label="MLA Memory"
                  percent={mlaPct}
                />
                <GaugeCard
                  label="Disk Usage"
                  percent={diskPct}
                />
              </div>
              <div className="metric-summary-row">
                <span>
                  Temperature: <strong>{temperatureValue === null || temperatureValue === undefined ? '-' : `${Number(temperatureValue).toFixed(1)}°C`}</strong>
                </span>
              </div>
            </section>

            <section className="panel">
              <div className="panel-topbar">
                <div>
                  <h2>NEAT Profiling Timeline</h2>
                  <p className="section-note">Select metrics to visualize profiling trends.</p>
                </div>
              </div>

              <div className="profile-filter-bar">
                {availableProfileKeys.length === 0 && <span className="hint">No numeric profiling fields detected yet.</span>}
                {availableProfileKeys.map((key) => {
                  const selected = selectedProfileSeries.includes(key)
                  return (
                    <button
                      key={key}
                      type="button"
                      className={selected ? 'profile-chip active' : 'profile-chip'}
                      onClick={() => {
                        setSelectedProfileSeries((prev) => {
                          if (prev.includes(key)) return prev.filter((item) => item !== key)
                          return [...prev, key].slice(0, 6)
                        })
                      }}
                    >
                      {key}
                    </button>
                  )
                })}
              </div>

              <div className="series-grid">
                {selectedProfileSeries.length === 0 && (
                  <div className="series-placeholder">Select one or more profiling fields to view trends.</div>
                )}
                {selectedProfileSeries.map((key) => (
                  <MiniSeriesCard key={key} name={key} samples={profileSamplesByKey[key] || []} />
                ))}
              </div>
            </section>
          </div>
        )}

        </div>
      </main>

      {deleteConfirmOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm deletion">
          <div className="modal-card">
            <h3>Delete File</h3>
            <p>Delete <code>{selectedFile}</code>?</p>
            <div className="modal-actions">
              <button onClick={() => setDeleteConfirmOpen(false)}>Cancel</button>
              <button className="danger" onClick={onDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {bulkStartOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Bulk start streams">
          <div className="modal-card">
            <h3>Bulk Start Streams</h3>
            <p>How many streams do you want to start?</p>
            <div className="bulk-slider-row">
              <input
                className="bulk-slider"
                type="range"
                min={1}
                max={SOURCE_COUNT}
                value={bulkStartCount}
                onChange={(e) => setBulkStartCount(e.target.value)}
              />
              <span className="bulk-slider-value">{bulkStartCount}</span>
            </div>
            <div className="modal-actions">
              <button onClick={() => setBulkStartOpen(false)}>Cancel</button>
              <button className="btn-tonal" onClick={startSourcesBulk}>Start</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
