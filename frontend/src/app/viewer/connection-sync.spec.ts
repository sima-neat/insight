import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { followSyncSettings, type SyncTarget } from './connection-sync';
import type { SyncSettings } from './settings/schema';

class Target implements SyncTarget {
  readonly calls: string[] = [];
  setSyncBuffer(ms: number): void {
    this.calls.push(`buffer ${ms}`);
  }
}

describe('followSyncSettings', () => {
  it('applies the buffer to the connection when it changes, and to a new connection', () => {
    const first = new Target();
    const connection = signal<SyncTarget | null>(null);
    const sync = signal<SyncSettings | null>({ videoSyncBufferMs: 300, metadataRetentionMs: 0 });
    TestBed.runInInjectionContext(() => followSyncSettings(connection, sync));
    TestBed.tick();

    connection.set(first);
    TestBed.tick();
    expect(first.calls).toEqual(['buffer 300']);

    // A retention change must not re-apply the buffer.
    sync.set({ videoSyncBufferMs: 300, metadataRetentionMs: 2000 });
    TestBed.tick();
    sync.set({ videoSyncBufferMs: 500, metadataRetentionMs: 2000 });
    TestBed.tick();
    expect(first.calls).toEqual(['buffer 300', 'buffer 500']);

    const second = new Target();
    connection.set(second);
    TestBed.tick();
    expect(second.calls).toEqual(['buffer 500']);

    // No settings (no channel): nothing to apply.
    sync.set(null);
    TestBed.tick();
    expect(second.calls).toHaveLength(1);
  });
});
