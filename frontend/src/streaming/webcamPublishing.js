// WHIP publishing helpers for browser webcam sources (see issue #120).
//
// Kept out of App.jsx so the negotiation can be tested without a DOM, a real
// RTCPeerConnection, or a camera — the same split the viewer uses for
// webrtc/static/js/webrtcSignaling.js.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Turn a getUserMedia or publish failure into something a user can act on.
// Anything unrecognized falls through to the underlying message rather than a
// generic string, because the publish errors below already read well.
export function describeWebcamError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Camera permission was denied. Allow camera access for this site and try again.'
  }
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
    return 'That camera is no longer available. Detect webcams again and reselect one.'
  }
  if (error?.name === 'NotReadableError') {
    return 'The camera could not be started (it may be in use by another application).'
  }
  return error?.message || 'Webcam publishing failed.'
}

// MediaMTX returns the session resource in Location; DELETE on it releases the
// path immediately instead of waiting for the peer connection to time out. A
// malformed or absent value is not worth failing the publish over — closing the
// RTCPeerConnection already ends the media flow.
// MediaMTX names the WHIP resource after the session it created, so the last
// path segment of the Location is the session id — the same id its status API
// reports as the path's source. A stop sent later carries it so the backend
// can tell "my old session" from "whoever holds the slot now".
export function sessionIdFromDeleteUrl(deleteUrl) {
  if (!deleteUrl) return null
  try {
    const segments = new URL(deleteUrl).pathname.split('/').filter(Boolean)
    return segments.length ? segments[segments.length - 1] : null
  } catch {
    return null
  }
}

export function resolveDeleteUrl(location, whipUrl) {
  if (!location) return null
  try {
    return new URL(location, whipUrl).toString()
  } catch {
    return null
  }
}

// Chrome's default offer prefers VP8. The rest of Insight (codec badges, what a
// Core application expects on the RTSP side) assumes h264/h265/mjpeg, and #120
// calls for H.264, so the transceiver is pinned rather than left to negotiate.
export function selectH264Codecs(capabilities) {
  return (capabilities?.codecs || []).filter((codec) => /^video\/H264$/i.test(codec.mimeType))
}

// The offer is posted before ICE gathering completes, deliberately, for the
// reason webrtcSignaling.js documents on the viewer side: gathering cannot
// report complete until every configured STUN server has answered or exhausted
// its RFC 5389 retransmission schedule, which measured 120 ms when the server
// answered and 3.9-25 s when its packets were dropped. Waiting would put that in
// front of a connection between a browser and MediaMTX on the same host or LAN,
// which needs none of those candidates: the browser reaches MediaMTX on the host
// candidates in the answer, and MediaMTX accepts the browser's source address as
// peer-reflexive.
export async function publishWebcamOffer(peerConnection, whipUrl, fetchRequest = globalThis.fetch) {
  const offer = await peerConnection.createOffer()
  await peerConnection.setLocalDescription(offer)

  const response = await fetchRequest(whipUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: peerConnection.localDescription.sdp,
  })

  if (!response.ok) {
    const error = new Error(`Webcam publish was rejected (HTTP ${response.status}).`)
    error.status = response.status
    throw error
  }

  const deleteUrl = resolveDeleteUrl(response.headers?.get('Location'), whipUrl)
  return {
    answerSdp: await response.text(),
    deleteUrl,
    sessionId: sessionIdFromDeleteUrl(deleteUrl),
  }
}

// Insight reports a webcam slot as playing only once MediaMTX says the path is
// ready, which lags the WHIP exchange by the ICE handshake. Poll to a deadline
// rather than sleeping a fixed amount: a fixed delay is either longer than a
// local handshake needs or too short for a slow one, and this reports the real
// failure when the stream genuinely never arrives.
export async function confirmWebcamPublishing(attempt, options = {}) {
  const {
    timeoutMs = 5000,
    intervalMs = 250,
    sleep = defaultSleep,
    now = () => Date.now(),
    // Not every failure is worth retrying. A slot reassigned out from under the
    // start will never become the thing we are waiting for, so retrying until
    // the deadline would both waste the wait and risk acting on the new slot.
    isTerminal = () => false,
  } = options

  const deadline = now() + timeoutMs
  let lastError = null

  for (;;) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
      if (isTerminal(error)) throw error
    }
    if (now() >= deadline) {
      throw lastError || new Error('Webcam did not start publishing in time.')
    }
    await sleep(intervalMs)
  }
}

// Releasing a webcam session means three things, and the DELETE is the only
// optional one: stop the camera tracks so the OS releases the device, close
// the peer connection so MediaMTX sees the publisher go away, and best-effort
// tell MediaMTX to drop the path now rather than waiting for the WebRTC
// timeout. Kept here, out of the component, so the bulk paths that have to do
// this for every session can be tested without React.
export function closeWebcamSession(session, fetchRequest = globalThis.fetch) {
  if (!session) return false

  try {
    session.stream?.getTracks?.().forEach((track) => track.stop())
  } catch {
    // A track already ended is not worth failing the teardown over.
  }
  try {
    session.pc?.close?.()
  } catch {
    // Same for an already-closed peer connection.
  }

  if (session.deleteUrl && fetchRequest) {
    try {
      fetchRequest(session.deleteUrl, { method: 'DELETE' })?.catch?.(() => {})
    } catch {
      // Closing the peer connection above already ended the media flow.
    }
  }
  return true
}

// Stop All, Reset and Auto Assign each invalidate every live webcam slot at
// once. Insight can kill a file source's ffmpeg process itself, but only this
// browser can end a webcam publish, so a bulk action that skips this leaves
// cameras publishing while the UI reports everything stopped.
export function closeAllWebcamSessions(sessions, fetchRequest = globalThis.fetch) {
  const closed = []
  if (!sessions) return closed
  for (const index of Array.from(sessions.keys())) {
    closeWebcamSession(sessions.get(index), fetchRequest)
    sessions.delete(index)
    closed.push(index)
  }
  return closed
}

// `disconnected` is not the same as gone. ICE reports it for a transient
// interruption — a Wi-Fi blip, a roam between APs — and recovers to
// `connected` on its own without renegotiation. Tearing down on sight turns a
// momentary disturbance into a source the user has to set up again, so only
// `failed` and `closed` are acted on immediately; `disconnected` gets a grace
// period to come back.
export function createDisconnectWatcher({
  onLost,
  graceMs = 10000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null
  // Cancelling is permanent. Closing the peer connection on purpose emits a
  // `closed` state change like any other, and a watcher that still reacted to
  // it would report an intentional teardown as a lost connection — and send a
  // second stop for a session that is already gone.
  let active = true

  function cancel() {
    active = false
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  return {
    cancel,
    update(state) {
      if (!active) return
      if (state === 'failed' || state === 'closed') {
        cancel()
        onLost?.(state)
        return
      }
      if (state === 'disconnected') {
        if (timer === null) {
          timer = setTimer(() => {
            timer = null
            onLost?.('disconnected')
          }, graceMs)
        }
        return
      }
      // connecting / connected / new: whatever interruption there was is over.
      cancel()
    },
  }
}

// Insight advertises every webcam source as H.264 — the codec badge, the RTSP
// output, and what a Core application is configured to decode. If the browser
// cannot actually offer H.264, MediaMTX will happily accept VP8 and the source
// then lies about its codec, failing downstream instead of here. Fail here.
export function pinH264(transceiver, capabilities) {
  const codecs = selectH264Codecs(capabilities)
  if (!codecs.length) {
    throw new Error(
      'This browser cannot publish H.264 video, which webcam sources require. Try Chrome, Edge or Safari.',
    )
  }
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') {
    throw new Error(
      'This browser cannot choose a video codec, so H.264 publishing cannot be guaranteed. Try Chrome, Edge or Safari.',
    )
  }
  transceiver.setCodecPreferences(codecs)
  return codecs
}
