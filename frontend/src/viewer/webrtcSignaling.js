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

export async function requestWebRTCAnswer(peerConnection, offerUrl, fetchRequest = globalThis.fetch) {
  await peerConnection.setLocalDescription(await peerConnection.createOffer());
  await waitForIceGathering(peerConnection);

  const response = await fetchRequest(offerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(peerConnection.localDescription),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  return response.json();
}
