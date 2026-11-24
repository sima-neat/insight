import {
  computed,
  inject,
  Injectable,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { neatInsightChannel, type NeatInsightChannel } from '@sima/neat-ui/insight';
import { ViewerSettingsStore } from './settings/viewer-settings.store';

/** One channel as the Viewer holds it: the kit's connection to it, and the rate its tile counts. */
export interface ViewerChannel {
  /** The channel's video and metadata, the source of every tile that shows it. */
  readonly source: NeatInsightChannel;
  /** Valid metadata messages per second, as a tile showing the channel counts them. */
  readonly messagesPerSecond: WritableSignal<number>;
}

/**
 * The Viewer page's channels: one connection per channel (the kit's `neatInsightChannel`), shared
 * by everything that shows the channel (its grid tile, the inspector's preview). Provided by the
 * page, so the connections end with it; one ends sooner, once nothing holds it. Each follows its
 * channel's video sync buffer setting while it is open, and tells the console its steps while
 * debugging is on (the page's `debug=1`).
 */
@Injectable()
export class ViewerChannels {
  private readonly injector = inject(Injector);
  private readonly store = inject(ViewerSettingsStore);
  private readonly entries = new Map<number, { channel: ViewerChannel; holders: number }>();
  private debug = false;

  /** Turns console logging of connection steps on or off, for every channel. */
  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  /** The channel, connected on first use; every call must be paired with `release`. */
  get(channel: number): ViewerChannel {
    let entry = this.entries.get(channel);
    if (entry === undefined) {
      // Untracked: a holder asks from an effect, which must neither depend on the new connection's
      // signals nor create the connection's own effect inside its reactive context.
      entry = { channel: untracked(() => this.open(channel)), holders: 0 };
      this.entries.set(channel, entry);
    }
    entry.holders += 1;
    return entry.channel;
  }

  /** Lets go of the channel; its connection closes once nothing holds it. */
  release(channel: number): void {
    const entry = this.entries.get(channel);
    if (entry === undefined) return;
    entry.holders -= 1;
    if (entry.holders > 0) return;
    entry.channel.source.close();
    this.entries.delete(channel);
  }

  private open(channel: number): ViewerChannel {
    const prefix = `[viewer][ch${channel}]`;
    const source = runInInjectionContext(this.injector, () =>
      neatInsightChannel(channel, {
        videoBufferMs: computed(() => this.store.general(channel)().videoSyncBufferMs),
        log: (event, details) => {
          if (!this.debug) return;
          if (details === undefined) console.log(prefix, event);
          else console.log(prefix, event, details);
        },
      }),
    );
    return { source, messagesPerSecond: signal(0) };
  }
}
