const TIER_RANK = { verified: 0, advertised: 1, unsupported: 2 }

const TIERS = {
  verified: { label: 'Verified with Core', tone: 'ok' },
  advertised: { label: 'Advertised, unverified', tone: 'warn' },
  unsupported: { label: 'Not supported by Core CameraInput', tone: 'periph-danger' }
}

const CONNECTIONS = [
  { id: 'mipi', label: 'MIPI (libcamera)' },
  { id: 'usb', label: 'USB (V4L2)' }
]

const SOURCES = { 'on-board': 'On this board', 'sdk-env': 'SDK DevKit', manual: 'Manual' }

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
  return TIERS[tier] || { label: 'Support unknown', tone: '' }
}

export function severityInfo(severity) {
  return SEVERITY[severity] || SEVERITY.info
}

export function sourceLabel(source) {
  return SOURCES[source] || ''
}

function connectionLabel(connection) {
  return CONNECTIONS.find((c) => c.id === connection)?.label || String(connection || 'Unknown')
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
      badge: kind.count > 99 ? '99+' : kind.count ? String(kind.count) : '',
      name,
      tooltip: note ? `${kind.label} — ${note}` : name
    }
  })
}

export function resolveDeviceKind(tabs, wanted) {
  const list = tabs || []
  const usable = list.filter((tab) => !tab.disabled)
  if (wanted && usable.some((tab) => tab.id === wanted)) return wanted
  return usable[0]?.id || list.find((tab) => tab.supported)?.id || null
}

export function cameraSubtitle(camera) {
  const device = camera?.device || {}
  const deviceId = device.camera_name || device.by_id || device.video_node || ''
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
    const reason = f.exportable ? 'no sizes with a frame rate were reported for it.' : (f.support?.reason || 'it cannot be used.')
    return {
      value: f.format,
      label: f.label || f.format,
      tier: selectable ? f.support?.tier || '' : 'unsupported',
      disabled: !selectable,
      reason: selectable ? '' : `${reason}${range ? ` Reported range: ${range}.` : ''}`,
      range: f.range || null
    }
  })
}

export function sizeOptions(camera, format) {
  return usableSizes(findFormat(camera, format)).map((s) => ({
    value: sizeKey(s.width, s.height),
    width: s.width,
    height: s.height,
    label: sizeLabel(s.width, s.height),
    tier: sizeTier(s)
  }))
}

export function fpsOptions(camera, format, width, height) {
  const size = findSize(findFormat(camera, format), width, height)
  return (size?.fps || []).map((f) => ({
    value: String(f.value),
    label: `${fpsLabel(f.value)} fps`,
    tier: f.tier
  }))
}

const TIER_PILLS = {
  verified: { label: 'Verified', tone: 'ok' },
  advertised: { label: 'Advertised', tone: 'warn' },
  unsupported: { label: 'Not usable', tone: 'periph-danger' }
}
const TIER_GROUPS = [
  { id: 'verified', label: 'Verified with Core' },
  { id: 'advertised', label: 'Advertised by libcamera' },
  { id: 'unsupported', label: 'Not usable' },
  { id: '', label: 'Support unknown' }
]

export function optionTier(options, value) {
  const option = (options || []).find((o) => o.value === String(value))
  return option ? TIER_PILLS[option.tier] || null : null
}

export function groupOptions(options) {
  return TIER_GROUPS
    .map((group) => ({ ...group, options: (options || []).filter((o) => (o.tier || '') === group.id) }))
    .filter((group) => group.options.length)
}

export function cameraSummaryLine(camera) {
  const availability = availabilityInfo(camera?.availability)
  const tier = camera?.support?.tier
  if (camera?.availability?.state === 'in_use') {
    return `${availability.label}. Stop that process on the board before an application can open this camera.`
  }
  if (tier && tier !== 'verified') return camera.support.reason || `${tierInfo(tier).label}.`
  if (camera?.availability?.state === 'unknown' && availability.reason) return `Availability unknown: ${availability.reason}`
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
  if (seconds < 60) return `${countLabel(seconds, 'second')} ago`
  if (seconds < 3600) return `${countLabel(Math.floor(seconds / 60), 'minute')} ago`
  if (seconds < 86400) return `${countLabel(Math.floor(seconds / 3600), 'hour')} ago`
  return `${countLabel(Math.floor(seconds / 86400), 'day')} ago`
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

// A read applies only if nothing newer was sent or applied; a superseded read resolves to the newer state.
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

// flush() runs after every render and focuses the first connected, enabled candidate of a pending request.
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

export const PREVIEW_IDLE = Object.freeze({ status: 'idle', session: null, error: null })

const PREVIEW_STATUS = {
  idle: { label: 'Not running', tone: '' },
  starting: { label: 'Starting…', tone: 'periph-info' },
  live: { label: 'Live', tone: 'ok' },
  stopping: { label: 'Stopping…', tone: 'periph-info' },
  error: { label: 'Could not start', tone: 'periph-danger' }
}

const PREVIEW_ERROR_ACTIONS = {
  camera_in_use: 'Stop that process on the board yourself, then start the preview again. Insight never stops it for you.',
  preview_active: 'Stop the preview that is already running, then start this one.',
  no_channel: 'Every published viewer channel is taken. Stop a stream on the Streaming page, then start the preview again.',
  invalid_request: 'Choose a mode Insight lists as verified or advertised; this one was rejected by the board.',
  command_failed: 'The capture worker could not start on the board. The board output below says why.',
  stale_snapshot: 'The board changed after this scan. Refresh, then start the preview again.',
  no_video: 'The board captured, but its video never reached Insight. The UDP port Insight listens on has to be reachable from the board; a host firewall is the usual reason it is not.',
  viewer_unavailable: 'Insight could not reach its own video viewer, which the preview plays through. Reload the page; if it keeps failing, Insight needs restarting.',
  channel_taken: 'Another sender is using that viewer channel. Starting the preview again picks a channel nothing is sending to.'
}

const PREVIEW_EXPIRED = {
  message: 'The preview stopped because the board stopped receiving heartbeats.',
  code: 'not_found',
  hint: 'Start the preview again. Insight only keeps a preview alive while this pane is open.',
  details: {}
}

export function previewStatusInfo(state) {
  return PREVIEW_STATUS[state?.status] || PREVIEW_STATUS.idle
}

export function previewErrorInfo(error) {
  if (!error) return null
  const code = error.code || ''
  const details = error.details || {}
  return {
    code,
    message: error.message,
    hint: error.hint || '',
    action: PREVIEW_ERROR_ACTIONS[code] || '',
    otherCamera: code === 'preview_active' ? String(details.camera_id || '') : '',
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
  const size = findSize(findFormat(camera, selection.format), selection.width, selection.height)
  if (findFps(size, selection.fps)?.tier === 'unsupported') {
    return { blocked: true, reason: `${modeLabel(selection)} is not validated on this board. Choose a verified or advertised mode.` }
  }
  if (camera.availability?.state === 'in_use') {
    return { blocked: true, reason: `${availabilityInfo(camera.availability).label}. Stop that process on the board, then refresh.` }
  }
  if (session?.camera_id && session.camera_id !== camera.id) {
    return { blocked: true, reason: `A preview is already running on ${session.camera_id}. Stop it before starting this one.` }
  }
  return { blocked: false, reason: '' }
}

function outOfDate(state, event) {
  if (event.for == null) return false
  // A start holds no session id yet, so an event for any id can only mean that start.
  if (!state.session) return state.status !== 'starting' && state.status !== 'stopping'
  return state.session.id !== event.for
}

export function nextPreviewState(state, event) {
  const current = state || PREVIEW_IDLE
  switch (event?.type) {
    case 'start':
      return { status: 'starting', session: null, error: null }
    case 'adopt': {
      const session = event.session
      if (!session || session.state === 'stopped') return PREVIEW_IDLE
      return { status: session.state === 'live' ? 'live' : 'starting', session, error: null }
    }
    case 'session': {
      const session = event.session
      if (!session) return PREVIEW_IDLE
      if (current.session && current.session.id !== session.id) return current
      if (current.status === 'idle' || current.status === 'error') return current
      if (session.state === 'stopped') return PREVIEW_IDLE
      if (current.status === 'stopping') return { status: 'stopping', session, error: null }
      return { status: session.state === 'live' ? 'live' : 'starting', session, error: null }
    }
    case 'stopping':
      if (outOfDate(current, event)) return current
      return { status: 'stopping', session: current.session || event.session || null, error: null }
    case 'stopped':
      if (outOfDate(current, event)) return current
      return PREVIEW_IDLE
    case 'stop-failed':
      if (outOfDate(current, event)) return current
      return { status: 'live', session: current.session || event.session || null, error: event.error || null }
    case 'ended':
      if (outOfDate(current, event)) return current
      return { status: 'idle', session: null, error: event.error || PREVIEW_EXPIRED }
    case 'failed':
      if (outOfDate(current, event)) return current
      return { status: 'error', session: null, error: event.error || null }
    case 'reset':
      return PREVIEW_IDLE
    default:
      return current
  }
}
