/** The part of a peer connection that makes an offer (without the legacy callback overloads). */
export interface OfferPeer {
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
}

/** The part of `fetch` signalling needs, so specs can answer for vf. */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/** vf (or the Flask proxy in front of it) answered the offer with an HTTP error. */
export class OfferRejectedError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'OfferRejectedError';
  }
}

/**
 * Only an explicit 4xx is a permanent rejection of this offer. Transport and local failures (a
 * fetch rejection, setRemoteDescription) carry no status, and a 5xx is a server-side condition that
 * commonly clears: vf answers 503 until RTP identifies the codec, and 500 when the ephemeral UDP
 * range is momentarily exhausted. Treating either as permanent would leave a tile dead until the
 * page reloads. A browser that cannot decode the channel codec gets 415 instead, precisely so it
 * lands here as permanent rather than retrying a negotiation that can never succeed.
 */
export function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status !== 'number' || status >= 500;
}

/**
 * Creates the offer, posts it and returns vf's answer; a non-2xx response throws
 * `OfferRejectedError`.
 *
 * The offer is posted before gathering completes, and deliberately so. Gathering cannot report
 * complete until every configured ICE server has answered or exhausted its STUN retransmission
 * schedule, so waiting on it puts a public internet round trip in front of a connection between
 * two processes on the same host. Measured browser-side, waiting cost 120 ms when the STUN server
 * answered and 3.9 s, 15.9 s or 25 s when its packets were dropped (the RFC 5389 backoff steps).
 * Posting immediately needs none of those candidates: the browser reaches vf on the host
 * candidates in the answer, and vf accepts the browser's source address as peer-reflexive. That
 * path connects in 5-10 ms.
 */
export async function requestAnswer(
  peer: OfferPeer,
  offerUrl: string,
  fetchRequest: FetchLike = (url, init) => fetch(url, init),
): Promise<RTCSessionDescriptionInit> {
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);

  const response = await fetchRequest(offerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(offer),
  });
  if (!response.ok) throw new OfferRejectedError(response.status);
  return (await response.json()) as RTCSessionDescriptionInit;
}
