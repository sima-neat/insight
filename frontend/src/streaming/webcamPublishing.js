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

  return {
    answerSdp: await response.text(),
    deleteUrl: resolveDeleteUrl(response.headers?.get('Location'), whipUrl),
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
  } = options

  const deadline = now() + timeoutMs
  let lastError = null

  for (;;) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
    }
    if (now() >= deadline) {
      throw lastError || new Error('Webcam did not start publishing in time.')
    }
    await sleep(intervalMs)
  }
}
