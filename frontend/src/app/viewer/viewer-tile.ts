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
import { type NeatFrameStats, type NeatTileState, NeatVideoTile } from '@sima/neat-ui';
import { LateChip } from './late-chip';
import { ViewerSettingsStore } from './settings/viewer-settings.store';
import { formatChannelStatus } from './vf/channel-status';
import type { VfConnection } from './vf/vf-connection';
import { VfConnections } from './vf/vf-connections';

/**
 * One channel of the Viewer grid: the kit's video tile fed by the channel's vf connection and its
 * resolved settings. It holds the connection for as long as it exists, so a tile paged away
 * releases it, and it is where the connection meets the tile: the sync buffer and retention are
 * applied when they change, the tile's frame stats go back to the connection for vf's egress
 * report, and each stats tick decides the "Metadata late" chip.
 *
 * The page owns selection; the tile only shows it.
 */
@Component({
  selector: 'app-viewer-tile',
  imports: [NeatVideoTile],
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
        <button neatTileChip type="button" class="late-chip" (click)="lateNotice.emit()">
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

  constructor() {
    effect((onCleanup) => {
      const channel = this.channel();
      this.connection.set(this.connections.get(channel));
      onCleanup(() => this.connections.release(channel));
    });

    // Separate from retention: the connection re-applies its jitter buffer target on every call,
    // and a retention change must not reset the lateness measured for an unchanged buffer.
    let appliedBufferMs: number | null = null;
    effect(() => {
      const connection = this.connection();
      const bufferMs = this.syncBufferMs();
      if (connection === null) return;
      untracked(() => {
        connection.setSyncBuffer(bufferMs);
        if (appliedBufferMs !== null && appliedBufferMs !== bufferMs) {
          this.lateChip.bufferChanged(this.tile(), appliedBufferMs, bufferMs, performance.now());
          this.lateActive.set(false);
        }
        appliedBufferMs = bufferMs;
      });
    });

    effect(() => {
      const connection = this.connection();
      const retentionMs = this.retentionMs();
      untracked(() => connection?.setMetadataRetention(retentionMs));
    });
  }

  protected onStateChange(state: NeatTileState): void {
    this.playing.set(state === 'playing');
    // A new stream (or none) has measured nothing yet.
    if (state === 'empty') {
      this.lateChip.reset();
      this.lateActive.set(false);
    }
  }

  /** The tile's once-a-second stats: vf's egress report gets them, and the late chip is judged. */
  protected onFrameStats(stats: NeatFrameStats): void {
    this.connection()?.reportFrameStats(stats);
    this.lateActive.set(this.lateChip.tick(this.tile(), performance.now()));
  }
}
