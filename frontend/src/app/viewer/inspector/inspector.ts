import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  lateNoticeDetails,
  type NeatLatenessSnapshot,
  NeatButton,
  NeatTab,
  NeatTabs,
  NeatTooltip,
  NeatVideoTile,
} from '@sima/neat-ui';
import { ChannelLateness } from '../channel-lateness';
import type { NumericSettingId, SettingTab } from '../settings/schema';
import { type SettingsScope, ViewerSettingsStore } from '../settings/viewer-settings.store';
import { formatChannelStatus } from '../vf/channel-status';
import type { VfConnection } from '../vf/vf-connection';
import { VfConnections } from '../vf/vf-connections';
import { LateNotice, type RaiseTarget } from './late-notice';
import { type SettingControl, SettingRow } from './setting-row';

/** The tabs plan 2a fills; ROI and 3D Pose follow in plan 2b. */
const TABS = ['Metadata', 'General'] as const satisfies readonly SettingTab[];

interface MetadataSection {
  readonly heading: string;
  readonly settings: readonly SettingControl[];
  readonly note?: string;
}

const fraction = (value: number) => value.toFixed(2);
const milliseconds = (value: number) => `${value} ms`;

function confidence(
  id: Extract<NumericSettingId, `${string}.confidenceThreshold`>,
): SettingControl {
  return {
    control: 'slider',
    id,
    label: 'Confidence threshold',
    min: 0,
    max: 1,
    step: 0.01,
    describe: fraction,
  };
}

/*
 * The old dialog's controls and ranges (Inv §5b, §5e), in its order. On/off settings are
 * switches; values between bounds a pointer can cover are sliders (fractions, line width, trail
 * length); durations of up to seconds, which want an exact figure, are number fields in ms.
 */
const METADATA_SECTIONS: readonly MetadataSection[] = [
  {
    heading: 'Object detection',
    settings: [
      { control: 'switch', id: 'types.object-detection.visible', label: 'Show overlay' },
      confidence('types.object-detection.confidenceThreshold'),
    ],
  },
  {
    heading: 'Segmentation',
    settings: [
      { control: 'switch', id: 'types.segmentation.visible', label: 'Show overlay' },
      confidence('types.segmentation.confidenceThreshold'),
      {
        control: 'slider',
        id: 'types.segmentation.maskOpacity',
        label: 'Mask opacity',
        min: 0,
        max: 1,
        step: 0.05,
        describe: fraction,
      },
    ],
  },
  {
    heading: 'Tracking',
    settings: [
      { control: 'switch', id: 'types.tracking.visible', label: 'Show overlay' },
      confidence('types.tracking.confidenceThreshold'),
      { control: 'switch', id: 'types.tracking.history.enabled', label: 'Show track history' },
      {
        control: 'slider',
        id: 'types.tracking.history.trailLength',
        label: 'Trail length',
        min: 1,
        max: 60,
        step: 1,
        describe: (value) => `${value} positions`,
        requires: 'types.tracking.history.enabled',
      },
      {
        control: 'number',
        id: 'types.tracking.history.lostTrackTtlMs',
        label: 'Keep lost tracks for',
        min: 0,
        max: 10000,
        step: 250,
        unit: 'ms',
        describe: milliseconds,
        requires: 'types.tracking.history.enabled',
      },
    ],
  },
  {
    heading: 'Pose',
    settings: [
      { control: 'switch', id: 'types.pose-estimation.visible', label: 'Show overlay' },
      { control: 'switch', id: 'types.pose-estimation.showKeypoints', label: 'Show joint markers' },
      {
        control: 'switch',
        id: 'types.pose-estimation.showKeypointLabels',
        label: 'Show landmark names',
      },
    ],
    note: 'Landmark names are off by default to keep the video overlay readable.',
  },
  {
    heading: 'Classification',
    settings: [{ control: 'switch', id: 'types.classification.visible', label: 'Show overlay' }],
  },
];

const GENERAL_SETTINGS: readonly SettingControl[] = [
  {
    control: 'number',
    id: 'general.videoSyncBufferMs',
    label: 'Video sync buffer',
    min: 0,
    max: 4000,
    step: 50,
    unit: 'ms',
    describe: milliseconds,
  },
  {
    control: 'number',
    id: 'general.metadataRetentionMs',
    label: 'Metadata retention',
    min: 0,
    max: 30000,
    step: 250,
    unit: 'ms',
    hint: '0 = no expiry',
    describe: (value) => (value === 0 ? 'no expiry' : milliseconds(value)),
  },
  {
    control: 'slider',
    id: 'general.lineWidth',
    label: 'Line width',
    min: 1,
    max: 10,
    step: 1,
    describe: (value) => `${value} px`,
  },
];

/** The status line's lateness: unknown without a grid tile, then what its window holds. */
function describeLateness(snapshot: NeatLatenessSnapshot | null | undefined): string {
  if (snapshot === undefined) return '—';
  if (snapshot === null || snapshot.recentLateShare === null) return 'Not measured yet';
  const share = `${Math.round(snapshot.recentLateShare * 100)} % late`;
  const median = snapshot.recentLatenessMedianMs;
  return median === null ? share : `${share}, ~${Math.round(median)} ms after its frame`;
}

/**
 * The Viewer's side panel. With no channel selected it edits the global settings ("All
 * channels"); with one selected it shows that channel's live preview, its status and its settings,
 * where a change becomes the channel's override. The General tab carries the late notice while the
 * channel's grid tile warns of late metadata.
 *
 * The preview is a second kit tile on the channel's one connection, held like the grid tile holds
 * it, so selecting a channel opens no second peer connection. Its stats and lateness are not used:
 * the grid tile reports for the channel (`ChannelLateness`).
 *
 * Escape inside the panel and the ✕ ask the page to close it, which returns focus to the grid.
 */
@Component({
  selector: 'app-viewer-inspector',
  imports: [LateNotice, NeatButton, NeatTab, NeatTabs, NeatTooltip, NeatVideoTile, SettingRow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'region',
    'aria-labelledby': 'viewer-inspector-title',
    '(keydown)': 'onKeydown($event)',
  },
  templateUrl: './inspector.html',
  styleUrl: './inspector.css',
})
export class ViewerInspector {
  /** The selected channel; null for all channels. */
  readonly channel = input.required<number | null>();
  /** The open tab, which the page also sets (the late chip opens General). */
  readonly tab = model.required<SettingTab>();
  /** Escape or the ✕: the page closes the panel. */
  readonly dismiss = output<void>();

  private readonly connections = inject(VfConnections);
  private readonly store = inject(ViewerSettingsStore);
  private readonly lateness = inject(ChannelLateness);
  private readonly titleElement = viewChild.required<ElementRef<HTMLElement>>('titleHeading');

  protected readonly metadataSections = METADATA_SECTIONS;
  protected readonly generalSettings = GENERAL_SETTINGS;

  protected readonly scope = computed<SettingsScope>(() => this.channel() ?? 'global');
  protected readonly title = computed(() => {
    const channel = this.channel();
    return channel === null ? 'All channels' : `Channel ${channel}`;
  });

  private readonly connection = signal<VfConnection | null>(null);
  private readonly sync = computed(() => {
    const channel = this.channel();
    return channel === null ? null : this.store.general(channel)();
  });

  /** What the preview tile shows; it changes with the channel's settings, not with its stats. */
  protected readonly preview = computed(() => {
    const channel = this.channel();
    const connection = this.connection();
    const sync = this.sync();
    if (channel === null || connection === null || sync === null) return null;
    return {
      channel,
      connection,
      settings: this.store.resolved(channel)(),
      retentionMs: sync.metadataRetentionMs,
    };
  });

  /** The channel's status lines, updated at most once per stats tick. */
  protected readonly status = computed(() => {
    const channel = this.channel();
    const connection = this.connection();
    const sync = this.sync();
    if (channel === null || connection === null || sync === null) return null;
    const buffer = connection.syncBuffer().supported
      ? `${sync.videoSyncBufferMs} ms`
      : `${sync.videoSyncBufferMs} ms (this browser cannot delay video)`;
    return {
      // While connecting the status line is empty; on a tile the label stands in for it.
      stream: formatChannelStatus(connection.status()) || 'Connecting',
      buffer,
      lateness: describeLateness(this.lateness.of(channel)()?.snapshot),
    };
  });

  /** The late notice, while the channel's grid tile warns of late metadata (Inv §4g). */
  protected readonly lateDetails = computed(() => {
    const channel = this.channel();
    const connection = this.connection();
    const sync = this.sync();
    if (channel === null || connection === null || sync === null) return null;
    const reading = this.lateness.of(channel)();
    if (reading === null || !reading.active || reading.snapshot === null) return null;
    return lateNoticeDetails(
      reading.snapshot,
      sync.videoSyncBufferMs,
      connection.syncBuffer().supported,
      this.store.value('global', 'general.videoSyncBufferMs'),
    );
  });

  constructor() {
    effect((onCleanup) => {
      const channel = this.channel();
      if (channel === null) {
        this.connection.set(null);
        return;
      }
      this.connection.set(this.connections.get(channel));
      onCleanup(() => this.connections.release(channel));
    });

    // The grid tile keeps the connection in step with the channel's settings, but the channel may
    // have no grid tile (paged away), and then the preview alone holds the connection, perhaps one
    // it created. Applying the same values twice changes nothing.
    effect(() => {
      const connection = this.connection();
      const bufferMs = this.sync()?.videoSyncBufferMs;
      if (connection !== null && bufferMs !== undefined) {
        untracked(() => connection.setSyncBuffer(bufferMs));
      }
    });
    effect(() => {
      const connection = this.connection();
      const retentionMs = this.sync()?.metadataRetentionMs;
      if (connection !== null && retentionMs !== undefined) {
        untracked(() => connection.setMetadataRetention(retentionMs));
      }
    });
  }

  protected selectTab(value: string | undefined): void {
    const tab = TABS.find((name) => name === value);
    if (tab !== undefined) this.tab.set(tab);
  }

  /**
   * The late notice's actions (Inv §4g): this channel's own buffer, or global raised without ever
   * lowering it. The grid tile sees the buffer change, resets its lateness window and drops the
   * warning, so the notice and the focused button go; focus stays in the panel, on its title.
   */
  protected raise(target: RaiseTarget): void {
    const channel = this.channel();
    const suggested = this.lateDetails()?.suggestedBufferMs ?? null;
    if (channel === null || suggested === null) return;
    if (target === 'channel') this.store.set(channel, 'general.videoSyncBufferMs', suggested);
    else this.store.raiseGlobal(channel, 'general.videoSyncBufferMs', suggested);
    this.titleElement().nativeElement.focus();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    this.dismiss.emit();
  }
}
