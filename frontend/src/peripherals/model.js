const TIER_RANK = { verified: 0, advertised: 1, unsupported: 2 }

const TIERS = {
  verified: { label: 'Verified with Core', short: 'verified', tone: 'ok' },
  advertised: { label: 'Advertised, unverified', short: 'advertised', tone: 'warn' },
  unsupported: { label: 'Not supported by Core CameraInput', short: 'unsupported', tone: 'periph-danger' }
}

const CONNECTIONS = [
  { id: 'mipi', label: 'MIPI (libcamera)' },
  { id: 'usb', label: 'USB (V4L2)' }
]

const SOURCES = { 'on-board': 'On this board', 'sdk-env': 'SDK DevKit', manual: 'Manual' }

// Device kinds Insight knows a name for. Only "camera" has a view; the rest are
// listed so the shape of the page does not change when the backend starts
// reporting them (contract: build nothing for other kinds yet).
const DEVICE_KINDS = [
  { id: 'camera', label: 'Cameras' },
  { id: 'microphone', label: 'Microphones' },
  { id: 'lidar', label: 'LiDAR' }
]

const SUPPORTED_KINDS = new Set(['camera'])

const SEVERITY = {
  error: { label: 'Error', tone: 'periph-danger', rank: 0 },
  warning: { label: 'Warning', tone: 'warn', rank: 1 },
  info: { label: 'Info', tone: 'periph-info', rank: 2 }
}

const DEVICE_FIELDS = [
  ['camera_name', 'Camera name'],
  ['camera_name_source', 'Name source'],
  ['media_device', 'Media device'],
  ['bus_info', 'Bus info'],
  ['csi', 'CSI receiver'],
  ['video_node', 'Video node'],
  ['by_id', 'Stable path']
]

const USB_FIELDS = [
  ['manufacturer', 'Manufacturer'],
  ['product', 'Product'],
  ['serial', 'Serial'],
  ['bus_path', 'USB bus path']
]

export const CONNECTION_ERROR_CODES = new Set(['unreachable', 'auth_failed', 'host_key_changed'])

export function tierInfo(tier) {
  return TIERS[tier] || { label: 'Support unknown', short: 'unknown', tone: '' }
}

export function severityInfo(severity) {
  return SEVERITY[severity] || SEVERITY.info
}

export function sourceLabel(source) {
  return SOURCES[source] || ''
}

export function connectionLabel(connection) {
  return CONNECTIONS.find((c) => c.id === connection)?.label || String(connection || 'Unknown')
}

export function connectionStateInfo(status) {
  if (status?.state === 'connected') return { label: 'Connected', short: 'Connected', tone: 'ok' }
  if (status?.state === 'error') return { label: 'Connection failed', short: 'Error', tone: 'periph-danger' }
  return { label: 'Not checked', short: 'Not checked', tone: '' }
}

export function boardIndicator(board) {
  if (!board) return { label: 'Board', state: { label: 'Loading…', short: 'Loading…', tone: '' }, title: 'Loading the selected board' }
  const target = board.target || null
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

export function availabilityInfo(availability) {
  const reason = availability?.reason || ''
  if (availability?.state === 'available') return { label: 'Available', tone: 'ok', reason }
  if (availability?.state === 'in_use') {
    const users = (availability.users || []).map((u) => `${u.command || 'unknown process'} (pid ${u.pid})`)
    return { label: users.length ? `In use by ${users.join(', ')}` : 'In use', tone: 'warn', reason }
  }
  return { label: 'Availability unknown', tone: '', reason }
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

export function deviceTabs(items) {
  const counts = new Map()
  for (const item of items || []) {
    if (!item?.kind) continue
    counts.set(item.kind, (counts.get(item.kind) || 0) + 1)
  }
  const known = DEVICE_KINDS.map((kind) => ({ ...kind, count: counts.get(kind.id) || 0 }))
  const extra = [...counts.keys()]
    .filter((kind) => !DEVICE_KINDS.some((known_) => known_.id === kind))
    .sort()
    .map((kind) => ({ id: kind, label: kindLabel(kind), count: counts.get(kind) }))
  return [...known, ...extra].map((kind) => {
    const supported = SUPPORTED_KINDS.has(kind.id)
    return {
      id: kind.id,
      label: kind.label,
      count: kind.count,
      supported,
      disabled: !supported,
      note: supported
        ? ''
        : kind.count
          ? `${countLabel(kind.count, 'device')} detected; Insight cannot show ${kind.label.toLowerCase()} yet.`
          : 'Not supported yet'
    }
  })
}

export function resolveDeviceKind(tabs, wanted) {
  const usable = (tabs || []).filter((tab) => !tab.disabled)
  if (wanted && usable.some((tab) => tab.id === wanted)) return wanted
  return usable[0]?.id || null
}

export function cameraDeviceId(camera) {
  const device = camera?.device || {}
  return device.camera_name || device.by_id || device.video_node || ''
}

export function cameraSubtitle(camera) {
  const deviceId = cameraDeviceId(camera)
  // The name already carries the model for a MIPI camera ("imx477 5-001a"), so repeating it says nothing.
  const model = camera?.model && !(camera?.name || '').includes(camera.model) ? camera.model : null
  return [model, deviceId !== camera?.name && deviceId].filter(Boolean).join(' · ')
}

export function deviceRows(camera) {
  const rows = [['Connection', connectionLabel(camera.connection)]]
  if (camera.model) rows.push(['Model', camera.model])
  const device = camera.device || {}
  for (const [key, label] of DEVICE_FIELDS) {
    if (device[key] !== undefined && device[key] !== null && device[key] !== '') rows.push([label, String(device[key])])
  }
  const usb = device.usb
  if (usb) {
    if (usb.vendor_id && usb.product_id) rows.push(['USB ID', `${usb.vendor_id}:${usb.product_id}`])
    for (const [key, label] of USB_FIELDS) if (usb[key]) rows.push([label, String(usb[key])])
    if (Number.isFinite(usb.speed_mbps)) rows.push(['USB speed', `${usb.speed_mbps} Mb/s`])
  }
  return rows
}

function rank(tier) {
  return TIER_RANK[tier] ?? 3
}

function best(list, tierOf) {
  return (list || []).reduce((top, item) => (top === null || rank(tierOf(item)) < rank(tierOf(top)) ? item : top), null)
}

function usableSizes(format) {
  return (format?.sizes || []).filter((size) => size.fps?.length)
}

function isSelectable(format) {
  return Boolean(format?.exportable && usableSizes(format).length)
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

export function modeLabel(selection) {
  if (!selection) return ''
  return `${selection.format} ${sizeLabel(selection.width, selection.height)} @ ${fpsLabel(selection.fps)} fps`
}

export function formatOptions(camera) {
  return (camera?.formats || []).map((f) => {
    const selectable = isSelectable(f)
    const reason = f.exportable ? 'no sizes with a frame rate were reported for it.' : (f.support?.reason || 'it cannot be used.')
    return {
      value: f.format,
      label: `${f.label || f.format} — ${selectable ? tierInfo(f.support?.tier).short : 'not usable'}`,
      disabled: !selectable,
      reason: selectable ? '' : reason,
      range: f.range || null
    }
  })
}

export function sizeOptions(camera, format) {
  return usableSizes(findFormat(camera, format)).map((s) => ({
    value: sizeKey(s.width, s.height),
    width: s.width,
    height: s.height,
    label: `${sizeLabel(s.width, s.height)} — ${tierInfo(sizeTier(s)).short}`
  }))
}

export function fpsOptions(camera, format, width, height) {
  const size = findSize(findFormat(camera, format), width, height)
  return (size?.fps || []).map((f) => ({
    value: String(f.value),
    label: `${fpsLabel(f.value)} fps — ${tierInfo(f.tier).short}`
  }))
}

// One visible explanation line per camera state, chosen by priority, so the
// detail pane never stacks four near-identical sentences.
export function cameraSummaryLine(camera) {
  const availability = availabilityInfo(camera?.availability)
  const tier = camera?.support?.tier
  if (camera?.availability?.state === 'in_use') {
    return `${availability.label}. Stop that process on the board before an application, or a preview here, can open this camera.`
  }
  if (tier && tier !== 'verified') return camera.support.reason || `${tierInfo(tier).label}.`
  if (camera?.availability?.state === 'unknown' && availability.reason) return `Availability unknown: ${availability.reason}`
  // A working camera gets no sentence at all. Every mode menu already labels each entry
  // "verified" or "advertised", so a paragraph repeating that distinction only adds text.
  return ''
}

export function blockedFormatSummary(options) {
  const blocked = (options || []).filter((option) => option.disabled)
  if (!blocked.length) return ''
  const names = blocked.map((option) => option.value).join(', ')
  return blocked.length === 1
    ? `1 format cannot be used (${names})`
    : `${blocked.length} formats cannot be used (${names})`
}

export function selectionTier(camera, selection) {
  if (!selection) return ''
  const size = findSize(findFormat(camera, selection.format), selection.width, selection.height)
  return findFps(size, selection.fps)?.tier || ''
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

// A preview streams the mode it was started with. When the menus move, the picture and the menus
// disagree until it is restarted on the new one.
export function previewNeedsRestart(state, cameraId, next) {
  const session = state?.session
  if (!next || !session) return false
  if (state.status !== 'starting' && state.status !== 'live') return false
  if (session.camera_id !== cameraId) return false
  return !sameSelection(session.mode, next)
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

// --- Camera preview -------------------------------------------------------
// The preview is a small state machine driven entirely by the backend session
// object. It lives here so the transitions can be tested without a DOM.

export const PREVIEW_IDLE = Object.freeze({ status: 'idle', session: null, error: null })

const PREVIEW_STATUS = {
  idle: { label: 'Not running', tone: '', busy: false },
  starting: { label: 'Starting…', tone: 'periph-info', busy: true },
  live: { label: 'Live', tone: 'ok', busy: false },
  stopping: { label: 'Stopping…', tone: 'periph-info', busy: true },
  error: { label: 'Could not start', tone: 'periph-danger', busy: false }
}

const PREVIEW_ERROR_ACTIONS = {
  camera_in_use: 'Stop that process on the board yourself, then start the preview again. Insight never stops it for you.',
  preview_active: 'Stop the preview that is already running, then start this one.',
  no_channel: 'Every published viewer channel is taken. Stop a stream on the Streaming page, then start the preview again.',
  invalid_request: 'Choose a mode Insight lists as verified or advertised; this one was rejected by the board.',
  command_failed: 'The capture worker could not start on the board. The board output below says why.',
  stale_snapshot: 'The board changed after this scan. Refresh, then start the preview again.',
  no_video: 'The board captured, but its video never reached Insight. The UDP port Insight listens on has to be reachable from the board; a host firewall is the usual reason it is not.',
  viewer_unavailable: 'Insight could not reach its own video viewer, which the preview plays through. Reload the page; if it keeps failing, Insight needs restarting.'
}

export function previewStatusInfo(state) {
  return PREVIEW_STATUS[state?.status] || PREVIEW_STATUS.idle
}

export function heartbeatDelay(session) {
  const ms = Number(session?.heartbeat_interval_ms)
  if (!Number.isFinite(ms) || ms <= 0) return 5000
  return Math.min(60000, Math.max(1000, Math.round(ms)))
}

export function sessionMatches(session, cameraId, generation) {
  if (!session || !cameraId) return false
  if (session.camera_id !== cameraId) return false
  if (generation === undefined || generation === null || session.generation === undefined) return true
  return Number(session.generation) === Number(generation)
}

export function previewErrorInfo(error) {
  if (!error) return null
  const code = error.code || ''
  const details = error.details || {}
  const other = details.session || details.preview || {}
  return {
    code,
    message: error.message,
    hint: error.hint || '',
    action: PREVIEW_ERROR_ACTIONS[code] || '',
    otherCamera: code === 'preview_active' ? String(other.camera_id || details.camera_id || '') : '',
    detail: typeof details.detail === 'string' ? details.detail : ''
  }
}

export function previewBlock({ camera, selection, stale = false, session = null, target = null } = {}) {
  if (!target) return { blocked: true, reason: 'No board is selected. Open board settings and choose one.' }
  if (!camera) return { blocked: true, reason: 'Select a camera first.' }
  if (stale) return { blocked: true, reason: 'The board changed after this scan. Refresh before starting a preview.' }
  if (camera.support?.tier === 'unsupported') {
    return {
      blocked: true,
      reason: camera.support.reason || 'Preview uses the board libcamera capture path, which this camera is not supported by.'
    }
  }
  if (!selection) return { blocked: true, reason: 'This camera reports no mode Insight can start.' }
  if (selectionTier(camera, selection) === 'unsupported') {
    return { blocked: true, reason: `${modeLabel(selection)} is not validated on this board. Choose a verified or advertised mode.` }
  }
  if (camera.availability?.state === 'in_use') {
    return { blocked: true, reason: `${availabilityInfo(camera.availability).label}. Stop that process on the board, then refresh.` }
  }
  if (session && session.camera_id && session.camera_id !== camera.id) {
    return { blocked: true, reason: `A preview is already running on ${session.camera_id}. Stop it before starting this one.` }
  }
  return { blocked: false, reason: '' }
}

function outOfDate(state, event) {
  if (event.for === undefined || event.for === null) return false
  // A preview that is still starting holds no session id yet, so an event tagged with one cannot
  // be matched. The only preview it can refer to is that one: discarding it would strand the page
  // in "Starting…" with a Stop button that has nothing to stop.
  if (!state.session) return state.status !== 'starting' && state.status !== 'stopping'
  return state.session.id !== event.for
}

export function nextPreviewState(state, event) {
  const current = state || PREVIEW_IDLE
  switch (event?.type) {
    case 'start':
      return { status: 'starting', session: null, error: null }
    case 'adopt': {
      // A session this browser did not start (page reload, second tab).
      const session = event.session
      if (!session || session.state === 'stopped') return PREVIEW_IDLE
      return { status: session.state === 'live' ? 'live' : 'starting', session, error: null }
    }
    case 'session': {
      const session = event.session
      if (!session) return PREVIEW_IDLE
      // A response for a session we already replaced or stopped must not revive it.
      if (current.session && current.session.id !== session.id) return current
      if (current.status === 'idle' || current.status === 'error') return current
      if (session.state === 'stopped') return { status: 'idle', session: null, error: null }
      if (current.status === 'stopping') return { status: 'stopping', session, error: null }
      return { status: session.state === 'live' ? 'live' : 'starting', session, error: null }
    }
    case 'stopping':
      if (outOfDate(current, event)) return current
      return { status: 'stopping', session: current.session, error: null }
    case 'stopped':
      if (outOfDate(current, event)) return current
      return PREVIEW_IDLE
    case 'expired':
      // A 404 for an id we no longer hold must not stop a newer session.
      if (outOfDate(current, event)) return current
      return {
        status: 'idle',
        session: null,
        error: {
          message: 'The preview stopped because the board stopped receiving heartbeats.',
          code: 'not_found',
          hint: 'Start the preview again. Insight only keeps a preview alive while this pane is open.',
          details: {}
        }
      }
    case 'failed':
      if (outOfDate(current, event)) return current
      return { status: 'error', session: null, error: event.error || null }
    case 'reset':
      return PREVIEW_IDLE
    default:
      return current
  }
}
