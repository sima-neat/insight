import { Injectable, type OnDestroy } from '@angular/core';
import { VfConnection } from './vf-connection';

/**
 * The Viewer page's vf connections, one per channel, shared by everything that shows the channel
 * (its grid tile, the inspector's preview). Provided by the page rather than in root, so the
 * connections end with the page.
 */
@Injectable()
export class VfConnections implements OnDestroy {
  private readonly entries = new Map<number, { connection: VfConnection; holders: number }>();

  /** The channel's connection, created on first use; every call must be paired with `release`. */
  get(channel: number): VfConnection {
    let entry = this.entries.get(channel);
    if (entry === undefined) {
      entry = { connection: new VfConnection(channel), holders: 0 };
      this.entries.set(channel, entry);
    }
    entry.holders += 1;
    return entry.connection;
  }

  /** Lets go of the channel; its connection closes once nothing holds it. */
  release(channel: number): void {
    const entry = this.entries.get(channel);
    if (entry === undefined) return;
    entry.holders -= 1;
    if (entry.holders > 0) return;
    entry.connection.close();
    this.entries.delete(channel);
  }

  closeAll(): void {
    for (const { connection } of this.entries.values()) connection.close();
    this.entries.clear();
  }

  /** Angular destroys a component's providers with it, so leaving the page closes everything. */
  ngOnDestroy(): void {
    this.closeAll();
  }
}
