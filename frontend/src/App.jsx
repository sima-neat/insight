import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'

const WorkspaceView = lazy(() => import('./WorkspaceView.jsx'))

const SOURCE_COUNT = 16
const STREAMING_TRANSPORTS = [
  { value: 'rtsp', label: 'RTSP' },
  { value: 'http', label: 'HTTP' }
]
const STREAMING_CODECS = [
  { value: 'h264', label: 'H.264' },
  { value: 'h265', label: 'H.265' },
  { value: 'mjpeg', label: 'MJPEG' }
]
const TABS = [
  { id: 'workspace', label: 'Workspace', icon: '/icons/workspace.svg' },
  { id: 'media', label: 'Media Sources', icon: '/icons/media.png' },
  { id: 'rtsp', label: 'Streaming', icon: '/icons/rtsp.png' },
  { id: 'viewer', label: 'Video Viewer', icon: '/icons/viewer.png' },
  { id: 'visualizer', label: 'Stats', icon: '/icons/visualizer.png' }
]
const TAB_STORAGE_KEY = 'neat-insight:selected-tab'
const ROUTE_TO_TAB = {
  workspace: 'workspace',
  media: 'media',
  streaming: 'rtsp',
  rtsp: 'rtsp',
  viewer: 'viewer',
  stats: 'visualizer',
  visualizer: 'visualizer'
}
const TAB_TO_ROUTE = {
  workspace: '/workspace',
  media: '/media',
  rtsp: '/streaming',
  viewer: '/viewer',
  visualizer: '/stats'
}
const ONBOARDING_STORAGE_KEY = 'neat-insight:onboarding-seen'
const ONBOARDING_STEPS = [
  {
    id: 'intro',
    tab: null,
    eyebrow: 'Step 1 of 6',
    title: 'What is Insight?',
    summary: 'Insight helps developers inspect a workspace, set up test streams, view inference results, and watch system performance while they test an application.',
    details:
      'Use it to explore the files behind your app, load media, turn that media into streaming sources, watch the live WebRTC viewer post inference with metadata rendering, and confirm whether runtime issues are coming from the stream path or the device itself.'
  },
  {
    id: 'workspace',
    tab: 'workspace',
    eyebrow: 'Step 2 of 6',
    title: 'Explore the Workspace',
    summary: 'Workspace is for browsing the shared files a developer works with across the SDK container, host, and paired DevKit.',
    details:
      'When /workspace is available, Insight starts there so you can inspect the same project artifacts used by the host tools, SDK environment, and target device. Use it to search the tree, open source files with syntax highlighting, preview Markdown as rendered documentation, and leave room for custom handlers for models, operator metrics, graphs, executables, and other development artifacts.'
  },
  {
    id: 'media',
    tab: 'media',
    eyebrow: 'Step 3 of 6',
    title: 'Start in Media Sources',
    summary: 'This is where you bring files into Insight and inspect what is available before you stream anything.',
    details:
      'Use this tab to upload videos or images, filter the library, preview a file, and remove media you no longer need.'
  },
  {
    id: 'rtsp',
    tab: 'rtsp',
    eyebrow: 'Step 4 of 6',
    title: 'Set up streaming sources',
    summary: 'This tab turns files from the library into live source slots such as src1, src2, and src3.',
    details:
      'Pick which file each source should play, choose an available transport, start one stream or many at once, stop everything, and copy the URL when another tool needs to consume the stream.'
  },
  {
    id: 'viewer',
    tab: 'viewer',
    eyebrow: 'Step 5 of 6',
    title: 'Live viewer',
    summary: 'The viewer shows active channels with low-latency WebRTC playback so you can confirm that video and inference results are flowing end to end.',
    details:
      'Your application can send video into UDP ports 9000-9079, where each port maps to one viewer channel. It can also send matching metadata into UDP ports 9100-9179 so overlays appear on the same channel. For setup guidance and application examples, see docs.sima-neat.com.'
  },
  {
    id: 'visualizer',
    tab: 'visualizer',
    eyebrow: 'Step 6 of 6',
    title: 'Check system stats',
    summary: 'The Stats tab helps you understand what the device and software runtime are doing while the apps are running.',
    details:
      'Use it to watch system load, follow profiling timelines, and spot signs that performance issues are coming from the runtime rather than the viewer.'
  }
]

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

function prettyCodec(value) {
  const text = String(value || '').trim()
  const compact = text.toLowerCase().replace(/[-_\s.]/g, '')
  if (['mjpg', 'mjpeg', 'motionjpeg', 'jpeg'].includes(compact)) return 'MJPEG'
  if (['h264', 'avc', 'avc1'].includes(compact)) return 'H.264'
  if (['h265', 'hevc', 'hev1', 'hvc1'].includes(compact)) return 'H.265'
  return text.toUpperCase()
}

function prettyValue(key, value) {
  if (value === null || value === undefined || value === '') return '-'
  if (key === 'codec' || key === 'normalized_codec') return prettyCodec(value)
  if (typeof value === 'number' && key.includes('size')) return formatBytes(value)
  if (typeof value === 'number' && key.includes('duration')) return `${(value / 1000).toFixed(2)} sec`
  return String(value)
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '-'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function catalogAssetLabel(asset) {
  if (!asset) return ''
  return [
    asset.profile,
    asset.fps ? `${asset.fps} fps` : '',
    asset.codec ? prettyCodec(asset.codec) : '',
    asset.width && asset.height ? `${asset.width}x${asset.height}` : ''
  ].filter(Boolean).join(' / ')
}

function catalogAssetSortKey(asset) {
  return [
    String(asset.source_title || asset.source_id || ''),
    Number(asset.target_height || asset.height || 0),
    Number(asset.fps || 0),
    String(asset.codec || ''),
    String(asset.path || '')
  ].join('|')
}

function catalogImportProgressForLine(line, asset) {
  const cleanLine = line.trim()
  const percentMatch = cleanLine.match(/^Downloading catalog asset:\s+(\d+)%\s+\(([^)]+)\)/)
  if (percentMatch) {
    return {
      title: 'Importing catalog asset',
      detail: `${catalogAssetLabel(asset)} - ${percentMatch[2]}`,
      percent: Number.parseInt(percentMatch[1], 10)
    }
  }
  if (cleanLine.startsWith('Downloading catalog asset:')) {
    return {
      title: 'Importing catalog asset',
      detail: cleanLine.replace(/^Downloading catalog asset:\s*/, '') || catalogAssetLabel(asset),
      percent: null
    }
  }
  if (cleanLine.startsWith('Saved catalog asset to ')) {
    return {
      title: 'Catalog asset saved',
      detail: cleanLine.replace(/^Saved catalog asset to\s+/, ''),
      percent: 100
    }
  }
  if (cleanLine === 'Catalog import complete.') {
    return {
      title: 'Catalog import complete',
      detail: catalogAssetLabel(asset),
      percent: 100
    }
  }
  return {
    title: 'Importing catalog asset',
    detail: cleanLine || catalogAssetLabel(asset),
    percent: null
  }
}

function sysInfoValue(value) {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function sysInfoEntries(obj) {
  if (!obj || typeof obj !== 'object') return []
  return Object.entries(obj).filter(([key]) => key !== 'schema')
}

function versionTag(component) {
  const bits = [component.version, component.tag && `tag ${component.tag}`, component.channel && `channel ${component.channel}`].filter(Boolean)
  return bits.join(' / ') || '-'
}

function portRange(port) {
  if (port.hostPortStart === null || port.hostPortStart === undefined) return '-'
  if (port.hostPortEnd === null || port.hostPortEnd === undefined || port.hostPortEnd === port.hostPortStart) return String(port.hostPortStart)
  return `${port.hostPortStart}-${port.hostPortEnd}`
}

function StatusPill({ value }) {
  const text = sysInfoValue(value)
  if (text === '-') return <span className="sysinfo-muted">-</span>
  const clean = text.toLowerCase()
  const positive = clean === 'running' || clean === 'ok' || clean === 'yes' || clean === 'false'
  const warning = clean.includes('available') || clean.includes('offline') || clean.includes('error')
  return <span className={['sysinfo-pill', positive ? 'ok' : '', warning ? 'warn' : ''].filter(Boolean).join(' ')}>{text}</span>
}

function componentStatus(component) {
  if (component.serviceState) return component.serviceState
  if (component.installed === false) return '-'
  if (component.updateAvailable === true) return 'Update available'
  if (component.updateAvailable === false) return 'Current'
  return '-'
}

function SysInfoKeyValueTable({ rows }) {
  if (!rows.length) return <p className="sysinfo-empty">No details reported.</p>
  return (
    <table className="sysinfo-table key-value">
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key}>
            <th scope="row">{prettyKey(key)}</th>
            <td>{typeof value === 'boolean' || key.toLowerCase().includes('status') || key.toLowerCase().includes('state') ? <StatusPill value={value} /> : sysInfoValue(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SysInfoModal({ data, loading, error, onClose, onRefresh }) {
  const components = data?.components && typeof data.components === 'object' ? Object.entries(data.components) : []
  const ports = Array.isArray(data?.exposedPorts) ? data.exposedPorts : []
  const headerDetail = data?.insight?.webUiUrl || data?.environment?.mode || ''

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="System information">
      <div className="sysinfo-modal-card">
        <header className="sysinfo-header">
          <div>
            <p className="sysinfo-eyebrow">System Information</p>
            <h3>{data?.environment?.label || 'Neat Environment'}</h3>
            {headerDetail && <p>{headerDetail}</p>}
          </div>
          <div className="sysinfo-header-actions">
            <button type="button" onClick={onRefresh} disabled={loading}>
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
            <button type="button" onClick={onClose} aria-label="Close system information">
              Close
            </button>
          </div>
        </header>

        {error && <div className="sysinfo-error">{error}</div>}
        {loading && !data && <div className="sysinfo-loading">Loading system information...</div>}

        {data && (
          <div className="sysinfo-content">
            <section className="sysinfo-section">
              <h4>Environment</h4>
              <SysInfoKeyValueTable rows={sysInfoEntries(data.environment)} />
            </section>

            <section className="sysinfo-section">
              <h4>Insight</h4>
              <SysInfoKeyValueTable rows={sysInfoEntries(data.insight)} />
            </section>

            <section className="sysinfo-section">
              <h4>Components</h4>
              <table className="sysinfo-table">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {components.map(([key, component]) => (
                    <tr key={key}>
                      <th scope="row">{component.name || prettyKey(key)}</th>
                      <td>{versionTag(component)}</td>
                      <td>
                        <StatusPill value={componentStatus(component)} />
                      </td>
                      <td>{component.latestVersion || component.detail || component.venv || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="sysinfo-section">
              <h4>Exposed Ports</h4>
              <table className="sysinfo-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Protocol</th>
                    <th>Host Port</th>
                  </tr>
                </thead>
                <tbody>
                  {ports.map((port) => (
                    <tr key={`${port.name}:${port.protocol}:${port.hostPortStart}`}>
                      <th scope="row">{port.name}</th>
                      <td>{String(port.protocol || '').toUpperCase()}</td>
                      <td>{portRange(port)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="sysinfo-section">
              <h4>Update Check</h4>
              <SysInfoKeyValueTable rows={sysInfoEntries(data.updateCheck)} />
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

function uploadProgressForLine(line, file, position, total) {
  const cleanLine = line.trim()
  const scope = total > 1 ? `${position}/${total}` : '1/1'
  const percentMatch = cleanLine.match(/^Optimizing .*?:\s+(\d+)%\s+\(([^)]+)\)/)
  if (percentMatch) {
    return {
      title: `Preparing media ${scope}`,
      detail: `${file.name} - ${percentMatch[2]}`,
      percent: Number.parseInt(percentMatch[1], 10)
    }
  }

  if (cleanLine.startsWith('Optimizing ')) {
    return {
      title: `Preparing media ${scope}`,
      detail: file.name,
      percent: null
    }
  }

  if (cleanLine.startsWith('Preparing file ')) {
    return {
      title: `Scanning upload ${scope}`,
      detail: cleanLine.replace(/^Preparing file\s+/, 'File '),
      percent: null
    }
  }

  if (cleanLine.startsWith('Optimized ')) {
    return {
      title: `Prepared media ${scope}`,
      detail: file.name,
      percent: 100
    }
  }

  if (cleanLine.startsWith('Saved archive')) {
    return {
      title: `Uploading archive ${scope}`,
      detail: file.name,
      percent: null
    }
  }

  if (cleanLine === 'Archive extracted.') {
    return {
      title: `Archive extracted ${scope}`,
      detail: file.name,
      percent: null
    }
  }

  return {
    title: `Uploading media ${scope}`,
    detail: cleanLine || file.name,
    percent: null
  }
}

async function fetchJson(url, init) {
  const res = await fetch(url, init)
  const contentType = res.headers.get('content-type') || ''
  const isJson = contentType.toLowerCase().includes('application/json')
  const body = isJson ? await res.json().catch(() => ({})) : {}

  if (!res.ok) throw new Error(body.error || body.message || `Request failed: ${res.status}`)
  if (!isJson) {
    throw new Error(`Expected JSON from ${url}, received ${contentType || 'an empty content type'}.`)
  }
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

function safeDecodeURIComponent(value = '') {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function routeStateFromLocation() {
  if (typeof window === 'undefined') return { tab: '', workspacePath: '' }
  const pathname = window.location.pathname || '/'
  const cleanPath = pathname.replace(/^\/+/, '')
  const [section = ''] = cleanPath.split('/')
  const tab = ROUTE_TO_TAB[section] || ''

  if (!tab) return { tab: '', workspacePath: '' }
  if (tab !== 'workspace') return { tab, workspacePath: '' }

  const workspacePrefix = '/workspace/'
  if (!pathname.startsWith(workspacePrefix)) return { tab, workspacePath: '' }
  return {
    tab,
    workspacePath: safeDecodeURIComponent(pathname.slice(workspacePrefix.length).replace(/^\/+/, ''))
  }
}

function workspaceRouteForPath(path = '') {
  const cleanPath = String(path || '').replace(/^\/+/, '')
  if (!cleanPath) return TAB_TO_ROUTE.workspace
  return `/workspace/${cleanPath.split('/').map(encodeURIComponent).join('/')}`
}

function routeForTab(tab, workspacePath = '') {
  if (tab === 'workspace') return workspaceRouteForPath(workspacePath)
  return TAB_TO_ROUTE[tab] || '/'
}

function updateBrowserRoute(path, replace = false) {
  if (typeof window === 'undefined') return
  const nextPath = path || '/'
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (currentPath === nextPath) return
  const method = replace ? 'replaceState' : 'pushState'
  window.history[method]({}, '', nextPath)
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

function UploadProgressCard({ progress, className = '' }) {
  if (!progress) return null

  return (
    <div className={['upload-progress-card', className].filter(Boolean).join(' ')} role="status" aria-live="polite">
      <div className="upload-progress-heading">
        <span>{progress.title}</span>
        {Number.isFinite(progress.percent) && <span>{progress.percent}%</span>}
      </div>
      <div className="upload-progress-detail" title={progress.detail}>
        {progress.detail}
      </div>
      <div className="upload-progress-track" aria-hidden="true">
        <div
          className={Number.isFinite(progress.percent) ? 'upload-progress-bar' : 'upload-progress-bar indeterminate'}
          style={Number.isFinite(progress.percent) ? { width: `${progress.percent}%` } : undefined}
        />
      </div>
    </div>
  )
}

export default function App() {
  const initialRoute = routeStateFromLocation()
  const [tab, setTab] = useState(() => {
    if (initialRoute.tab) return initialRoute.tab
    try {
      const saved = window.localStorage.getItem(TAB_STORAGE_KEY)
      if (saved && TABS.some((t) => t.id === saved)) return saved
    } catch {}
    return TABS[0].id
  })
  const [routeWorkspacePath, setRouteWorkspacePath] = useState(() => initialRoute.workspacePath)
  const [mediaTree, setMediaTree] = useState([])
  const [mediaFilter, setMediaFilter] = useState('')
  const [sources, setSources] = useState([])
  const [selectedFile, setSelectedFile] = useState('')
  const [selectedMediaPaths, setSelectedMediaPaths] = useState([])
  const [mediaInfo, setMediaInfo] = useState(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [bulkStartOpen, setBulkStartOpen] = useState(false)
  const [bulkStartCount, setBulkStartCount] = useState('1')
  const [selectedSource, setSelectedSource] = useState(1)
  const [uploadStatus, setUploadStatus] = useState('')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null)
  const [localDropActive, setLocalDropActive] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importTab, setImportTab] = useState('local')
  const [catalog, setCatalog] = useState(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [catalogMode, setCatalogMode] = useState('type')
  const [catalogFilter, setCatalogFilter] = useState('')
  const [catalogSourceId, setCatalogSourceId] = useState('')
  const [catalogProfile, setCatalogProfile] = useState('')
  const [catalogCodec, setCatalogCodec] = useState('')
  const [catalogAssetPath, setCatalogAssetPath] = useState('')
  const [catalogSelectedAssetPaths, setCatalogSelectedAssetPaths] = useState([])
  const [viewerUrl, setViewerUrl] = useState('')
  const [rtspBase, setRtspBase] = useState('rtsp://127.0.0.1:8554')
  const [metrics, setMetrics] = useState(null)
  const [metricEvents, setMetricEvents] = useState([])
  const [selectedProfileSeries, setSelectedProfileSeries] = useState([])
  const [devkitShellInfo, setDevkitShellInfo] = useState(null)
  const [devkitShellBusy, setDevkitShellBusy] = useState(false)
  const [sysInfoOpen, setSysInfoOpen] = useState(false)
  const [sysInfo, setSysInfo] = useState(null)
  const [sysInfoLoading, setSysInfoLoading] = useState(false)
  const [sysInfoError, setSysInfoError] = useState('')
  const [tourOpen, setTourOpen] = useState(() => {
    try {
      return window.localStorage.getItem(ONBOARDING_STORAGE_KEY) !== '1'
    } catch {
      return true
    }
  })
  const [tourStep, setTourStep] = useState(0)
  const [error, setError] = useState('')
  const metricEs = useRef(null)

  const allFiles = useMemo(() => flattenFiles(mediaTree), [mediaTree])
  const videoFiles = useMemo(() => allFiles.filter((p) => /\.(mp4|mov|avi|mkv|webm|mjpeg|mjpg|jpg|jpeg)$/i.test(p)), [allFiles])
  const filteredFiles = useMemo(() => {
    const q = mediaFilter.trim().toLowerCase()
    if (!q) return allFiles
    return allFiles.filter((f) => f.toLowerCase().includes(q))
  }, [allFiles, mediaFilter])
  const catalogSources = useMemo(() => Array.isArray(catalog?.sources) ? catalog.sources : [], [catalog])
  const catalogAssets = useMemo(() => Array.isArray(catalog?.assets) ? catalog.assets : [], [catalog])
  const catalogSourcesById = useMemo(() => {
    const byId = new Map()
    for (const source of catalogSources) {
      if (source.id) byId.set(source.id, source)
    }
    return byId
  }, [catalogSources])
  const catalogAssetsBySource = useMemo(() => {
    const grouped = new Map()
    for (const asset of catalogAssets) {
      const sourceId = asset.source_id
      if (!sourceId) continue
      if (!grouped.has(sourceId)) grouped.set(sourceId, [])
      grouped.get(sourceId).push(asset)
    }
    for (const assets of grouped.values()) {
      assets.sort((a, b) => catalogAssetSortKey(a).localeCompare(catalogAssetSortKey(b)))
    }
    return grouped
  }, [catalogAssets])
  const filteredCatalogSources = useMemo(() => {
    const q = catalogFilter.trim().toLowerCase()
    if (!q) return catalogSources
    return catalogSources.filter((source) =>
      [source.title, source.description, source.id].filter(Boolean).some((value) => String(value).toLowerCase().includes(q))
    )
  }, [catalogFilter, catalogSources])
  const selectedCatalogSource = catalogSources.find((source) => source.id === catalogSourceId) || filteredCatalogSources[0] || null
  const selectedCatalogAssets = selectedCatalogSource ? catalogAssetsBySource.get(selectedCatalogSource.id) || [] : []
  const activeCatalogOptionAssets = catalogMode === 'type' ? catalogAssets : selectedCatalogAssets
  const catalogProfiles = useMemo(() => [...new Set(activeCatalogOptionAssets.map((asset) => asset.profile).filter(Boolean))].sort(), [activeCatalogOptionAssets])
  const catalogCodecOptions = useMemo(() => [...new Set(activeCatalogOptionAssets.map((asset) => asset.codec).filter(Boolean))].sort(), [activeCatalogOptionAssets])
  const matchingCatalogAssets = useMemo(() => {
    return selectedCatalogAssets.filter((asset) => {
      if (asset.preview) return false
      if (catalogProfile && asset.profile !== catalogProfile) return false
      if (catalogCodec && asset.codec !== catalogCodec) return false
      return true
    })
  }, [catalogCodec, catalogProfile, selectedCatalogAssets])
  const typeMatchingCatalogAssets = useMemo(() => {
    const q = catalogFilter.trim().toLowerCase()
    return catalogAssets.filter((asset) => {
      if (asset.preview) return false
      if (catalogProfile && asset.profile !== catalogProfile) return false
      if (catalogCodec && asset.codec !== catalogCodec) return false
      if (!q) return true
      const source = catalogSourcesById.get(asset.source_id) || {}
      return [source.title, source.description, source.id, asset.source_title, asset.source_id]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    }).sort((a, b) => catalogAssetSortKey(a).localeCompare(catalogAssetSortKey(b)))
  }, [catalogAssets, catalogCodec, catalogFilter, catalogProfile, catalogSourcesById])
  const selectedTypeCatalogAssets = useMemo(() => {
    const selected = new Set(catalogSelectedAssetPaths)
    return typeMatchingCatalogAssets.filter((asset) => selected.has(asset.path))
  }, [catalogSelectedAssetPaths, typeMatchingCatalogAssets])
  const selectedCatalogAsset = matchingCatalogAssets.find((asset) => asset.path === catalogAssetPath) || matchingCatalogAssets[0] || null
  const selectedCatalogAssetBytes = selectedCatalogAsset ? Number(selectedCatalogAsset.bytes || 0) : 0
  const selectedTypeCatalogBytes = useMemo(
    () => selectedTypeCatalogAssets.reduce((total, asset) => total + Number(asset.bytes || 0), 0),
    [selectedTypeCatalogAssets]
  )
  const selectedCatalogPreview = selectedCatalogAssets.find((asset) => asset.preview && asset.codec === 'h264') || selectedCatalogAssets.find((asset) => asset.preview) || null
  const currentSource = sources.find((s) => s.index === selectedSource) || { index: selectedSource, file: '', state: 'stopped' }
  const deleteTargetPaths = selectedMediaPaths.length ? selectedMediaPaths : (selectedFile ? [selectedFile] : [])

  function selectTab(nextTab, workspacePath = '', options = {}) {
    setTab(nextTab)
    setRouteWorkspacePath(nextTab === 'workspace' ? workspacePath : '')
    updateBrowserRoute(routeForTab(nextTab, workspacePath), Boolean(options.replace))
  }

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
    const filled = Array.from({ length: SOURCE_COUNT }, (_, i) => data.find((x) => x.index === i + 1) || { index: i + 1, file: '', state: 'stopped', transport: 'rtsp', codec: 'h264', allowed_transports: ['rtsp'], urls: {} })
    setSources(filled)
  }

  async function loadViewerUrl() {
    const data = await fetchJson('/api/viewer-url')
    setViewerUrl(data.url)
  }

  async function loadDevkitShellInfo() {
    try {
      const data = await fetchJson('/api/devkit-shell')
      setDevkitShellInfo(data)
    } catch {
      setDevkitShellInfo(null)
    }
  }

  async function loadSysInfo() {
    setSysInfoLoading(true)
    setSysInfoError('')
    try {
      const data = await fetchJson(`/api/sysinfo?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      })
      setSysInfo(data)
    } catch (e) {
      setSysInfo(null)
      setSysInfoError(e.message)
    } finally {
      setSysInfoLoading(false)
    }
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
    Promise.all([loadMedia(), loadSources(), loadViewerUrl(), loadRtspBase(), refreshMetrics(), loadDevkitShellInfo()]).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    const syncFromRoute = () => {
      const route = routeStateFromLocation()
      if (!route.tab) return
      setTab(route.tab)
      setRouteWorkspacePath(route.tab === 'workspace' ? route.workspacePath : '')
    }

    window.addEventListener('popstate', syncFromRoute)
    return () => window.removeEventListener('popstate', syncFromRoute)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, tab)
    } catch {}
  }, [tab])

  useEffect(() => {
    if (!tourOpen) return
    const step = ONBOARDING_STEPS[tourStep]
    if (!step || !step.tab || step.tab === tab) return
    selectTab(step.tab, '', { replace: true })
  }, [tab, tourOpen, tourStep])

  useEffect(() => {
    if (!uploadStatus) return
    if (uploadBusy) return
    const t = setTimeout(() => setUploadStatus(''), 3200)
    return () => clearTimeout(t)
  }, [uploadStatus, uploadBusy])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(''), 4600)
    return () => clearTimeout(t)
  }, [error])

  useEffect(() => {
    loadMediaInfo(selectedFile)
  }, [selectedFile])

  useEffect(() => {
    if (!selectedMediaPaths.length) return
    const available = new Set(allFiles)
    const next = selectedMediaPaths.filter((path) => available.has(path))
    if (next.length !== selectedMediaPaths.length) {
      setSelectedMediaPaths(next)
    }
  }, [allFiles, selectedMediaPaths])

  useEffect(() => {
    if (!selectedCatalogSource) {
      setCatalogSourceId('')
      return
    }
    if (catalogSourceId !== selectedCatalogSource.id) {
      setCatalogSourceId(selectedCatalogSource.id)
    }
  }, [catalogSourceId, selectedCatalogSource])

  useEffect(() => {
    if (matchingCatalogAssets.length === 0) {
      if (catalogAssetPath) setCatalogAssetPath('')
      return
    }
    if (!matchingCatalogAssets.some((asset) => asset.path === catalogAssetPath)) {
      setCatalogAssetPath(matchingCatalogAssets[0].path)
    }
  }, [catalogAssetPath, matchingCatalogAssets])

  useEffect(() => {
    if (catalogSelectedAssetPaths.length === 0) return
    const available = new Set(typeMatchingCatalogAssets.map((asset) => asset.path))
    const next = catalogSelectedAssetPaths.filter((path) => available.has(path))
    if (next.length !== catalogSelectedAssetPaths.length) {
      setCatalogSelectedAssetPaths(next)
    }
  }, [catalogSelectedAssetPaths, typeMatchingCatalogAssets])

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

  async function loadCatalog() {
    setCatalogLoading(true)
    setCatalogError('')
    try {
      const data = await fetchJson('/api/media-catalog')
      setCatalog(data)
      if (!catalogSourceId && Array.isArray(data.sources) && data.sources.length) {
        setCatalogSourceId(data.sources[0].id)
      }
    } catch (e) {
      setCatalogError(e.message)
    } finally {
      setCatalogLoading(false)
    }
  }

  function openImportDialog(nextTab = 'local') {
    setImportTab(nextTab)
    setImportDialogOpen(true)
    if (nextTab === 'catalog' && !catalog && !catalogLoading) {
      loadCatalog()
    }
  }

  async function readCatalogImportProgress(response, asset) {
    if (!response.body) {
      const text = await response.text()
      if (!response.ok) throw new Error(text || 'Catalog import failed')
      const lastLine = text.trim().split(/\r?\n/).filter(Boolean).pop()
      if (lastLine) setUploadProgress(catalogImportProgressForLine(lastLine, asset))
      const failureLine = text.split(/\r?\n/).find((line) => /^Catalog import failed:|^Checksum mismatch|^Size mismatch/.test(line.trim()))
      if (failureLine) throw new Error(failureLine.trim())
      return text
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let pending = ''

    while (true) {
      const { value, done } = await reader.read()
      const chunk = decoder.decode(value || new Uint8Array(), { stream: !done })
      if (chunk) {
        text += chunk
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() || ''
        const lastLine = lines.map((line) => line.trim()).filter(Boolean).pop()
        if (lastLine) setUploadProgress(catalogImportProgressForLine(lastLine, asset))
      }
      if (done) break
    }

    const finalLine = pending.trim()
    if (finalLine) setUploadProgress(catalogImportProgressForLine(finalLine, asset))
    if (!response.ok) throw new Error(text || 'Catalog import failed')
    const failureLine = text.split(/\r?\n/).find((line) => /^Catalog import failed:|^Checksum mismatch|^Size mismatch/.test(line.trim()))
    if (failureLine) throw new Error(failureLine.trim())
    return text
  }

  function toggleCatalogAssetSelection(path) {
    setCatalogSelectedAssetPaths((prev) => {
      if (prev.includes(path)) return prev.filter((item) => item !== path)
      return [...prev, path]
    })
  }

  function selectAllMatchingCatalogAssets() {
    setCatalogSelectedAssetPaths(typeMatchingCatalogAssets.map((asset) => asset.path))
  }

  async function importCatalogAssets(assets) {
    const assetsToImport = assets.filter(Boolean)
    if (!assetsToImport.length) return
    setUploadBusy(true)
    setUploadProgress({
      title: 'Importing catalog asset',
      detail: catalogAssetLabel(assetsToImport[0]),
      percent: null
    })
    setUploadStatus('')
    setError('')
    try {
      let lastSavedPath = ''
      for (let index = 0; index < assetsToImport.length; index += 1) {
        const asset = assetsToImport[index]
        setUploadProgress({
          title: `Importing catalog asset ${index + 1}/${assetsToImport.length}`,
          detail: catalogAssetLabel(asset),
          percent: null
        })
        const res = await fetch('/api/import/media-catalog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: asset.path })
        })
        const text = await readCatalogImportProgress(res, asset)
        const savedLine = text.split(/\r?\n/).find((line) => line.startsWith('Saved catalog asset to '))
        const savedPath = savedLine ? savedLine.replace(/^Saved catalog asset to\s+/, '').trim() : ''
        if (savedPath) lastSavedPath = savedPath
      }
      await loadMedia()
      if (lastSavedPath) setSelectedFile(lastSavedPath)
      setUploadProgress(null)
      setUploadStatus(`Imported ${assetsToImport.length} catalog asset(s).`)
      setImportDialogOpen(false)
      setCatalogSelectedAssetPaths([])
    } catch (e) {
      setError(e.message)
      setUploadProgress(null)
    } finally {
      setUploadBusy(false)
    }
  }

  async function importCatalogAsset() {
    await importCatalogAssets([selectedCatalogAsset])
  }

  async function readUploadProgress(response, file, position, total) {
    if (!response.body) {
      const text = await response.text()
      if (!response.ok) throw new Error(text || 'Upload failed')
      const failureLine = text.split(/\r?\n/).find((line) => /^FFmpeg (conversion failed|is not installed)/.test(line.trim()))
      if (failureLine) throw new Error(`${file.name}: ${failureLine.trim()}`)
      const lastLine = text.trim().split(/\r?\n/).filter(Boolean).pop()
      if (lastLine) setUploadProgress(uploadProgressForLine(lastLine, file, position, total))
      return text
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let pending = ''

    while (true) {
      const { value, done } = await reader.read()
      const chunk = decoder.decode(value || new Uint8Array(), { stream: !done })
      if (chunk) {
        text += chunk
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() || ''
        const lastLine = lines.map((line) => line.trim()).filter(Boolean).pop()
        if (lastLine) {
          setUploadProgress(uploadProgressForLine(lastLine, file, position, total))
        }
      }
      if (done) break
    }

    const finalLine = pending.trim()
    if (finalLine) setUploadProgress(uploadProgressForLine(finalLine, file, position, total))
    if (!response.ok) throw new Error(text || 'Upload failed')
    const failureLine = text.split(/\r?\n/).find((line) => /^FFmpeg (conversion failed|is not installed)/.test(line.trim()))
    if (failureLine) throw new Error(`${file.name}: ${failureLine.trim()}`)
    return text
  }

  async function uploadFiles(filesInput) {
    const files = Array.from(filesInput || [])
    if (!files.length) return

    setUploadBusy(true)
    setUploadProgress(null)
    try {
      setError('')
      let okCount = 0
      const failed = []
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i]
        const position = i + 1
        setUploadStatus(`${position}/${files.length} Uploading ${file.name}...`)
        setUploadProgress({
          title: `Uploading media ${position}/${files.length}`,
          detail: file.name,
          percent: null
        })
        try {
          const fd = new FormData()
          fd.append('file', file)
          const res = await fetch('/api/upload/media', { method: 'POST', body: fd })
          await readUploadProgress(res, file, position, files.length)
          okCount += 1
        } catch (err) {
          failed.push(err?.message ? String(err.message).trim() : `${file.name}: upload failed`)
        }
      }

      await loadMedia()
      if (!failed.length) {
        setUploadProgress(null)
        setUploadStatus(`Uploaded and prepared ${okCount} file(s).`)
        setImportDialogOpen(false)
      } else {
        setUploadProgress(null)
        setUploadStatus(`Uploaded and prepared ${okCount}/${files.length} file(s).`)
        setError(failed[0])
      }
    } catch (err) {
      setUploadProgress(null)
      setUploadStatus(err.message)
    } finally {
      setUploadBusy(false)
      setUploadProgress(null)
    }
  }

  async function onUpload(e) {
    await uploadFiles(e.target.files)
    e.target.value = ''
  }

  function onLocalDropDragOver(e) {
    e.preventDefault()
    e.stopPropagation()
    if (uploadBusy) return
    e.dataTransfer.dropEffect = 'copy'
    setLocalDropActive(true)
  }

  function onLocalDropDragLeave(e) {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget.contains(e.relatedTarget)) return
    setLocalDropActive(false)
  }

  async function onLocalDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    setLocalDropActive(false)
    if (uploadBusy) return
    await uploadFiles(e.dataTransfer.files)
  }

  function onImportDragOver(e) {
    if (importTab !== 'local') return
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    if (!uploadBusy) {
      e.dataTransfer.dropEffect = 'copy'
      setLocalDropActive(true)
    }
  }

  function onImportDrop(e) {
    if (importTab !== 'local') return
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    setLocalDropActive(false)
    if (!uploadBusy) {
      uploadFiles(e.dataTransfer.files)
    }
  }

  function toggleSelectedMediaPath(path) {
    setSelectedMediaPaths((current) => (
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path]
    ))
  }

  function clearSelectedMediaPaths() {
    setSelectedMediaPaths([])
  }

  async function onDelete() {
    const paths = [...deleteTargetPaths]
    if (!paths.length) return
    try {
      const failed = []
      for (const path of paths) {
        try {
          await fetchJson('/api/delete-media', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
          })
        } catch (err) {
          failed.push(err?.message ? `${path}: ${err.message}` : `${path}: delete failed`)
        }
      }
      setDeleteConfirmOpen(false)
      setSelectedMediaPaths([])
      await Promise.all([loadMedia(true), loadSources()])
      if (failed.length) {
        setError(failed[0])
        setUploadStatus(`Removed ${paths.length - failed.length}/${paths.length} media file(s).`)
      } else {
        setUploadStatus(`Removed ${paths.length} media file(s).`)
      }
    } catch (e) {
      setError(e.message)
    }
  }

  async function updateSource(index, patch) {
    const src = sources.find((item) => item.index === index) || {}
    const next = {
      index,
      file: src.file || '',
      transport: src.transport || 'rtsp',
      ...patch
    }
    await fetchJson('/api/mediasrc/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next)
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

  async function copyStreamUrl(src) {
    const text = src?.transport === 'http'
      ? (src.urls?.http_mjpeg || `/stream/http/src${src.index}.mjpg`)
      : (src.urls?.rtsp || `${rtspBase}/src${src.index}`)
    await navigator.clipboard.writeText(text)
    setUploadStatus(`Copied: ${text}`)
  }

  function codecLabel(codec) {
    if (!codec) return '-'
    if (codec === 'unknown') return 'Unknown'
    return STREAMING_CODECS.find((item) => item.value === codec)?.label || String(codec).toUpperCase()
  }

  function mediaPreviewUrl(path) {
    return `/api/media-preview/mjpeg?path=${encodeURIComponent(path)}`
  }

  function closeTour(markSeen = true) {
    setTourOpen(false)
    if (!markSeen) return
    try {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, '1')
    } catch {}
  }

  function toggleTour() {
    if (tourOpen) {
      closeTour(true)
      return
    }
    setTourStep(0)
    setTourOpen(true)
  }

  function openSysInfo() {
    setSysInfoOpen(true)
    loadSysInfo()
  }

  function nextTourStep() {
    if (tourStep >= ONBOARDING_STEPS.length - 1) {
      closeTour(true)
      return
    }
    setTourStep((prev) => prev + 1)
  }

  function previousTourStep() {
    setTourStep((prev) => Math.max(0, prev - 1))
  }

  async function connectDevkitShell() {
    let shellWindow = null
    try {
      if (!devkitShellInfo?.available) {
        throw new Error('webssh is not installed in this Insight environment.')
      }
      setDevkitShellBusy(true)
      shellWindow = window.open('', '_blank')
      const data = await fetchJson('/api/devkit-shell/start', { method: 'POST' })
      setDevkitShellInfo(data)
      if (!data.launch_url) {
        throw new Error('DevKit shell launch URL is unavailable.')
      }
      if (shellWindow) {
        shellWindow.location = data.launch_url
      } else {
        window.open(data.launch_url, '_blank')
      }
    } catch (e) {
      if (shellWindow && !shellWindow.closed) shellWindow.close()
      setError(e.message)
    } finally {
      setDevkitShellBusy(false)
    }
  }

  const activeTourStep = ONBOARDING_STEPS[tourStep]
  const blurForOverview = tourOpen && tourStep === 0
  const focusedTourTab = tourOpen && activeTourStep?.tab ? activeTourStep.tab : null

  const sourcePreviewExt = (currentSource.file || '').split('.').pop()?.toLowerCase()
  const sourcePreviewIsMjpeg = currentSource.codec === 'mjpeg'
  const sourcePreviewIsVideo = !sourcePreviewIsMjpeg && ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(sourcePreviewExt)
  const sourcePreviewIsImage = ['jpg', 'jpeg', 'png'].includes(sourcePreviewExt)

  const previewExt = selectedFile.split('.').pop()?.toLowerCase()
  const selectedIsMjpeg = mediaInfo?.normalized_codec === 'mjpeg' || ['mjpeg', 'mjpg'].includes(previewExt)
  const isVideo = !selectedIsMjpeg && ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(previewExt)
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
            <h1>Neat Insight</h1>
          </div>
          <p className="subhead">Runtime Monitoring and Test Console</p>
        </div>
        <div className="masthead-actions">
          {devkitShellInfo?.configured && (
            <button
              type="button"
              className="devkit-trigger"
              onClick={connectDevkitShell}
              disabled={devkitShellBusy || !devkitShellInfo.available}
              title={
                devkitShellInfo.available
                  ? `Open browser shell for ${devkitShellInfo.devkit_ip}`
                  : 'webssh is not installed in this Insight environment'
              }
            >
              {devkitShellBusy ? 'Opening DevKit...' : devkitShellInfo.button_label}
            </button>
          )}
          <button
            type="button"
            className="sysinfo-trigger"
            onClick={openSysInfo}
            title="System information"
            aria-label="System information"
          >
            <span aria-hidden="true">i</span>
          </button>
          <button
            type="button"
            className="tour-trigger"
            onClick={toggleTour}
            aria-pressed={tourOpen}
          >
            {tourOpen ? 'Hide Tour' : 'Quick Tour'}
          </button>
        </div>
      </header>

      {tourOpen && (
        <section className="onboarding-panel" aria-label="Insight quick tour">
          <div className="onboarding-copy">
            <p className="onboarding-eyebrow">{activeTourStep.eyebrow}</p>
            <h2 className="onboarding-title">{activeTourStep.title}</h2>
            <p className="onboarding-summary">{activeTourStep.summary}</p>
            <p className="onboarding-detail">{activeTourStep.details}</p>
          </div>
          <div className="onboarding-footer">
            <div className="onboarding-progress" aria-hidden="true">
              {ONBOARDING_STEPS.map((step, index) => (
                <span
                  key={step.id}
                  className={index === tourStep ? 'onboarding-dot active' : 'onboarding-dot'}
                />
              ))}
            </div>
            <div className="modal-actions onboarding-actions">
              <button type="button" onClick={() => closeTour(true)}>
                Skip Tour
              </button>
              <button type="button" onClick={previousTourStep} disabled={tourStep === 0}>
                Back
              </button>
              <button type="button" className="btn-tonal" onClick={nextTourStep}>
                {tourStep === ONBOARDING_STEPS.length - 1 ? 'Finish' : 'Next'}
              </button>
            </div>
          </div>
        </section>
      )}

      <div className={blurForOverview ? 'tour-blur-shell' : ''}>
        <div className="toast-stack" aria-live="polite">
          {error && <div className="toast error">{error}</div>}
          {uploadBusy && uploadProgress && !importDialogOpen ? (
            <UploadProgressCard progress={uploadProgress} />
          ) : (
            !importDialogOpen && uploadStatus && <div className="toast status">{uploadStatus}</div>
          )}
        </div>

        <nav
          className={focusedTourTab ? 'tab-toolbar tour-tab-focus' : 'tab-toolbar'}
          role="tablist"
          aria-label="Main sections"
        >
          {TABS.map((t) => {
            const mutedByTour = Boolean(focusedTourTab && t.id !== focusedTourTab)
            const className = [
              'tab-icon-btn',
              tab === t.id ? 'active' : '',
              focusedTourTab === t.id ? 'tour-focused-tab' : '',
              mutedByTour ? 'tour-muted-tab' : ''
            ].filter(Boolean).join(' ')
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                aria-label={t.label}
                aria-disabled={mutedByTour ? 'true' : undefined}
                title={mutedByTour ? `${t.label} is disabled during this tour step` : t.label}
                className={className}
                disabled={mutedByTour}
                onClick={() => selectTab(t.id)}
              >
                <img src={t.icon} alt="" className="tab-icon" />
                <span className="tab-label">{t.label}</span>
              </button>
            )
          })}
        </nav>

        <main className="content">
          <div key={tab} className="tab-stage">
          {tab === 'workspace' && (
            <Suspense fallback={<section className="panel"><p className="workspace-empty">Loading workspace...</p></section>}>
              <WorkspaceView
                onError={setError}
                onStatus={setUploadStatus}
                routePath={routeWorkspacePath}
                onNavigate={(path) => selectTab('workspace', path)}
              />
            </Suspense>
          )}

          {tab === 'media' && (
            <div className="grid two">
              <section className="panel">
              <div className="panel-topbar">
                <div>
                  <h2>Media Sources</h2>
                  <p className="section-note">Browse, preview, and manage local media assets.</p>
                </div>
                <button
                  type="button"
                  className={uploadBusy ? 'upload-icon-btn busy' : 'upload-icon-btn'}
                  title="Import Media"
                  aria-label="Import Media"
                  aria-busy={uploadBusy ? 'true' : 'false'}
                  disabled={uploadBusy}
                  onClick={() => openImportDialog('local')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 3l4.5 4.5-1.4 1.4-2.1-2.1V16h-2V6.8L8.9 8.9 7.5 7.5 12 3zM5 18h14v2H5v-2z" />
                  </svg>
                  <span className="sr-only">Import Media</span>
                </button>
              </div>
              <p className="meta-count">{filteredFiles.length} files</p>

              <div className="media-toolbar">
                <input className="search-input" placeholder="Filter files..." value={mediaFilter} onChange={(e) => setMediaFilter(e.target.value)} />
              </div>

              <div className="media-list">
                {filteredFiles.map((path) => {
                  const checked = selectedMediaPaths.includes(path)
                  const className = [
                    'media-row',
                    path === selectedFile ? 'active' : '',
                    checked ? 'selected' : ''
                  ].filter(Boolean).join(' ')
                  return (
                    <div key={path} className={className}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelectedMediaPath(path)}
                        aria-label={`Select ${path} for deletion`}
                      />
                      <button type="button" className="media-row-preview" onClick={() => setSelectedFile(path)}>
                        <span className="media-name">{path}</span>
                        <span className="media-ext">{path.split('.').pop()?.toUpperCase() || 'FILE'}</span>
                      </button>
                    </div>
                  )
                })}
                {filteredFiles.length === 0 && <p className="empty">No files match the filter.</p>}
              </div>
            </section>

            <section className="panel">
              <h2>Selected Media</h2>
              {selectedFile && <p className="section-note">{selectedFile}</p>}

              <div className="preview">
                {selectedFile && selectedIsMjpeg && <img src={mediaPreviewUrl(selectedFile)} alt={selectedFile} />}
                {selectedFile && isVideo && <video controls src={`/media/${selectedFile}`} />}
                {selectedFile && isImage && <img src={`/media/${selectedFile}`} alt={selectedFile} />}
                {!selectedFile && <p>Select a file.</p>}
              </div>

              <div className="actions">
                {selectedMediaPaths.length > 0 && (
                  <button type="button" className="btn-ghost" onClick={clearSelectedMediaPaths}>
                    Clear {selectedMediaPaths.length}
                  </button>
                )}
                <button className="delete-icon-btn" onClick={() => setDeleteConfirmOpen(true)} disabled={!deleteTargetPaths.length} aria-label="Delete Selected" title="Delete Selected">
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
                  <h2>Streaming Sources</h2>
                  <p className="section-note">Assign media, choose an available transport, and control source playback.</p>
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
              <p className="hint">Default RTSP base: <code>{rtspBase}</code></p>

              <div className="sources">
                {sources.map((src) => (
                  <div key={src.index} className={src.index === selectedSource ? 'source-row active' : 'source-row'} onClick={() => setSelectedSource(src.index)}>
                    {(() => {
                      const isAssigned = Boolean(src.file)
                      const allowedTransports = Array.isArray(src.allowed_transports) ? src.allowed_transports : (isAssigned ? ['rtsp'] : [])
                      const transportLocked = !isAssigned || allowedTransports.length <= 1
                      const transportValue = isAssigned && allowedTransports.includes(src.transport) ? src.transport : ''
                      const canStream = isAssigned && allowedTransports.length > 0
                      return (
                        <>
                          <span className="src-label">src{src.index}</span>
                          <span className={src.state === 'playing' ? 'src-state playing' : 'src-state stopped'}>
                            {src.state === 'playing' ? 'Live' : 'Idle'}
                          </span>
                          <select value={src.file || ''} onChange={(e) => updateSource(src.index, { file: e.target.value })}>
                            <option value="">Not assigned</option>
                            {videoFiles.map((file) => (
                              <option key={file} value={file}>{file}</option>
                            ))}
                          </select>
                          <select
                            value={transportValue}
                            onChange={(e) => updateSource(src.index, { transport: e.target.value })}
                            disabled={transportLocked}
                            aria-label={`Transport for src${src.index}`}
                            title={!isAssigned ? 'Assign media before choosing a transport' : (!canStream ? 'Codec could not be detected for this media' : (transportLocked ? 'Transport is determined by the selected media format' : `Transport for src${src.index}`))}
                          >
                            {(!isAssigned || !canStream) && <option value="">-</option>}
                            {STREAMING_TRANSPORTS.filter((transport) => allowedTransports.includes(transport.value)).map((transport) => (
                              <option key={transport.value} value={transport.value}>{transport.label}</option>
                            ))}
                          </select>
                          <span className={isAssigned && canStream ? 'codec-lock' : 'codec-lock empty'} title={isAssigned ? (canStream ? 'Codec is determined by the selected media format' : 'Codec could not be detected for this media') : 'Assign media before selecting a codec'}>
                            {isAssigned ? codecLabel(src.codec) : '-'}
                          </span>
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
                              disabled={!canStream}
                              aria-label={`Start src${src.index}`}
                              title={canStream ? `Start src${src.index}` : 'Codec must be detected before streaming'}
                            >
                              <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M8 6v12l10-6-10-6z" />
                              </svg>
                            </button>
                          )}
                          <button
                            className="icon-action-btn copy"
                            onClick={(e) => { e.stopPropagation(); copyStreamUrl(src) }}
                            disabled={!canStream}
                            aria-label={`Copy stream URL for src${src.index}`}
                            title={canStream ? `Copy stream URL for src${src.index}` : 'No stream URL is available until codec is detected'}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M9 9h10v12H9z" />
                              <path d="M5 3h10v2H7v10H5z" />
                            </svg>
                          </button>
                        </>
                      )
                    })()}
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <h2>Source Preview: src{currentSource.index}</h2>
              <p className="hint">File: {currentSource.file || 'Not assigned'}</p>
              <p className="hint">Output: {currentSource.transport ? currentSource.transport.toUpperCase() : '-'} / {codecLabel(currentSource.codec)}</p>

              <div className="preview">
                {currentSource.file && sourcePreviewIsMjpeg && <img src={mediaPreviewUrl(currentSource.file)} alt={currentSource.file} />}
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
      </div>

      {importDialogOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Import media"
          onDragOverCapture={onImportDragOver}
          onDropCapture={onImportDrop}
          onDragLeaveCapture={(e) => {
            if (e.currentTarget.contains(e.relatedTarget)) return
            setLocalDropActive(false)
          }}
        >
          <div className={localDropActive && importTab === 'local' ? 'import-modal-card drag-active' : 'import-modal-card'}>
            <header className="import-modal-header">
              <div>
                <p className="sysinfo-eyebrow">Media Import</p>
                <h3>Import Media</h3>
                <p>Upload local files or import a curated asset from the catalog.</p>
              </div>
              <button type="button" onClick={() => setImportDialogOpen(false)} disabled={uploadBusy}>
                Close
              </button>
            </header>

            <div className="import-tabs" role="tablist" aria-label="Import source">
              <button
                type="button"
                role="tab"
                aria-selected={importTab === 'local'}
                className={importTab === 'local' ? 'active' : ''}
                onClick={() => setImportTab('local')}
              >
                Local files
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={importTab === 'catalog'}
                className={importTab === 'catalog' ? 'active' : ''}
                onClick={() => {
                  setImportTab('catalog')
                  if (!catalog && !catalogLoading) loadCatalog()
                }}
              >
                Catalog
              </button>
            </div>

            {uploadStatus && !uploadBusy && <div className="import-status">{uploadStatus}</div>}

            {importTab === 'local' && (
              <section className="import-local-panel">
                <p className="section-note">
                  Local MP4 uploads are normalized for low-latency playback with B-frames disabled while preserving the source frame rate.
                </p>
                <label
                  className={[
                    'file-import-drop',
                    uploadBusy ? 'busy' : '',
                    localDropActive ? 'drag-active' : ''
                  ].filter(Boolean).join(' ')}
                  onDragEnter={onLocalDropDragOver}
                  onDragOver={onLocalDropDragOver}
                  onDragLeave={onLocalDropDragLeave}
                  onDrop={onLocalDrop}
                >
                  <input type="file" multiple onChange={onUpload} disabled={uploadBusy} />
                  <span>Choose or drop local media files</span>
                  <small>Supported media: MP4 or AVI with H.264, H.265, or MJPEG video.</small>
                </label>
                {uploadBusy && uploadProgress && <UploadProgressCard progress={uploadProgress} className="import-progress-card" />}
              </section>
            )}

            {importTab === 'catalog' && (
              <section className="catalog-import-panel">
                <div className="catalog-toolbar">
                  <input
                    className="search-input"
                    placeholder="Search catalog..."
                    value={catalogFilter}
                    onChange={(e) => setCatalogFilter(e.target.value)}
                  />
                  <button type="button" className="btn-ghost" onClick={loadCatalog} disabled={catalogLoading}>
                    {catalogLoading ? 'Loading...' : 'Refresh'}
                  </button>
                </div>

                {catalogError && <div className="sysinfo-error">{catalogError}</div>}
                {catalogLoading && !catalog && <div className="sysinfo-loading">Loading catalog...</div>}

                {catalog && (
                  <>
                    <div className="catalog-mode-tabs" role="tablist" aria-label="Catalog browsing mode">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={catalogMode === 'type'}
                        className={catalogMode === 'type' ? 'active' : ''}
                        onClick={() => setCatalogMode('type')}
                      >
                        Catalog by asset type
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={catalogMode === 'name'}
                        className={catalogMode === 'name' ? 'active' : ''}
                        onClick={() => setCatalogMode('name')}
                      >
                        Catalog by asset name
                      </button>
                    </div>

                    {catalogMode === 'name' && (
                      <div className="catalog-grid">
                        <div className="catalog-source-list">
                          {filteredCatalogSources.map((source) => {
                            const count = (catalogAssetsBySource.get(source.id) || []).filter((asset) => !asset.preview).length
                            return (
                              <button
                                key={source.id}
                                type="button"
                                className={selectedCatalogSource?.id === source.id ? 'catalog-source-row active' : 'catalog-source-row'}
                                onClick={() => {
                              setCatalogSourceId(source.id)
                              setCatalogProfile('')
                              setCatalogCodec('')
                              setCatalogAssetPath('')
                                }}
                              >
                                <span>{source.title || source.id}</span>
                                <small>{count} variants</small>
                              </button>
                            )
                          })}
                          {filteredCatalogSources.length === 0 && <p className="empty">No catalog sources match the filter.</p>}
                        </div>

                        <div className="catalog-detail">
                          {selectedCatalogSource ? (
                            <>
                              <div className="catalog-preview-tile">
                                {selectedCatalogPreview?.url ? (
                                  <video controls muted loop src={selectedCatalogPreview.url} />
                                ) : (
                                  <div className="catalog-preview-empty">No preview available</div>
                                )}
                                <div>
                                  <h4>{selectedCatalogSource.title || selectedCatalogSource.id}</h4>
                                  <p>{selectedCatalogSource.description || 'Curated Insight media asset.'}</p>
                                  {selectedCatalogPreview && <small>Preview: {catalogAssetLabel(selectedCatalogPreview)}</small>}
                                </div>
                              </div>

                          <div className="catalog-filters">
                            <label>
                              <span>Resolution &amp; FPS</span>
                              <select value={catalogProfile} onChange={(e) => setCatalogProfile(e.target.value)}>
                                <option value="">Any</option>
                                {catalogProfiles.filter((profile) => profile !== 'preview_320p30').map((profile) => (
                                  <option key={profile} value={profile}>{profile}</option>
                                ))}
                              </select>
                            </label>
                            <label>
                              <span>Codec</span>
                              <select value={catalogCodec} onChange={(e) => setCatalogCodec(e.target.value)}>
                                    <option value="">Any</option>
                                    {catalogCodecOptions.map((codec) => (
                                      <option key={codec} value={codec}>{prettyCodec(codec)}</option>
                                    ))}
                                  </select>
                                </label>
                              </div>

                              <div className="catalog-variant-list" role="radiogroup" aria-label="Catalog variants">
                                {matchingCatalogAssets.map((asset) => (
                                  <button
                                    key={asset.path}
                                    type="button"
                                    className={selectedCatalogAsset?.path === asset.path ? 'catalog-variant-row active' : 'catalog-variant-row'}
                                    onClick={() => setCatalogAssetPath(asset.path)}
                                  >
                                    <span>{catalogAssetLabel(asset)}</span>
                                    <small>{formatBytes(Number(asset.bytes || 0))}</small>
                                  </button>
                                ))}
                                {matchingCatalogAssets.length === 0 && <p className="empty">No variants match the selected filters.</p>}
                              </div>

                              {uploadBusy && uploadProgress && <UploadProgressCard progress={uploadProgress} className="import-progress-card" />}

                              <div className="catalog-import-footer">
                                <div>
                                  <strong>{selectedCatalogAsset ? catalogAssetLabel(selectedCatalogAsset) : 'No variant selected'}</strong>
                                  {selectedCatalogAsset && (
                                    <>
                                      <p>{selectedCatalogAsset.path}</p>
                                      <p>Total selected: {formatBytes(selectedCatalogAssetBytes)}</p>
                                    </>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  className="btn-tonal"
                                  onClick={importCatalogAsset}
                                  disabled={!selectedCatalogAsset || uploadBusy}
                                >
                                  {uploadBusy ? 'Importing...' : 'Import'}
                                </button>
                              </div>
                            </>
                          ) : (
                            <p className="empty">Select a catalog source.</p>
                          )}
                        </div>
                      </div>
                    )}

                    {catalogMode === 'type' && (
                      <div className="catalog-type-panel">
                        <div className="catalog-filters">
                          <label>
                            <span>Resolution &amp; FPS</span>
                            <select value={catalogProfile} onChange={(e) => setCatalogProfile(e.target.value)}>
                              <option value="">Any</option>
                              {catalogProfiles.filter((profile) => profile !== 'preview_320p30').map((profile) => (
                                <option key={profile} value={profile}>{profile}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>Codec</span>
                            <select value={catalogCodec} onChange={(e) => setCatalogCodec(e.target.value)}>
                              <option value="">Any</option>
                              {catalogCodecOptions.map((codec) => (
                                <option key={codec} value={codec}>{prettyCodec(codec)}</option>
                              ))}
                            </select>
                          </label>
                        </div>

                        <div className="catalog-bulk-actions">
                          <span>{typeMatchingCatalogAssets.length} matching assets / {selectedTypeCatalogAssets.length} selected</span>
                          <div>
                            <button type="button" className="btn-ghost" onClick={selectAllMatchingCatalogAssets} disabled={!typeMatchingCatalogAssets.length}>
                              Select All
                            </button>
                            <button type="button" className="btn-ghost" onClick={() => setCatalogSelectedAssetPaths([])} disabled={!catalogSelectedAssetPaths.length}>
                              Clear
                            </button>
                          </div>
                        </div>

                        <div className="catalog-type-list">
                          {typeMatchingCatalogAssets.map((asset) => {
                            const source = catalogSourcesById.get(asset.source_id) || {}
                            const selected = catalogSelectedAssetPaths.includes(asset.path)
                            return (
                              <label key={asset.path} className={selected ? 'catalog-type-row active' : 'catalog-type-row'}>
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => toggleCatalogAssetSelection(asset.path)}
                                />
                                <span>
                                  <strong>{source.title || asset.source_title || asset.source_id}</strong>
                                  <small>{catalogAssetLabel(asset)} / {formatBytes(Number(asset.bytes || 0))}</small>
                                </span>
                              </label>
                            )
                          })}
                          {typeMatchingCatalogAssets.length === 0 && <p className="empty">No catalog assets match the selected type filters.</p>}
                        </div>

                        {uploadBusy && uploadProgress && <UploadProgressCard progress={uploadProgress} className="import-progress-card" />}

                        <div className="catalog-import-footer">
                          <div>
                            <strong>{selectedTypeCatalogAssets.length} asset(s) selected</strong>
                            <p>{catalogProfile || 'Any resolution & fps'} / {catalogCodec ? prettyCodec(catalogCodec) : 'Any codec'}</p>
                            <p>Total selected: {formatBytes(selectedTypeCatalogBytes)}</p>
                          </div>
                          <button
                            type="button"
                            className="btn-tonal"
                            onClick={() => importCatalogAssets(selectedTypeCatalogAssets)}
                            disabled={!selectedTypeCatalogAssets.length || uploadBusy}
                          >
                            {uploadBusy ? 'Importing...' : 'Import Selected'}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
          </div>
        </div>
      )}

      {deleteConfirmOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm deletion">
          <div className="modal-card delete-confirm-card">
            <h3>{deleteTargetPaths.length > 1 ? 'Delete Files' : 'Delete File'}</h3>
            <p className="delete-confirm-message">
              <span>Delete {deleteTargetPaths.length > 1 ? `${deleteTargetPaths.length} media files` : 'this media file'}</span>
              {deleteTargetPaths.length === 1 ? (
                <code>{deleteTargetPaths[0]}</code>
              ) : (
                <span className="delete-file-list">
                  {deleteTargetPaths.map((path) => <code key={path}>{path}</code>)}
                </span>
              )}
              <span>?</span>
            </p>
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

      {sysInfoOpen && (
        <SysInfoModal
          data={sysInfo}
          loading={sysInfoLoading}
          error={sysInfoError}
          onRefresh={loadSysInfo}
          onClose={() => setSysInfoOpen(false)}
        />
      )}

    </div>
  )
}
