// Live preview of a browser camera in Media Sources (issue #222).
//
// The preview is local to this tab: the browser opens the camera and a <video> plays it. It never
// assigns a Streaming slot or starts or stops a publish. Kept out of the component so the state
// machine and the stream facts can be tested without a DOM or a camera.

import { rateLabel, sizeLabel } from '../peripherals/model.js'

// The one constraint a preview asks for. No size or rate: the preview shows what the camera gives
// by default, and asking for more would make the browser reconfigure a camera it shares.
export function previewConstraints(deviceId) {
  return { video: { deviceId: { exact: deviceId } }, audio: false }
}

// Whether the frames around this page let it use a camera, from the Permissions Policy. Inside a
// cross-origin frame that was not given `allow="camera"`, getUserMedia fails with the same
// NotAllowedError as a denied prompt, so this is how the two are told apart. null when the browser
// cannot say (Firefox and Safari have no policy API).
export function frameAllowsCamera(doc = globalThis.document) {
  const policy = doc?.permissionsPolicy || doc?.featurePolicy
  if (typeof policy?.allowsFeature !== 'function') return null
  try {
    return Boolean(policy.allowsFeature('camera'))
  } catch {
    return null
  }
}

const NO_CAMERA_API = 'no_camera_api'
const NO_VIDEO_TRACK = 'no_video_track'

// A failed or interrupted preview as a state the pane can show: a short title and what to do.
// `kind` picks the actions: 'denied' and 'busy' can retry, 'disconnected' re-scans the cameras,
// 'blocked' and 'unsupported' cannot be fixed from this page.
export function describePreviewError(error, { frameAllowsCamera: allowed = null } = {}) {
  const name = error?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    if (allowed === false) {
      return {
        kind: 'blocked',
        title: 'This page is embedded in a frame that does not allow camera access.',
        action: 'Open Insight in its own browser tab to preview cameras. The frame around Insight decides this, not the browser permission.'
      }
    }
    return {
      kind: 'denied',
      title: 'Camera permission was denied.',
      action: 'Allow camera access for this site in the browser\'s site settings, then select Try again.'
    }
  }
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
    return {
      kind: 'busy',
      title: 'The camera could not be started.',
      action: 'Another application may be using it. Close that application, then select Try again.'
    }
  }
  // The preview's only constraint is the exact device, so a failed deviceId constraint means the
  // camera has gone; any other constraint is a capture setting the camera cannot deliver.
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || (name === 'OverconstrainedError' && (!error.constraint || error.constraint === 'deviceId'))) {
    return {
      kind: 'disconnected',
      title: 'That camera is no longer available.',
      action: 'Reconnect it, then select Refresh cameras to look for it again.'
    }
  }
  if (name === 'OverconstrainedError') {
    return {
      kind: 'unsupported',
      title: `The camera cannot capture with the requested ${error.constraint} setting.`,
      action: 'Select Try again. If it keeps failing, try another camera or browser.'
    }
  }
  if (error?.code === NO_CAMERA_API) {
    return {
      kind: 'unsupported',
      title: 'This browser cannot open cameras on this page.',
      action: 'Open Insight over HTTPS, or on localhost, in a current Chrome, Edge, Firefox or Safari.'
    }
  }
  if (error?.code === NO_VIDEO_TRACK) {
    return {
      kind: 'unsupported',
      title: 'The camera opened but sent no video.',
      action: 'Select Try again, or try another camera.'
    }
  }
  if (name === 'TypeError' || name === 'NotSupportedError') {
    return {
      kind: 'unsupported',
      title: 'This browser cannot preview that camera.',
      action: 'Try a current Chrome, Edge, Firefox or Safari.'
    }
  }
  return {
    kind: 'error',
    title: error?.message || 'The camera preview could not start.',
    action: 'Select Try again.'
  }
}

// The preview's track ended without the preview stopping it: the camera was unplugged, the OS took
// it away, or the browser revoked the permission.
export const ENDED_ERROR = {
  kind: 'disconnected',
  title: 'The camera stopped sending video.',
  action: 'It may have been unplugged or taken by another application. Reconnect it, then select Refresh cameras to look for it again.'
}

const positive = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null)
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)

const FACING = { user: 'Front (user)', environment: 'Back (environment)', left: 'Left', right: 'Right' }
const RESIZE = { none: 'Native camera mode', 'crop-and-scale': 'Cropped or scaled by the browser' }

function readSafely(track, method) {
  try {
    return typeof track?.[method] === 'function' ? track[method]() || null : null
  } catch {
    return null
  }
}

// What the browser reports for a live video track, as label/value rows. Active settings come from
// getSettings(): what the track delivers now. Capabilities come from getCapabilities(), only where
// the browser has it, and say what the camera could deliver. A value the browser does not report
// is left out rather than guessed; the pixel format is never reported by browsers, so never shown.
export function streamInfo(track) {
  const settings = readSafely(track, 'getSettings') || {}
  const capabilities = readSafely(track, 'getCapabilities')

  const active = []
  const width = positive(settings.width)
  const height = positive(settings.height)
  if (width && height) active.push({ key: 'resolution', label: 'Resolution', value: sizeLabel(width, height) })
  const fps = rateLabel(positive(settings.frameRate))
  if (fps) active.push({ key: 'frameRate', label: 'Frame rate', value: fps })
  const facing = text(settings.facingMode)
  if (facing) active.push({ key: 'facingMode', label: 'Facing', value: FACING[facing] || facing })
  const resize = text(settings.resizeMode)
  if (resize) active.push({ key: 'resizeMode', label: 'Scaling', value: RESIZE[resize] || resize })

  const supported = []
  if (capabilities) {
    // Browsers report the width and height limits separately, not as a mode the camera has: a
    // FaceTime HD camera reports 1920 for both. So they are shown apart, never joined into a size.
    const maxWidth = positive(capabilities.width?.max)
    const maxHeight = positive(capabilities.height?.max)
    if (maxWidth) supported.push({ key: 'width', label: 'Width', value: `up to ${maxWidth} px` })
    if (maxHeight) supported.push({ key: 'height', label: 'Height', value: `up to ${maxHeight} px` })
    const maxFps = rateLabel(positive(capabilities.frameRate?.max))
    if (maxFps) supported.push({ key: 'frameRate', label: 'Frame rate', value: `up to ${maxFps}` })
    const facingModes = Array.isArray(capabilities.facingMode) ? capabilities.facingMode.map(text).filter(Boolean) : []
    if (facingModes.length) supported.push({ key: 'facingMode', label: 'Facing', value: facingModes.map((m) => FACING[m] || m).join(', ') })
  }

  return {
    // The rows the live chip shows, in the same order as the Peripherals preview.
    resolution: width && height ? sizeLabel(width, height) : null,
    frameRate: fps || null,
    active,
    supported,
    // Whether the browser has getCapabilities() at all, so the pane can say so instead of an empty list.
    capabilitiesReported: Boolean(capabilities)
  }
}

// The live video track this tab is publishing from the camera, if any, with its slot. Previewing
// that camera clones this track instead of opening the device again, so the preview cannot change
// the capture the publish is sending. `sessions` and `assignments` are App's webcam session map and
// slot assignments.
export function publishingTrackFor(sessions, assignments, deviceId) {
  if (!sessions || !deviceId) return null
  for (const [index, session] of sessions) {
    let track = null
    try {
      track = session?.stream?.getVideoTracks?.()[0] || null
    } catch {
      track = null
    }
    if (!track || track.readyState !== 'live') continue
    const trackDevice = readSafely(track, 'getSettings')?.deviceId
    if (trackDevice === deviceId || (!trackDevice && assignments?.[index]?.deviceId === deviceId)) {
      return { track, index: Number(index) }
    }
  }
  return null
}

function stopTracks(stream) {
  try {
    stream?.getTracks?.().forEach((track) => track.stop())
  } catch {
    // A track that already ended is not worth failing the release over.
  }
}

export const IDLE = Object.freeze({ status: 'idle' })

// One preview at a time. select() replaces whatever was showing; stop() releases it. Every track
// this preview opened or cloned is stopped when it is replaced or stopped, and never any other:
// a publish's own track is only ever cloned. A select() that is overtaken while the browser is
// still opening the camera stops what it gets, so a slow or answered-late permission prompt cannot
// leave a camera on.
//
// Selecting a camera whose earlier request is still pending waits for that request instead of
// opening the camera a second time. React's Strict Mode runs the preview's effect as select, stop,
// select in development, and picking A, B, then A again quickly does the same; a second open of a
// camera that only one client may hold would fail as busy while the first one succeeds.
//
// onState receives { status: 'idle' }, { status: 'loading', camera }, { status: 'live', camera,
// stream, info, sharedWith }, or { status: 'error', camera, error }.
export function createCameraPreview({
  mediaDevices = globalThis.navigator?.mediaDevices,
  createStream = (tracks) => new MediaStream(tracks),
  frameAllowsCamera: frameCheck = () => frameAllowsCamera(),
  onState = () => {}
} = {}) {
  let generation = 0
  let current = null // { stream, track, onEnded }
  let state = IDLE
  // deviceId -> { promise, claimedBy }: getUserMedia requests still in flight. claimedBy is the
  // latest select() waiting on the request, the only one that may keep or stop its stream.
  const pending = new Map()

  function request(deviceId, mine) {
    let entry = pending.get(deviceId)
    if (!entry) {
      entry = { promise: mediaDevices.getUserMedia(previewConstraints(deviceId)), claimedBy: mine }
      pending.set(deviceId, entry)
      const settled = () => {
        if (pending.get(deviceId) === entry) pending.delete(deviceId)
      }
      entry.promise.then(settled, settled)
    }
    entry.claimedBy = mine
    return entry
  }

  function emit(next) {
    state = next
    onState(next)
  }

  function release() {
    if (!current) return
    current.track?.removeEventListener?.('ended', current.onEnded)
    stopTracks(current.stream)
    current = null
  }

  // `shared` is publishingTrackFor()'s answer for this camera, read at selection time.
  async function select(camera, { shared = null } = {}) {
    const mine = ++generation
    release()
    if (!camera?.deviceId) {
      emit(IDLE)
      return state
    }
    emit({ status: 'loading', camera })

    let stream
    let sharedWith = null
    let opened = null
    try {
      if (shared?.track && shared.track.readyState === 'live') {
        stream = createStream([shared.track.clone()])
        sharedWith = shared.index
      } else {
        if (typeof mediaDevices?.getUserMedia !== 'function') {
          throw Object.assign(new Error('getUserMedia is unavailable'), { code: NO_CAMERA_API })
        }
        opened = request(camera.deviceId, mine)
        stream = await opened.promise
      }
    } catch (error) {
      if (mine !== generation) return state
      emit({ status: 'error', camera, error: describePreviewError(error, { frameAllowsCamera: frameCheck() }) })
      return state
    }

    if (mine !== generation) {
      // A later select() waiting on the same request takes the stream over; otherwise nobody wants it.
      if (!opened || opened.claimedBy === mine) stopTracks(stream)
      return state
    }
    const track = stream?.getVideoTracks?.()[0]
    if (!track) {
      stopTracks(stream)
      emit({ status: 'error', camera, error: describePreviewError({ code: NO_VIDEO_TRACK }) })
      return state
    }

    const onEnded = () => {
      if (current?.track !== track) return
      release()
      emit({ status: 'error', camera, error: ENDED_ERROR })
    }
    track.addEventListener?.('ended', onEnded)
    current = { stream, track, onEnded }
    emit({ status: 'live', camera, stream, info: streamInfo(track), sharedWith })
    return state
  }

  // Settle on the settings the track reports once video is flowing; a browser can adjust the size
  // or rate after getUserMedia resolves.
  function refresh() {
    if (state.status !== 'live' || !current) return state
    emit({ ...state, info: streamInfo(current.track) })
    return state
  }

  function stop() {
    generation += 1
    release()
    if (state.status !== 'idle') emit(IDLE)
    return state
  }

  return { select, refresh, stop, get state() { return state } }
}
