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

// Microphones are ALSA capture devices; anything that is not USB audio is on the board itself.
const MIC_CONNECTIONS = [
  { id: 'usb', label: 'USB (ALSA)' },
  { id: 'onboard', label: 'On-board (ALSA)' }
]

const SOURCES = { 'on-board': 'On this board', 'sdk-env': 'SDK DevKit', manual: 'Manual' }

// Device kinds Insight knows a name and an icon for. Cameras and microphones
// have a view; the rest are listed so the shape of the page does not change when
// the backend starts reporting them (contract: build nothing for other kinds
// yet). A kind the backend invents gets the generic "device" icon.
const DEVICE_KINDS = [
  { id: 'camera', label: 'Cameras', icon: 'camera' },
  { id: 'microphone', label: 'Microphones', icon: 'microphone' },
  { id: 'lidar', label: 'LiDAR', icon: 'lidar' }
]

const SUPPORTED_KINDS = new Set(['camera', 'microphone'])

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

function groupKind(items, kind, connections) {
  const devices = (items || []).filter((item) => item?.kind === kind)
  return connections
    .map((c) => ({ ...c, items: devices.filter((item) => item.connection === c.id) }))
    .filter((group) => group.items.length)
}

export function groupCameras(items) {
  return groupKind(items, 'camera', CONNECTIONS)
}

export function groupMicrophones(items) {
  return groupKind(items, 'microphone', MIC_CONNECTIONS)
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

// The subtitle only ties a webcam's or headset's microphone
// to the camera item the same USB device produced.
export function microphoneSubtitle(mic) {
  const name = mic?.device?.part_of?.name
  return name ? `Part of ${name}` : ''
}

export function sampleRateLabel(hz) {
  const khz = Number(hz) / 1000
  return `${Number.isInteger(khz) ? khz : Number(khz.toFixed(3))} kHz`
}

function rateList(rates) {
  const khz = rates.map((hz) => sampleRateLabel(hz).replace(' kHz', ''))
  return khz.length ? `${khz.join(' · ')} kHz` : ''
}

// One segmented row per distinct capture combination the device reports, e.g.
// S24_3LE | 2 ch | 24-bit | 32 · 44.1 · 48 kHz. A continuous rate range stays a range ("8–48 kHz"):
// expanding it into a list would invent rates the device never named.
export function captureModes(mic) {
  if (!Array.isArray(mic?.capture)) return null
  return mic.capture.map((mode, index) => {
    const rates = mode.rate_range
      ? `${sampleRateLabel(mode.rate_range.min).replace(' kHz', '')}–${sampleRateLabel(mode.rate_range.max)}`
      : rateList(mode.rates || [])
    const badges = [
      mode.format || '',
      Number.isFinite(mode.channels) ? `${mode.channels} ch` : '',
      Number.isFinite(mode.bits) ? `${mode.bits}-bit` : '',
      rates
    ].filter(Boolean)
    return { key: `${index}-${mode.format}-${mode.channels}-${mode.bits}`, badges }
  })
}

// --- Microphone test -------------------------------------------------------
// Like a video call's "Test microphone": record on the board until Stop (or the backend's cap) while
// a meter shows the live level, then play it back here with the meter following the playback.

export const MIC_TEST_IDLE = { status: 'idle', test: null, error: null }
// The meter spans -50..0 dBFS: a quiet room lights a segment or two, speech most of the bar.
export const METER_FLOOR_DBFS = -50

export function nextMicTestState(current, event) {
  const state = current || MIC_TEST_IDLE
  switch (event?.type) {
    case 'record':
      return { status: 'recording', test: null, error: null }
    case 'recorded':
      return state.status === 'recording' ? { status: 'playing', test: event.test, error: null } : state
    case 'failed':
      return state.status === 'recording' ? { status: 'error', test: null, error: event.error } : state
    case 'played': // the recording ended, or Stop playing
      return state.status === 'playing' ? { ...state, status: 'done' } : state
    case 'replay':
      return state.status === 'done' ? { ...state, status: 'playing' } : state
    case 'resume': // a test the backend was already running or finished for this microphone
      if (state.status !== 'idle' || !event.test) return state
      return event.test.state === 'recording'
        ? { status: 'recording', test: null, error: null }
        : { status: 'done', test: event.test, error: null }
    case 'reset':
      return MIC_TEST_IDLE
    default:
      return state
  }
}

// How many of `count` meter segments a level lights.
export function meterSegments(levelDbfs, count) {
  if (levelDbfs === null || levelDbfs === undefined || !Number.isFinite(Number(levelDbfs))) return 0
  const fraction = (Number(levelDbfs) - METER_FLOOR_DBFS) / -METER_FLOOR_DBFS
  return Math.round(Math.max(0, Math.min(1, fraction)) * count)
}

// Green for most of the bar, amber near the top, red at the end, as a level meter reads.
export function segmentTone(index, count) {
  if (index < Math.round(count * 0.7)) return 'low'
  if (index < Math.round(count * 0.9)) return 'mid'
  return 'high'
}

// The backend's current test when it belongs to this microphone and is still recording or has a
// recording to replay. A detail mounted after it started (another microphone was selected in
// between) takes it up instead of looking idle while the board records.
export function micTestToResume(micId, test) {
  if (!test || test.id !== micId) return null
  return test.state === 'recording' || test.state === 'ready' ? test : null
}

// A start that failed without the backend's answer (the connection dropped, or a gateway replied
// without an API body) may still have started recording, and a retry is then refused with
// `test_running`. The backend's current test for this microphone is taken up when it is not the
// one this detail already held (`heldToken`); otherwise the start's error stands.
export function micStartMayHaveRun(error) {
  return ['network', 'test_running', ''].includes(error?.code ?? '')
}

export function micTestAfterFailedStart(micId, error, test, heldToken) {
  if (!micStartMayHaveRun(error)) return null
  return test?.token === heldToken ? null : micTestToResume(micId, test)
}

// What to say about a finished recording: only when it needs attention.
export function micLevelNotice(level) {
  if (!level) return ''
  if (level.silent) return 'Nothing was picked up. Check the microphone\'s mute button and gain, then test again.'
  return ''
}

export function micTestErrorAction(error) {
  switch (error?.code) {
    case 'microphone_in_use':
      return 'Stop the application that is recording from it, then test again. Insight never stops it for you.'
    case 'not_found':
    case 'stale_snapshot':
      return 'Refresh, then test again.'
    case 'tool_missing':
      return 'Install alsa-utils on the board, then test again.'
    default:
      return error?.hint || ''
  }
}

// The one button's label and what pressing it does, for each state.
export function micTestAction(status, stopping) {
  if (status === 'recording') return { label: stopping ? 'Stopping…' : 'Stop recording', action: 'stop', disabled: stopping }
  if (status === 'playing') return { label: 'Stop playing', action: 'stop-playing', disabled: false }
  return { label: 'Test microphone', action: 'record', disabled: false }
}

export function formatClock(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
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

// Whether a start the page sent no longer matches what the page shows: the camera, the board, or the
// mode changed while the board was starting it. Its outcome then belongs to none of them.
export function startSuperseded(requested, latest) {
  if (requested.cameraId !== latest.cameraId) return true
  const { generation: sent } = requested
  const { generation: now } = latest
  if (sent != null && now != null && Number(sent) !== Number(now)) return true
  return !sameSelection(requested.mode, latest.selection)
}

// The mode to start once a restart's stop finished: the mode selected now, which the user may have
// changed again while the stop ran. None when the camera or the board changed meanwhile.
export function restartSelection(requested, latest) {
  if (requested.cameraId !== latest.cameraId) return null
  const { generation: sent } = requested
  const { generation: now } = latest
  if (sent != null && now != null && Number(sent) !== Number(now)) return null
  return latest.selection?.id === requested.cameraId ? latest.selection : null
}

// One start of a preview, from its POST to what the pane shows. The user can change the camera, the board,
// or the mode while any request is in flight, so every step that resumes after an await reads `view()`
// again and acts only for what is selected then. `deps`: post(mode) -> response, lookup() -> the running
// session or null, stop(session) -> whether it stopped, start(mode), adopt(session), dispatch(event),
// view() -> { cameraId, generation, selection }, and normalize(error).
export async function runPreviewStart(requested, deps) {
  deps.dispatch({ type: 'start' })
  let data
  try {
    data = await deps.post(requested.mode)
  } catch (err) {
    // Like a start that succeeded too late: once superseded, its failure says nothing about what the
    // pane now shows.
    if (startSuperseded(requested, deps.view())) return deps.dispatch({ type: 'reset' })
    const error = deps.normalize(err)
    // Another tab started a preview after this page loaded: show that one, with its Stop.
    const running = error.code === 'preview_active' ? await deps.lookup() : null
    if (startSuperseded(requested, deps.view())) return deps.dispatch({ type: 'reset' })
    const existing = sessionToAdopt(error, running)
    return existing ? deps.adopt(existing) : deps.dispatch({ type: 'failed', error })
  }
  // A session for a camera, board, or mode no longer shown would label one camera's video as another's,
  // or disagree with the menus: it is stopped instead.
  const latest = deps.view()
  if (sessionMatches(data.session, latest.cameraId, latest.generation, latest.selection)) {
    return deps.dispatch({ type: 'session', session: data.session })
  }
  if (!(await deps.stop(data.session))) return undefined
  // The mode may have changed again while the stop ran: start the one selected now, or nothing when
  // the camera or board changed.
  const next = restartSelection(requested, deps.view())
  return next ? deps.start(next) : deps.dispatch({ type: 'reset' })
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

function resolveId(groups, snapshot, previousId) {
  const devices = groups.flatMap((group) => group.items)
  if (previousId && devices.some((d) => d.id === previousId)) return previousId
  if (previousId && snapshot?.changes?.removed?.some((r) => r.id === previousId)) return previousId
  return devices[0]?.id || null
}

export function resolveCameraId(snapshot, previousId) {
  return resolveId(groupCameras(snapshot?.items), snapshot, previousId)
}

export function resolveMicrophoneId(snapshot, previousId) {
  return resolveId(groupMicrophones(snapshot?.items), snapshot, previousId)
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

// --- Camera preview -------------------------------------------------------
// The preview is a small state machine driven entirely by the backend session
// object. It lives here so the transitions can be tested without a DOM.

export const PREVIEW_IDLE = Object.freeze({ status: 'idle', session: null, error: null })

const PREVIEW_STATUS = {
  idle: { label: 'Not running', tone: '' },
  starting: { label: 'Starting…', tone: 'periph-info' },
  live: { label: 'Live', tone: 'ok' },
  elsewhere: { label: 'In another tab', tone: 'periph-info' },
  stopping: { label: 'Stopping…', tone: 'periph-info' },
  error: { label: 'Could not start', tone: 'periph-danger' }
}

const PREVIEW_ERROR_ACTIONS = {
  camera_in_use: 'Stop that process on the board yourself, then start the preview again. Insight never stops it for you.',
  preview_active: 'Stop the preview that is already running, then start this one.',
  invalid_request: 'Choose a mode Insight lists as Available; this one was rejected.',
  mode_adjusted: 'Pick the size libcamera streams at. The board lists the requested size, but its libcamera pipeline does not output it.',
  command_failed: 'The preview pipeline could not start on the board. The board output below says why.',
  stale_snapshot: 'The board changed after this scan. Refresh, then start the preview again.'
}

export function previewStatusInfo(state) {
  return PREVIEW_STATUS[state?.status] || PREVIEW_STATUS.idle
}

// The session's stream, only as the same-origin API path Insight serves it on; null for anything else.
export function previewStreamUrl(session) {
  const url = String(session?.stream_url || '')
  return /^\/api\/peripherals\/cameras\/preview\/[A-Za-z0-9_-]+\/stream$/.test(url) ? url : null
}

// The pane's event for a stream that ended: the backend stops a preview whose stream ends, so the
// preview is over, with the reason shown.
export function streamEndedEvent(sessionId) {
  return {
    type: 'ended',
    for: sessionId,
    error: {
      message: 'The preview stream stopped.',
      code: 'stream_ended',
      hint: 'Start the preview again. If it keeps stopping, check the camera connection on the board.',
      details: {}
    }
  }
}

// The pane's event for an <img> that could not load the stream. The backend gives a stream one
// viewer and refuses the next (preview_active): two pages that both found the preview unclaimed both
// try, and the one refused shows it as running in another tab while the backend still runs it with a
// viewer. Otherwise the stream is over.
export async function streamErrorEvent(request, sessionId) {
  let current = null
  try {
    current = (await request('/api/peripherals/preview'))?.session
  } catch {
    current = null
  }
  if (current?.id === sessionId && current.state !== 'stopped' && current.viewer) {
    return { type: 'elsewhere', for: sessionId, session: current }
  }
  return streamEndedEvent(sessionId)
}

// How often a live preview's page reads GET /api/peripherals/preview, which never contacts the board.
export const PREVIEW_POLL_MS = 2500

// One read of the backend's preview for a live session: the ended event when the backend no longer
// runs it; while it does, the camera's rate once the backend knows it (a MIPI sensor's arrives after
// the first frame), else null. A failed read proves nothing, so it ends nothing.
export async function previewStatusEvent(request, sessionId) {
  let current
  try {
    current = (await request('/api/peripherals/preview'))?.session
  } catch {
    return null
  }
  if (current?.id !== sessionId || current.state === 'stopped') return streamEndedEvent(sessionId)
  return rateLabel(current.camera_fps) ? { type: 'camera-fps', for: sessionId, fps: current.camera_fps } : null
}

// An <img> fires no event when a multipart stream ends cleanly (end of the board stream, the stall
// timeout, a refresh or board change from elsewhere), so a live preview is read every `interval` ms
// until the backend no longer runs it; then `onEvent` gets the ended event. A read that finds the
// camera's rate passes it on as a camera-fps event and reading goes on. Returns the cancel function.
export function watchPreview(request, sessionId, onEvent, interval = PREVIEW_POLL_MS) {
  let cancelled = false
  let timer = null
  async function check() {
    const event = await previewStatusEvent(request, sessionId)
    if (cancelled) return
    if (event) onEvent(event)
    if (event?.type !== 'ended') timer = setTimeout(check, interval)
  }
  timer = setTimeout(check, interval)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

// What the menus show for a preview the page adopts (reload, another tab): its camera and the mode
// it streams, so they agree with the video. Null when the session names no camera.
export function adoptedSelection(session) {
  if (!session?.camera_id) return null
  const mode = session.mode || {}
  return { id: session.camera_id, format: mode.format, width: mode.width, height: mode.height, fps: mode.fps }
}

// The running preview a refused start should adopt: another tab started one between this page's
// load and its start, so the pane shows that preview and its Stop instead of an error. Null otherwise.
export function sessionToAdopt(error, session) {
  if (error?.code !== 'preview_active' || !session || session.state === 'stopped') return null
  return session
}

export function sessionMatches(session, cameraId, generation, selection = null) {
  if (!session || !cameraId) return false
  if (session.camera_id !== cameraId) return false
  if (generation != null && session.generation !== undefined && Number(session.generation) !== Number(generation)) return false
  return !selection || sameSelection(session.mode, selection)
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

// The USB formats the backend previews: MJPG, and the raw FourCCs in neat_insight/preview/gst.py
// RAW_FORMATS (tests/test_preview.py keeps the two lists equal).
export const USB_PREVIEW_FORMATS = Object.freeze(['MJPG', 'YUYV', 'UYVY', 'YVYU', 'NV12', 'NV21', 'YU12', 'YV12', 'GREY', 'RGB3', 'BGR3'])

export function previewBlock({ camera, selection, stale = false, session = null, target = null } = {}) {
  if (!target) return { blocked: true, reason: 'No board is selected. Open board settings and choose one.' }
  if (!camera) return { blocked: true, reason: 'Select a camera first.' }
  if (stale) return { blocked: true, reason: 'The board changed after this scan. Refresh before starting a preview.' }
  // A USB camera previews any mode it lists in a format the preview reads; a MIPI camera only its Available modes.
  const mipi = camera.connection !== 'usb'
  if (mipi && camera.support?.tier === 'unsupported') {
    return {
      blocked: true,
      reason: camera.support.reason || 'Preview uses the board libcamera capture path, which this camera is not supported by.'
    }
  }
  if (!selection) return { blocked: true, reason: 'This camera reports no mode Insight can start.' }
  if (!mipi && !USB_PREVIEW_FORMATS.includes(selection.format)) {
    return { blocked: true, reason: `Preview decodes MJPG and converts raw formats such as YUYV, not ${selection.format}. Choose another format.` }
  }
  if (mipi && selectionTier(camera, selection) !== 'available') {
    return { blocked: true, reason: `${modeLabel(selection)} is Unsupported on this board. Choose an Available mode.` }
  }
  if (session?.camera_id && session.camera_id !== camera.id) {
    return { blocked: true, reason: `A preview is already running on ${session.camera_id}. Stop it before starting this one.` }
  }
  return { blocked: false, reason: '' }
}

// The events of a stop. A start that answered after the user moved on is stopped before the page
// holds its session, so its stop is tagged with an id the page never held.
const STOP_EVENTS = new Set(['stopping', 'stopped', 'stop-failed'])

function outOfDate(state, event) {
  if (event.for == null) return false
  // A preview that is still starting holds no session id yet. Its own stop must apply, or the page
  // stays in "Starting…" with a Stop button that has nothing to stop; any other tagged event (a late
  // "ended" from the preview before it) belongs to an earlier preview.
  if (!state.session) {
    return !((state.status === 'starting' || state.status === 'stopping') && STOP_EVENTS.has(event.type))
  }
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
      // The stream has one viewer: when another page shows it, this one offers Stop, not a second stream.
      if (session.viewer) return { status: 'elsewhere', session, error: null }
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
      if (current.status === 'elsewhere') return { status: 'elsewhere', session, error: null }
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
    case 'camera-fps':
      // The rate the camera runs at, for the running session only; unchanged, the state is kept as is.
      if (!current.session || outOfDate(current, event) || current.session.camera_fps === event.fps) return current
      return { ...current, session: { ...current.session, camera_fps: event.fps } }
    case 'elsewhere':
      // This page's stream was refused because another page shows it; only a live pane changes.
      if (outOfDate(current, event) || current.status !== 'live') return current
      return { status: 'elsewhere', session: event.session || current.session, error: null }
    case 'ended':
      // A live preview the backend stopped, with its reason; nothing is left to stop.
      if (outOfDate(current, event)) return current
      // One shown in another page ended there: this page has nothing to explain. One this page is stopping
      // ended because of that stop (closing the stream ends it), so it is a stop, not a failure.
      if (current.status === 'elsewhere' || current.status === 'stopping') return PREVIEW_IDLE
      return { status: 'idle', session: null, error: event.error || null }
    case 'failed':
      if (outOfDate(current, event)) return current
      return { status: 'error', session: null, error: event.error || null }
    case 'reset':
      return PREVIEW_IDLE
    default:
      return current
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
