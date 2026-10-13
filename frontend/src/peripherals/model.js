// Every camera mode is Available (the board's camera overlays support the sensor, the ISP outputs the size,
// and the format is NV12) or Unsupported. A camera or format is Available when any of its modes is.
const TIERS = {
  available: { label: 'Available', tone: 'ok' },
  unsupported: { label: 'Unsupported', tone: 'periph-danger' }
}

const CONNECTIONS = [
  { id: 'mipi', label: 'MIPI' },
  { id: 'usb', label: 'USB' }
]

const SOURCES = { 'on-board': 'On this board', 'sdk-env': 'SDK DevKit', manual: 'Manual' }

// Device kinds Insight knows a name and an icon for. Only "camera" has a view;
// the rest are listed so the shape of the page does not change when the backend
// starts reporting them (contract: build nothing for other kinds yet). A kind
// the backend invents gets the generic "device" icon.
const DEVICE_KINDS = [
  { id: 'camera', label: 'Cameras', icon: 'camera' },
  { id: 'microphone', label: 'Microphones', icon: 'microphone' },
  { id: 'lidar', label: 'LiDAR', icon: 'lidar' }
]

const SUPPORTED_KINDS = new Set(['camera'])

const SEVERITY = {
  error: { label: 'Error', tone: 'periph-danger', rank: 0 },
  warning: { label: 'Warning', tone: 'warn', rank: 1 },
  info: { label: 'Info', tone: 'periph-info', rank: 2 }
}

export const CONNECTION_ERROR_CODES = new Set(['unreachable', 'auth_failed', 'host_key_changed'])

function tierOf(tier) {
  return tier === 'available' ? 'available' : 'unsupported'
}

export function tierInfo(tier) {
  return TIERS[tierOf(tier)]
}

// Every camera the latest scan detected is connected. One kept from a failed provider's last good scan
// (`modes_source: previous-scan`) may have been unplugged since, so it says where it comes from instead.
export const CONNECTED_PILL = { label: 'Connected', tone: '' }
export const LAST_SCAN_PILL = { label: 'Last scan', tone: '' }

export function connectionPill(device) {
  return device?.modes_source === 'previous-scan' ? LAST_SCAN_PILL : CONNECTED_PILL
}

export function cameraTierPill(camera) {
  return tierOf(camera?.support?.tier) === 'available' ? TIERS.available : TIERS.unsupported
}

export function severityInfo(severity) {
  return SEVERITY[severity] || SEVERITY.info
}

export function sourceLabel(source) {
  return SOURCES[source] || ''
}

export function connectionStateInfo(status) {
  if (status?.state === 'connected') return { label: 'Connected', short: 'Connected', tone: 'ok' }
  if (status?.state === 'error') return { label: 'Connection failed', short: 'Error', tone: 'periph-danger' }
  return { label: 'Not checked', short: 'Not checked', tone: '' }
}

export function boardIndicator(board) {
  if (!board) return { label: 'Board', state: { label: 'Loading…', short: 'Loading…', tone: '' }, title: 'Loading the selected board' }
  const target = board.target
  if (!target) {
    return {
      label: 'No board',
      state: { label: 'Not selected', short: 'Not selected', tone: 'warn' },
      title: 'No board is selected. Open board settings to choose one.'
    }
  }
  const state = connectionStateInfo(board.status)
  // One control names the board and its state. "sima@host" is the connection string, which belongs
  // in the panel; the masthead says which machine, in the words the rest of the SDK uses for it.
  const label = target.mode === 'local'
    ? 'This board'
    : `${target.source === 'sdk-env' ? 'DevKit' : 'Board'}: ${target.host}`
  return { label, state, title: `${target.label} — ${state.label}. Open board settings.` }
}

export function defaultTargetText(defaults) {
  if (defaults?.on_board) return 'this board (Insight is running on it)'
  const env = defaults?.sdk_env
  if (env?.host) return `${env.user || 'sima'}@${env.host}:${env.port || 22} (paired SDK DevKit)`
  return ''
}

export function groupCameras(items) {
  const cameras = (items || []).filter((item) => item?.kind === 'camera')
  return CONNECTIONS
    .map((c) => ({ ...c, items: cameras.filter((item) => item.connection === c.id) }))
    .filter((group) => group.items.length)
}

function kindLabel(kind) {
  const text = String(kind || '').replace(/[_-]+/g, ' ').trim()
  if (!text) return 'Other'
  return text.charAt(0).toUpperCase() + text.slice(1) + (text.endsWith('s') ? '' : 's')
}

function kindCountBadge(count) {
  if (!count) return ''
  return count > 99 ? '99+' : String(count)
}

// One entry per device kind for the icon rail. A kind is selectable only when
// Insight has a view for it AND the last scan found at least one; everything
// else is greyed, and `note` says why (it becomes the tooltip and the
// accessible description, so a greyed icon never leaves the user guessing).
// `scanned: false` means there is no scan yet, so no count is claimed.
export function deviceTabs(items, { scanned = true } = {}) {
  const counts = new Map()
  for (const item of items || []) {
    if (!item?.kind) continue
    counts.set(item.kind, (counts.get(item.kind) || 0) + 1)
  }
  const known = DEVICE_KINDS.map((kind) => ({ ...kind, count: counts.get(kind.id) || 0 }))
  const extra = [...counts.keys()]
    .filter((kind) => !DEVICE_KINDS.some((known_) => known_.id === kind))
    .sort()
    .map((kind) => ({ id: kind, label: kindLabel(kind), icon: 'device', count: counts.get(kind) }))
  return [...known, ...extra].map((kind) => {
    const supported = SUPPORTED_KINDS.has(kind.id)
    const noun = kind.label.toLowerCase()
    let note = ''
    if (!supported) {
      note = kind.count
        ? `${countLabel(kind.count, 'device')} detected; Insight cannot show ${noun} yet.`
        : 'Not supported yet'
    } else if (!scanned) {
      note = 'Not scanned yet'
    } else if (!kind.count) {
      note = `No ${noun} detected`
    }
    const name = scanned || kind.count ? `${kind.label}, ${countLabel(kind.count, 'device')}` : kind.label
    return {
      id: kind.id,
      label: kind.label,
      icon: kind.icon,
      count: kind.count,
      supported,
      disabled: Boolean(note),
      note,
      badge: kindCountBadge(kind.count),
      name,
      tooltip: note ? `${kind.label} — ${note}` : name
    }
  })
}

export function resolveDeviceKind(tabs, wanted) {
  const list = tabs || []
  const usable = list.filter((tab) => !tab.disabled)
  if (wanted && usable.some((tab) => tab.id === wanted)) return wanted
  // With nothing selectable (no scan yet, or no camera attached) the panel still
  // shows the first kind Insight has a view for: that view explains what to do next.
  return usable[0]?.id || list.find((tab) => tab.supported)?.id || null
}

export function cameraDeviceId(camera) {
  const device = camera?.device || {}
  return device.camera_name || device.by_id || device.video_node || ''
}

export function cameraSubtitle(camera) {
  // A USB camera's kernel path is not shown under its name.
  const deviceId = camera?.connection === 'usb' ? '' : cameraDeviceId(camera)
  // The name already carries the model for a MIPI camera ("imx477 5-001a"), so repeating it says nothing.
  const model = camera?.model && !(camera?.name || '').includes(camera.model) ? camera.model : null
  return [model, deviceId !== camera?.name && deviceId].filter(Boolean).join(' · ')
}

function rank(tier) {
  return tierOf(tier) === 'available' ? 0 : 1
}

function best(list, tierOf) {
  return (list || []).reduce((top, item) => (top === null || rank(tierOf(item)) < rank(tierOf(top)) ? item : top), null)
}

function usableSizes(format) {
  return (format?.sizes || []).filter((size) => size.fps?.length)
}

// Unsupported modes stay in the menus, labelled; only a format without a size and rate cannot be chosen.
function isSelectable(format) {
  return usableSizes(format).length > 0
}

function sizeTier(size) {
  return best(size.fps, (f) => f.tier)?.tier
}

function findFormat(camera, format) {
  return (camera?.formats || []).find((f) => f.format === format) || null
}

function findSize(format, width, height) {
  return usableSizes(format).find((s) => s.width === Number(width) && s.height === Number(height)) || null
}

function findFps(size, value) {
  if (value === undefined || value === null || value === '') return null
  return size?.fps?.find((f) => Number(f.value) === Number(value)) || null
}

export function sizeKey(width, height) {
  return `${width}x${height}`
}

export function sizeLabel(width, height) {
  return `${width}×${height}`
}

export function fpsLabel(value) {
  const n = Number(value)
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))
}

// A rate the camera runs at, for display: a whole number when within 1% of one (66.18 reads "66 fps"),
// else fpsLabel. Empty when the rate is unknown.
export function rateLabel(value) {
  const n = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n) || n <= 0) return ''
  const whole = Math.round(n)
  return `${whole > 0 && Math.abs(n - whole) <= n * 0.01 ? whole : fpsLabel(n)} fps`
}

// Format and size only, for every camera: a MIPI mode's rate is not known until the camera runs in it, so no
// camera's rate is named before it runs.
export function modeLabel(selection) {
  if (!selection) return ''
  return `${selection.format} ${sizeLabel(selection.width, selection.height)}`
}

export function formatRangeLabel(range) {
  if (!range) return ''
  const width = `${range.min_width}–${range.max_width}`
  const height = `${range.min_height}–${range.max_height}`
  const step = range.step_width || range.step_height
    ? ` in ${range.step_width || 1}×${range.step_height || 1} steps`
    : ''
  return `${width}×${height}${step}`
}

export function formatOptions(camera) {
  return (camera?.formats || []).map((f) => {
    const selectable = isSelectable(f)
    const range = formatRangeLabel(f.range)
    return {
      value: f.format,
      label: f.label || f.format,
      tier: selectable ? tierOf(f.support?.tier) : 'unsupported',
      disabled: !selectable,
      reason: selectable ? '' : `no sizes with a frame rate were reported for it.${range ? ` Reported range: ${range}.` : ''}`,
      range: f.range || null
    }
  })
}

// Resolutions name the size only, for every camera (see modeLabel).
export function sizeOptions(camera, format) {
  return usableSizes(findFormat(camera, format)).map((s) => ({
    value: sizeKey(s.width, s.height),
    width: s.width,
    height: s.height,
    label: sizeLabel(s.width, s.height),
    tier: sizeTier(s)
  }))
}

// A menu's entries carry no tier suffix, which truncated in a narrow select. The tier is a
// pill beside the menu for the chosen entry, and the entries are grouped under their tier.
const TIER_GROUPS = [
  { id: 'available', label: 'Available' },
  { id: 'unsupported', label: 'Unsupported' }
]

export function optionTier(options, value) {
  const option = (options || []).find((o) => o.value === String(value))
  return option ? tierInfo(option.tier) : null
}

export function groupOptions(options) {
  return TIER_GROUPS
    .map((group) => ({ ...group, options: (options || []).filter((o) => tierOf(o.tier) === group.id) }))
    .filter((group) => group.options.length)
}

// One visible explanation line per camera state, chosen by priority, so the
// detail pane never stacks four near-identical sentences.
export function cameraSummaryLine(camera) {
  // A USB camera is always Unsupported (no camera overlay), so a sentence saying so adds nothing.
  if (camera?.connection === 'usb') return ''
  // An Unsupported camera's panel carries no pill, so it says why the camera cannot be used.
  if (camera?.support && tierOf(camera.support.tier) !== 'available') return camera.support.reason || 'Unsupported.'
  // An Available camera gets no sentence at all: every mode menu already labels each entry
  // Available or Unsupported, so a paragraph repeating that only adds text. Whether another
  // program holds the camera is found out, and said, when a preview tries to start.
  return ''
}

export function blockedFormatSummary(options) {
  const blocked = (options || []).filter((option) => option.disabled)
  if (!blocked.length) return ''
  return `${countLabel(blocked.length, 'format')} cannot be used (${blocked.map((option) => option.value).join(', ')})`
}

export function resolveSelection(camera, wanted) {
  const formats = (camera?.formats || []).filter(isSelectable)
  if (!formats.length) return null
  const def = camera.default_selection
  const format = formats.find((f) => f.format === wanted?.format)
    || formats.find((f) => f.format === def?.format)
    || best(formats, (f) => f.support?.tier)
  const defHere = def?.format === format.format ? def : null
  const size = findSize(format, wanted?.width, wanted?.height)
    || (defHere && findSize(format, defHere.width, defHere.height))
    || best(usableSizes(format), sizeTier)
  const defSize = defHere && defHere.width === size.width && defHere.height === size.height
  const fps = findFps(size, wanted?.fps) || (defSize && findFps(size, defHere.fps)) || best(size.fps, (f) => f.tier)
  return { format: format.format, width: size.width, height: size.height, fps: fps.value }
}

export function sameSelection(a, b) {
  if (!a || !b) return a === b
  return a.format === b.format && a.width === b.width && a.height === b.height && Number(a.fps) === Number(b.fps)
}

export function resolveCameraId(snapshot, previousId) {
  const cameras = groupCameras(snapshot?.items).flatMap((group) => group.items)
  if (previousId && cameras.some((c) => c.id === previousId)) return previousId
  if (previousId && snapshot?.changes?.removed?.some((r) => r.id === previousId)) return previousId
  return cameras[0]?.id || null
}

export function isSnapshotStale(board, snapshot) {
  if (!board || !snapshot?.scanned_at) return false
  return Number(board.generation) !== Number(snapshot.generation)
}

// The camera setup Sentinel read from the board's device tree (`camera_setup` in a snapshot), for the
// board it scanned: null before a scan, after the selected board changed, or from an older Sentinel.
export function boardCameraSetup(board, snapshot) {
  if (!board || !snapshot?.scanned_at || Number(board.generation) !== Number(snapshot.generation)) return null
  return snapshot.camera_setup || null
}

// "modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo" reads as "modalix-som-waveshare-ARDU-IMX477-1CAM".
export function overlayName(file) {
  return String(file || '').split('/').pop().replace(/\.dtbo$/i, '')
}

// Board fact rows for the camera setup; each row is omitted when Sentinel did not report it.
export function cameraSetupRows(setup) {
  const rows = []
  if (setup?.model) rows.push(['Model', String(setup.model)])
  const overlays = (setup?.overlays || []).map(overlayName).filter(Boolean)
  if (overlays.length) rows.push(['Camera setup', overlays.join(', ')])
  return rows
}

export function changeSummary(changes) {
  const names = (list) => (list || []).map((item) => item.name || item.id).join(', ')
  const lines = []
  if (changes?.removed?.length) lines.push(`Disconnected since last refresh: ${names(changes.removed)}`)
  if (changes?.added?.length) lines.push(`New: ${names(changes.added)}`)
  return lines
}

export function sortIssues(issues) {
  return [...(issues || [])].sort((a, b) => severityInfo(a.severity).rank - severityInfo(b.severity).rank)
}

export function formatRelativeTime(iso, now = Date.now()) {
  const time = Date.parse(iso || '')
  if (!Number.isFinite(time)) return ''
  const seconds = Math.round((now - time) / 1000)
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  return `${Math.floor(seconds / 86400)} d ago`
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return ''
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

export function countLabel(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function safeHref(url) {
  return /^https?:\/\//i.test(String(url || '')) ? url : null
}

export function apiError(body, status) {
  const data = body && typeof body === 'object' ? body : {}
  const err = new Error(data.error || data.message || `Request failed${status ? `: ${status}` : ''}`)
  err.code = data.code || ''
  err.hint = data.hint || ''
  err.status = status || 0
  err.details = data
  return err
}

export function normalizeError(err) {
  if (!err) return null
  if (typeof err === 'string') return { message: err, code: '', hint: '', details: {} }
  if (err instanceof Error) return { message: err.message, code: err.code || '', hint: err.hint || '', details: err.details || {} }
  return { message: err.error || err.message || 'Unknown error', code: err.code || '', hint: err.hint || '', details: err }
}

export function initialBoardForm(board) {
  const t = board?.target?.mode === 'ssh' ? board.target : null
  const src = board?.saved || t || board?.defaults?.sdk_env || {}
  return { host: src.host || '', port: String(src.port || 22), user: src.user || 'sima' }
}

export function validateBoardForm(values) {
  const host = String(values.host || '').trim()
  const user = String(values.user || '').trim()
  const port = Number(values.port)
  if (!host) return { error: 'Enter the board host name or IP address.' }
  if (/\s/.test(host)) return { error: 'The host cannot contain spaces.' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'The SSH port must be a whole number from 1 to 65535.' }
  if (!user) return { error: 'Enter the SSH user, usually "sima".' }
  return { body: { host, port, user } }
}

// The board state has several writers: reads (on load, Retry, after a scan) and the POSTs that
// change the board and answer with the new state. Their answers can arrive out of order, so a
// read only applies while nothing newer has been sent or applied; a superseded read resolves to
// whatever state won instead of its own out-of-date answer.
export function createBoardSync({ fetchBoard, onBoard, onError, onLoading }) {
  let latest = 0
  let newest = Promise.resolve(null)

  function load() {
    const seq = ++latest
    onLoading(true)
    let request
    try {
      request = Promise.resolve(fetchBoard())
    } catch (err) {
      request = Promise.reject(err)
    }
    const promise = request.then(
      (data) => {
        if (seq !== latest) return newest
        onBoard(data)
        onLoading(false)
        return data
      },
      (err) => {
        if (seq !== latest) return newest
        onError(err)
        onLoading(false)
        return null
      }
    )
    newest = promise
    return promise
  }

  function apply(data) {
    latest += 1
    newest = Promise.resolve(data)
    onBoard(data)
    onLoading(false)
    return data
  }

  return { load, apply }
}

// When a disclosure collapses, the control that had focus is removed, and focus would fall to the
// page body. request() is called when it collapses; flush() runs after the next render, so the
// candidates (usually refs) are read once the opener is back on the page. The first candidate
// still rendered and enabled gets focus. flush() does nothing without a pending request: it runs
// after every render, including each keystroke in a form.
export function createFocusReturn() {
  let pending = null
  return {
    request(candidates) {
      pending = candidates
    },
    flush() {
      if (!pending) return null
      const candidates = pending
      pending = null
      const target = candidates().find((el) => el && el.isConnected !== false && !el.disabled) || null
      target?.focus()
      return target
    }
  }
}

// The browser shell's details for the selected board. A board change reloads them, and a read sent for an
// earlier board can answer last; only the newest read is applied. A failed read hides the shell.
export function createShellInfoSync({ fetchShell, onShell }) {
  return createBoardSync({
    fetchBoard: fetchShell,
    onBoard: onShell,
    onError: () => onShell(null),
    onLoading: () => {}
  })
}
