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

// The offer is posted before gathering completes, and deliberately so. Chrome
// obfuscates local addresses as mDNS ".local" candidates, which vf would then
// have to resolve by mDNS from inside its container — measured slower on every
// sample and occasionally stalling for seconds. An offer carrying no candidates
// lets the browser connect straight to the host candidates in the answer, which
// vf accepts as peer-reflexive.
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
