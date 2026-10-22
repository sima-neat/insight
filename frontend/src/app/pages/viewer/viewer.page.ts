import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  type ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import {
  fitAllTileWidth,
  NeatButton,
  NeatIcon,
  NeatInput,
  NeatPage,
  NeatPageToolbar,
  NeatSegmented,
  type NeatSegmentedOption,
  NeatSlider,
  NeatSwitch,
  type NeatTileArea,
  type NeatTileAspect,
  NeatTileGrid,
  type NeatTileLayout,
  NeatTooltip,
  ThemeService,
} from '@sima/neat-ui';
import { map } from 'rxjs';
import { ChannelLiveness } from '../../viewer/channel-liveness';
import { LayoutPrefs } from '../../viewer/settings/layout-prefs';
import type { SettingTab } from '../../viewer/settings/schema';
import { ViewerStorage } from '../../viewer/settings/storage';
import { ViewerSettingsStore } from '../../viewer/settings/viewer-settings.store';
import { VfConnections } from '../../viewer/vf/vf-connections';
import {
  MAX_CHANNELS,
  normalizeMaxChannels,
  parseChannelIndices,
  readViewerParams,
  ViewerState,
} from '../../viewer/viewer-state';
import { ViewerTile } from '../../viewer/viewer-tile';

const SHAPES: readonly NeatSegmentedOption<NeatTileAspect>[] = [
  { value: '16:9', label: '16:9', icon: 'aspect-wide' },
  { value: '1:1', label: '1:1', icon: 'aspect-square' },
];

/** The narrowest tile the size slider offers, in CSS pixels; below it a stream is unreadable. */
const MIN_TILE_WIDTH = 120;

/**
 * The space between tiles, in CSS pixels, given to the grid explicitly: the fit-all width has to be
 * worked out with the gap the grid packs with, and the grid's layout does not report its own. 8 px
 * is the kit's default gap (`--neat-space-2`) at the browser's default font size.
 */
const TILE_GAP_PX = 8;

/** The viewer storage name of the console-set debug flag (Inv §4c's `viewerDebug`). */
const DEBUG_FLAG = 'debug';

/**
 * Where the page's key shortcuts stay out of the way: controls that take these keys themselves
 * (text fields, the slider's arrows) and the inspector, whose controls Task 11 fills in.
 */
const OWN_KEYS = 'input, select, textarea, [contenteditable], [role="slider"], [neatPageAside]';

function sameArea(a: NeatTileArea | null, b: NeatTileArea | null): boolean {
  return a === null || b === null ? a === b : a.width === b.width && a.height === b.height;
}

/**
 * The Viewer: every channel the link and the channel limit allow, as video tiles packed into the
 * content area at the size the slider sets, with pages for what does not fit. Its controls sit in
 * the shell's top bar (or kiosk mode's floating bar, which re-creates them, so their state lives
 * here), and the inspector opens beside the grid.
 *
 * The page owns the channel connections, the settings and the layout choices for as long as it is
 * shown; leaving it closes every connection.
 */
@Component({
  selector: 'app-viewer-page',
  imports: [
    NeatButton,
    NeatIcon,
    NeatInput,
    NeatPage,
    NeatPageToolbar,
    NeatSegmented,
    NeatSlider,
    NeatSwitch,
    NeatTileGrid,
    NeatTooltip,
    ViewerTile,
  ],
  providers: [VfConnections, ViewerSettingsStore, LayoutPrefs, ChannelLiveness],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'onKeydown($event)' },
  templateUrl: './viewer.page.html',
  styleUrl: './viewer.page.css',
})
export class ViewerPage {
  protected readonly prefs = inject(LayoutPrefs);
  private readonly connections = inject(VfConnections);
  private readonly liveness = inject(ChannelLiveness);
  private readonly storage = inject(ViewerStorage);
  private readonly theme = inject(ThemeService);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly shapes = SHAPES;
  protected readonly minTileWidth = MIN_TILE_WIDTH;
  protected readonly gap = TILE_GAP_PX;

  private readonly params = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map(readViewerParams)),
    { requireSync: true },
  );
  /** Flask's channel limit (`/api/viewer-url`), for a link without `max_channels`. */
  private readonly serverLimit = signal<number | null>(null);
  private serverLimitRequested = false;
  private readonly limit = computed(() => this.params().maxChannels ?? this.serverLimit());

  /** The channels the link and the limit allow, in `src` order; null until the limit is known. */
  private readonly configured = computed(() => {
    const limit = this.limit();
    return limit === null ? null : parseChannelIndices(this.params().src, limit);
  });

  /** What the grid shows: the configured channels, only the live ones while "Hide empty" is on. */
  private readonly channels = computed<readonly number[]>(() => {
    const configured = this.configured() ?? [];
    if (!this.prefs.hideEmpty()) return configured;
    const live = this.liveness.live();
    return live === null ? [] : configured.filter((channel) => live.has(channel));
  });

  protected readonly state = new ViewerState(this.channels);
  /** The channel the inspector shows; null for all channels. */
  readonly selectedChannel = this.state.selected.asReadonly();
  /** The inspector's open tab: the late chip opens General, where the raise actions are. */
  readonly inspectorTab = signal<SettingTab>('Metadata');

  /** The grid's content box, from its layout; null until it has measured itself. */
  private readonly area = signal<NeatTileArea | null>(null, { equal: sameArea });

  /**
   * The size the user chose for this many channels, else the size at which all of them fit on one
   * page, which follows the area until the user moves the slider.
   */
  protected readonly tileWidth = computed(() => {
    const count = this.channels().length;
    const stored = this.prefs.tileWidthFor(count);
    if (stored !== null) return stored;
    const area = this.area();
    // Any width does before the first measurement: the grid shows nothing until it has one.
    if (area === null) return MIN_TILE_WIDTH;
    return fitAllTileWidth(area, count, this.prefs.aspect(), TILE_GAP_PX);
  });

  /** The slider ends where one tile fills the area. */
  protected readonly sliderMax = computed(() => {
    const area = this.area();
    if (area === null) return MIN_TILE_WIDTH;
    return Math.max(MIN_TILE_WIDTH, fitAllTileWidth(area, 1, this.prefs.aspect(), TILE_GAP_PX));
  });

  protected readonly channelRange = computed(() => {
    const limit = this.limit();
    return limit === null ? '' : `0–${limit - 1}`;
  });

  /** Why the grid is empty, once that is known. */
  protected readonly emptyText = computed(() => {
    const configured = this.configured();
    if (configured === null || this.channels().length > 0) return null;
    if (configured.length === 0) return 'The link selects no channels.';
    return this.liveness.live() === null ? null : 'No channel is receiving video.';
  });

  protected readonly inspectorTitle = computed(() => {
    const channel = this.state.selected();
    return channel === null ? 'All channels' : `Channel ${channel}`;
  });

  private readonly pageInput = viewChild<ElementRef<HTMLInputElement>>('pageInput');

  constructor() {
    effect(() => {
      if (this.params().maxChannels === null) untracked(() => this.requestServerLimit());
    });
    effect(() => {
      // For this page load only: a shared link must not change the user's stored choice.
      const mode = this.params().mode;
      if (mode !== null) untracked(() => this.theme.setScheme(mode, { persist: false }));
    });
    effect(() => {
      const debug = this.params().debug || this.storage.get(DEBUG_FLAG) === '1';
      untracked(() => this.connections.setDebug(debug));
    });
    effect(() => {
      const hideEmpty = this.prefs.hideEmpty();
      untracked(() => this.liveness.setEnabled(hideEmpty));
    });
    // Every connection ends with the page, whichever tiles still hold one.
    this.destroyRef.onDestroy(() => this.connections.closeAll());
  }

  protected onLayout(layout: NeatTileLayout): void {
    this.area.set({ width: layout.areaWidth, height: layout.areaHeight });
    this.state.perPage.set(layout.perPage);
  }

  protected rememberTileWidth(width: number): void {
    this.prefs.rememberTileWidth(this.channels().length, width);
  }

  protected goToPage(input: HTMLInputElement): void {
    this.state.goToPage(Number.parseInt(input.value, 10));
    this.showCurrentPage(input);
  }

  /** The field shows the page on screen again, whatever was typed into it. */
  protected showCurrentPage(input: HTMLInputElement): void {
    input.value = String(this.state.page() + 1);
  }

  protected jumpToChannel(input: HTMLInputElement): void {
    if (this.state.jumpToChannel(Number.parseInt(input.value, 10))) input.value = '';
  }

  protected toggleInspector(): void {
    this.prefs.setInspector(!this.prefs.inspector());
  }

  /** The late chip: the inspector opens on the channel's General tab, where it can be fixed. */
  protected openLateNotice(channel: number): void {
    this.state.select(channel);
    this.inspectorTab.set('General');
    this.prefs.setInspector(true);
  }

  /**
   * ArrowLeft and ArrowRight page, `g` goes to the page field, Escape clears the selection. Never
   * with a modifier (those belong to the browser and the system), and never for a key the focused
   * control takes itself, as the original viewer did (Inv §4b).
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    if (event.target instanceof Element && event.target.closest(OWN_KEYS)) return;
    switch (event.key) {
      case 'ArrowLeft':
        this.state.previous();
        break;
      case 'ArrowRight':
        this.state.next();
        break;
      case 'g': {
        const input = this.pageInput()?.nativeElement;
        if (input === undefined) return;
        // The g must not land in the field it focuses.
        event.preventDefault();
        input.focus();
        input.select();
        break;
      }
      case 'Escape':
        this.state.clearSelection();
        break;
    }
  }

  private requestServerLimit(): void {
    if (this.serverLimitRequested) return;
    this.serverLimitRequested = true;
    this.http
      .get<{ max_video_channels?: unknown }>('/api/viewer-url')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (answer) => this.serverLimit.set(normalizeMaxChannels(answer.max_video_channels)),
        // The answer only limits the channels: without it, all of vf's slots, as before limits.
        error: () => this.serverLimit.set(MAX_CHANNELS),
      });
  }
}
