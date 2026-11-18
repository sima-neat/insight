import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NeatStatusChipButton } from '@sima/neat-ui/status-chip';
import {
  type NeatFrameStats,
  type NeatLatenessSnapshot,
  type NeatTileState,
  NeatVideoTile,
} from '@sima/neat-ui/video';
import { ChannelLateness } from './channel-lateness';
import { ChannelPlayback } from './channel-playback';
import { followSyncSettings } from './connection-sync';
import { LateChip } from './late-chip';
import { ViewerSettingsStore } from './settings/viewer-settings.store';
import { formatChannelStatus } from './vf/channel-status';
import type { VfConnection } from './vf/vf-connection';
import { VfConnections } from './vf/vf-connections';

/**
 * One channel of the Viewer grid: the kit's video tile fed by the channel's connection and its
 * resolved settings. It holds the connection for as long as it exists, so a tile paged away
 * releases it, and it is where the connection meets the tile: the sync buffer is applied to the
 * connection and the retention to the tile when they change, the tile's frame stats go back to the
 * connection for its status line, and each stats tick decides the "Metadata late" chip, which it
 * also publishes for the inspector (`ChannelLateness`), as it does whether its video plays
 * (`ChannelPlayback`).
 *
 * The page owns selection; the tile only shows it.
 */
@Component({
  selector: 'app-viewer-tile',
  imports: [NeatStatusChipButton, NeatVideoTile],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'group',
    '[attr.aria-label]': '"Channel " + channel()',
    '[attr.aria-current]': 'selected() || null',
  },
  template: `
    <neat-video-tile
      [source]="connection()"
      [settings]="settings()"
      [retentionMs]="retentionMs()"
      [channel]="channel()"
      [label]="label()"
      [status]="status()"
      [bars]="bars()"
      [selected]="selected()"
      (stateChange)="onStateChange($event)"
      (frameStats)="onFrameStats($event)"
    >
      @if (lateShown()) {
        <button
          neatStatusChip
          neatTileChip
          tone="warning"
          type="button"
          (click)="lateNotice.emit()"
        >
          Metadata late
        </button>
      }
    </neat-video-tile>
  `,
  styleUrl: './viewer-tile.css',
})
export class ViewerTile {
  readonly channel = input.required<number>();
  readonly bars = input(true);
  readonly selected = input(false);
  /** The "Metadata late" chip was pressed: the page shows the channel's late notice. */
  readonly lateNotice = output<void>();

  private readonly connections = inject(VfConnections);
  private readonly store = inject(ViewerSettingsStore);
  private readonly lateness = inject(ChannelLateness);
  private readonly playback = inject(ChannelPlayback);
  private readonly tile = viewChild.required(NeatVideoTile);

  protected readonly connection = signal<VfConnection | null>(null);
  protected readonly settings = computed(() => this.store.resolved(this.channel())());
  private readonly sync = computed(() => this.store.general(this.channel())());
  protected readonly retentionMs = computed(() => this.sync().metadataRetentionMs);
  private readonly syncBufferMs = computed(() => this.sync().videoSyncBufferMs);
  protected readonly label = computed(() => String(this.channel()));
  protected readonly status = computed(() => {
    const connection = this.connection();
    return connection === null ? null : formatChannelStatus(connection.status());
  });

  private readonly lateChip = new LateChip();
  private readonly playing = signal(false);
  private readonly lateActive = signal(false);
  /** Late metadata matters only while there is video for it to be late for (Inv §4g). */
  protected readonly lateShown = computed(() => this.playing() && this.lateActive());
  /** The lateness window at the last stats tick of the current stream. */
  private readonly latenessSnapshot = signal<NeatLatenessSnapshot | null>(null);

  constructor() {
    effect((onCleanup) => {
      const channel = this.channel();
      this.connection.set(this.connections.get(channel));
      onCleanup(() => this.connections.release(channel));
    });

    followSyncSettings(this.connection, this.sync);

    // A new buffer makes the lateness measured with the old one meaningless (Inv §4g).
    let previousBufferMs: number | null = null;
    effect(() => {
      const bufferMs = this.syncBufferMs();
      untracked(() => {
        if (previousBufferMs !== null && previousBufferMs !== bufferMs) {
          this.lateChip.bufferChanged(this.tile(), previousBufferMs, bufferMs, performance.now());
          this.lateActive.set(false);
        }
        previousBufferMs = bufferMs;
      });
    });

    effect((onCleanup) => {
      const channel = this.channel();
      this.lateness.publish(channel, {
        active: this.lateShown(),
        snapshot: this.latenessSnapshot(),
      });
      onCleanup(() => this.lateness.clear(channel));
    });

    effect((onCleanup) => {
      const channel = this.channel();
      this.playback.publish(channel, this.playing());
      onCleanup(() => this.playback.clear(channel));
    });
  }

  protected onStateChange(state: NeatTileState): void {
    this.playing.set(state === 'playing');
    // A new stream (or none) has measured nothing yet.
    if (state === 'empty') {
      this.lateChip.reset();
      this.lateActive.set(false);
      this.latenessSnapshot.set(null);
    }
  }

  /** The tile's once-a-second stats: the status line gets them, and the late chip is judged. */
  protected onFrameStats(stats: NeatFrameStats): void {
    this.connection()?.reportFrameStats(stats);
    this.lateActive.set(this.lateChip.tick(this.tile(), performance.now()));
    // After the tick, which resets the window while a new buffer settles.
    this.latenessSnapshot.set(this.tile().snapshot());
  }
}
