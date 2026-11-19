import { isRetryable, requestAnswer, type OfferPeer } from './signaling';

describe('requestAnswer', () => {
  it('posts the offer without waiting for candidate gathering', async () => {
    const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0\r\n' };
    const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'v=0\r\n' };
    const peer = {
      iceGatheringState: 'new' as RTCIceGatheringState,
      localDescription: null as RTCSessionDescriptionInit | null,
      async createOffer() {
        return offer;
      },
      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description;
        this.iceGatheringState = 'gathering';
      },
      addEventListener() {
        throw new Error('must not wait for gathering; it would block on any ICE server');
      },
    };

    let request: { url: string; init: RequestInit } | undefined;
    const received = await requestAnswer(
      peer satisfies OfferPeer,
      '/api/channels/7/offer',
      async (url, init) => {
        request = { url, init };
        return { ok: true, status: 200, json: async () => answer };
      },
    );

    expect(request?.url).toBe('/api/channels/7/offer');
    expect(request?.init.method).toBe('POST');
    expect(JSON.parse(request?.init.body as string)).toStrictEqual(offer);
    expect(peer.iceGatheringState, 'posted before gathering finished').toBe('gathering');
    expect(received).toStrictEqual(answer);
  });

  it('exposes the HTTP status of a rejected offer', async () => {
    const peer: OfferPeer = {
      async createOffer() {
        return { type: 'offer', sdp: 'v=0\r\n' };
      },
      async setLocalDescription() {
        // Accepted; the answer is what fails.
      },
    };

    const rejection = requestAnswer(peer, '/api/channels/7/offer', async () => ({
      ok: false,
      status: 503,
      json: async () => ({
        error: { code: 'no_video', message: 'No video has reached this channel yet.' },
      }),
    }));

    await expect(rejection).rejects.toThrow('HTTP 503');
    await expect(rejection).rejects.toMatchObject({ status: 503 });
  });
});

describe('isRetryable', () => {
  it('treats only an explicit client rejection as permanent', () => {
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable(new Error('network error'))).toBe(true);
    expect(isRetryable(undefined)).toBe(true);
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 415 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });
});
