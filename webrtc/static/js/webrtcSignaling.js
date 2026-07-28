// Only an explicit 4xx is a permanent rejection of this offer. Transport and
// local failures (fetch rejection, setRemoteDescription) carry no status, and a
// 5xx is a server-side condition that commonly clears — vf answers 503 until RTP
// identifies the codec, and 500 when the ephemeral UDP range is momentarily
// exhausted. Treating either as permanent leaves a tile dead until page reload.
// A browser that cannot decode the channel codec gets 415 instead, precisely so
// it lands here as permanent rather than retrying a negotiation that can never
// succeed.
export function isRetryableWebRTCAnswerError(error) {
  const status = error?.status;
  return status === undefined || status >= 500;
}

// The offer is posted before gathering completes, and deliberately so. Gathering
// cannot report complete until every configured ICE server has answered or
// exhausted its STUN retransmission schedule, so waiting on it puts a public
// internet round trip in front of a connection between two processes on the same
// host. Measured browser-side, waiting cost 120 ms when the STUN server answered
// and 3.9 s, 15.9 s, or 25 s when its packets were dropped — the RFC 5389 backoff
// steps. Posting immediately needs none of those candidates: the browser reaches
// vf on the host candidates in the answer, and vf accepts the browser's source
// address as peer-reflexive. That path connects in 5-10 ms.
export async function requestWebRTCAnswer(peerConnection, offerUrl, fetchRequest = globalThis.fetch) {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  const response = await fetchRequest(offerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(offer),
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}
