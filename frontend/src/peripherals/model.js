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
  if (status?.state === 'connected') return { label: 'Connected', tone: 'ok' }
  if (status?.state === 'error') return { label: 'Connection failed', tone: 'periph-danger' }
  return { label: 'Not checked', tone: '' }
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

export function cameraDeviceId(camera) {
  const device = camera?.device || {}
  return device.camera_name || device.by_id || device.video_node || ''
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
    const reason = f.exportable ? 'no sizes with a frame rate were reported for it.' : (f.support?.reason || 'it cannot be exported.')
    return {
      value: f.format,
      label: `${f.label || f.format} — ${selectable ? tierInfo(f.support?.tier).short : 'not exportable'}`,
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

export function extractCommand(text) {
  const value = String(text || '').trim()
  const quoted = value.match(/`([^`]+)`/)
  if (quoted) return quoted[1].trim()
  const command = value.match(/\bssh(?:-copy-id|-keygen)?\s[^\n]*/)
  return command ? command[0].trim().replace(/[.;,]$/, '') : value
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
