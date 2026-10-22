import { signal } from '@angular/core';
import type { NeatFrameStats } from '@sima/neat-ui';
import type { VfStatus } from './vf/channel-status';
import type { VfConnection } from './vf/vf-connection';
import type { VfConnections } from './vf/vf-connections';

/** A channel connection without WebRTC: its status is set by the test, its calls are recorded. */
export class FakeConnection {
  readonly status = signal<VfStatus>({
    phase: 'connecting',
    codec: null,
    width: null,
    height: null,
    fps: null,
    kbps: 0,
    messagesPerSecond: 0,
  });
  readonly stream = signal<MediaStream | null>(null);
  readonly syncBuffers: number[] = [];
  readonly retentions: number[] = [];
  readonly frameStats: NeatFrameStats[] = [];

  constructor(readonly channel: number) {}

  onMetadata(): () => void {
    return () => undefined;
  }

  setSyncBuffer(ms: number): void {
    this.syncBuffers.push(ms);
  }

  setMetadataRetention(ms: number): void {
    this.retentions.push(ms);
  }

  reportFrameStats(stats: NeatFrameStats): void {
    this.frameStats.push(stats);
  }
}

/**
 * Stands in for the page's `VfConnections`: one fake connection per channel, with the holders
 * counted as the real one counts them, and every release and closeAll recorded.
 */
export class FakeConnections {
  readonly connections = new Map<number, FakeConnection>();
  readonly holders = new Map<number, number>();
  readonly released: number[] = [];
  closedAll = 0;
  debug: boolean | null = null;

  /** Provide with `{ provide: VfConnections, useValue: fake.asVfConnections() }`. */
  asVfConnections(): VfConnections {
    return this as unknown as VfConnections;
  }

  get(channel: number): VfConnection {
    let connection = this.connections.get(channel);
    if (connection === undefined) {
      connection = new FakeConnection(channel);
      this.connections.set(channel, connection);
    }
    this.holders.set(channel, (this.holders.get(channel) ?? 0) + 1);
    return connection as unknown as VfConnection;
  }

  release(channel: number): void {
    this.released.push(channel);
    const holders = (this.holders.get(channel) ?? 0) - 1;
    if (holders > 0) this.holders.set(channel, holders);
    else this.holders.delete(channel);
  }

  closeAll(): void {
    this.closedAll += 1;
    this.holders.clear();
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  /** The channels something holds a connection to now, ascending. */
  held(): number[] {
    return [...this.holders.keys()].sort((a, b) => a - b);
  }
}
