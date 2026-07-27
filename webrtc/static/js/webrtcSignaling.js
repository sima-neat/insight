function waitForIceGathering(peerConnection) {
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve) => {
    const onGatheringStateChange = () => {
      if (peerConnection.iceGatheringState !== "complete") return;
      peerConnection.removeEventListener("icegatheringstatechange", onGatheringStateChange);
      resolve();
    };
    peerConnection.addEventListener("icegatheringstatechange", onGatheringStateChange);
    onGatheringStateChange();
  });
}

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

export async function requestWebRTCAnswer(peerConnection, offerUrl, fetchRequest = globalThis.fetch) {
  await peerConnection.setLocalDescription(await peerConnection.createOffer());
  await waitForIceGathering(peerConnection);

  const response = await fetchRequest(offerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(peerConnection.localDescription),
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}
