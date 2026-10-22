import type { VfConnection } from './vf-connection';
import { VfConnections } from './vf-connections';

/** Just enough of a peer connection for a VfConnection to start; its offer never gets an answer. */
class IdlePeerConnection {
  static created = 0;
  constructor() {
    IdlePeerConnection.created += 1;
  }
  addTransceiver() {
    return { receiver: {} };
  }
  createDataChannel() {
    return { close: vi.fn() };
  }
  createOffer() {
    return new Promise(() => undefined);
  }
  readonly close = vi.fn();
}

describe('VfConnections', () => {
  let connections: VfConnections;

  beforeEach(() => {
    IdlePeerConnection.created = 0;
    vi.stubGlobal('RTCPeerConnection', IdlePeerConnection);
    connections = new VfConnections();
  });

  afterEach(() => {
    connections.closeAll();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function watchClose(connection: VfConnection) {
    return vi.spyOn(connection, 'close');
  }

  it('creates one connection per channel and shares it between holders', () => {
    const tile = connections.get(2);
    const preview = connections.get(2);
    const other = connections.get(5);

    expect(preview).toBe(tile);
    expect(other).not.toBe(tile);
    expect([tile.channel, other.channel]).toEqual([2, 5]);
    expect(IdlePeerConnection.created).toBe(2);
  });

  it('closes a connection only when its last holder releases it', () => {
    const connection = connections.get(2);
    connections.get(2);
    const close = watchClose(connection);

    connections.release(2);
    expect(close).not.toHaveBeenCalled();
    connections.release(2);
    expect(close).toHaveBeenCalledOnce();

    // Released for good: a stray release is harmless and the next get connects afresh.
    connections.release(2);
    expect(connections.get(2)).not.toBe(connection);
  });

  it('closes every connection on closeAll and when the providing page is destroyed', () => {
    const first = watchClose(connections.get(1));
    connections.get(2);
    const second = watchClose(connections.get(2));

    connections.closeAll();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    const third = watchClose(connections.get(3));
    connections.ngOnDestroy();
    expect(third).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
  });

  it('applies the debug option to the connections it holds and to those it creates later', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const existing = connections.get(1);
    const setDebug = vi.spyOn(existing, 'setDebug');

    connections.setDebug(true);
    expect(setDebug).toHaveBeenCalledWith(true);
    expect(log).not.toHaveBeenCalled();

    connections.get(2);
    expect(log).toHaveBeenCalledWith('[viewer][ch2]', 'connect start', expect.anything());

    connections.setDebug(false);
    expect(setDebug).toHaveBeenLastCalledWith(false);
  });
});
