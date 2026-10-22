import { HttpClient } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
  viewChildren,
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
import { ChannelLateness } from '../../viewer/channel-lateness';
import { ChannelLiveness } from '../../viewer/channel-liveness';
import { ViewerInspector } from '../../viewer/inspector/inspector';
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

/** The viewer storage name of the console-set debug flag (Inv §4c's `viewerDebug`). */
const DEBUG_FLAG = 'debug';

/**
 * Where the page's key shortcuts stay out of the way: controls that take these keys themselves
 * (text fields, the slider's arrows) and the inspector, which has its own Escape.
 */
const OWN_KEYS = 'input, select, textarea, [contenteditable], [role="slider"], [neatPageAside]';

/** The grid's content box and the gap between its tiles, in CSS pixels. */
interface TileSpace extends NeatTileArea {
  readonly gap: number;
}

function sameSpace(a: TileSpace | null, b: TileSpace | null): boolean {
  return a === null || b === null
    ? a === b
    : a.width === b.width && a.height === b.height && a.gap === b.gap;
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
    ViewerInspector,
    ViewerTile,
  ],
  providers: [VfConnections, ViewerSettingsStore, LayoutPrefs, ChannelLiveness, ChannelLateness],
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

  /** "Hide empty" is on and ingest stats have neither answered nor failed yet. */
  private readonly liveAwaited = computed(
    () => this.prefs.hideEmpty() && this.liveness.live() === null && !this.liveness.unavailable(),
  );

  /**
   * What the grid shows: the configured channels, only the live ones while "Hide empty" is on.
   * While the first ingest stats answer is awaited no channel is shown, since which are live is not
   * known: showing them all would open a connection per slot only to close most of them a moment
   * later. If stats fail before any answer every channel is shown, with a notice: an empty grid
   * would say no channel has video, which nobody knows. After an answer a failed poll keeps that
   * answer's channels on screen.
   */
  private readonly channels = computed<readonly number[]>(() => {
    if (this.liveAwaited()) return [];
    const configured = this.configured() ?? [];
    const live = this.prefs.hideEmpty() ? this.liveness.live() : null;
    return live === null ? configured : configured.filter((channel) => live.has(channel));
  });

  /**
   * "Hide empty" is on but ingest stats are unavailable: the grid shows the last known live channels,
   * or every channel before any answer, and the page says why.
   */
  protected readonly liveUnknown = computed(
    () => this.prefs.hideEmpty() && this.liveness.unavailable(),
  );

  protected readonly state = new ViewerState(this.channels);
  /** The channel the inspector shows; null for all channels. */
  readonly selectedChannel = this.state.selected.asReadonly();
  /** The inspector's open tab: the late chip opens General, where the raise actions are. */
  readonly inspectorTab = signal<SettingTab>('Metadata');

  /**
   * What the fit-all widths are worked out against: the grid's content box and the gap it packed
   * with, both from its layout. Null until it has measured itself, which is also when its tiles
   * first show, so the fit never needs a gap the grid has not reported.
   */
  private readonly space = signal<TileSpace | null>(null, { equal: sameSpace });

  /**
   * The size the user chose for this many channels, else the size at which all of them fit on one
   * page, which follows the area until the user moves the slider.
   */
  protected readonly tileWidth = computed(() => {
    const count = this.channels().length;
    const stored = this.prefs.tileWidthFor(count);
    if (stored !== null) return stored;
    const space = this.space();
    // Any width does before the first measurement: the grid shows nothing until it has one.
    if (space === null) return MIN_TILE_WIDTH;
    return fitAllTileWidth(space, count, this.prefs.aspect(), space.gap);
  });

  /** The slider ends where one tile fills the area. */
  protected readonly sliderMax = computed(() => {
    const space = this.space();
    if (space === null) return MIN_TILE_WIDTH;
    return Math.max(MIN_TILE_WIDTH, fitAllTileWidth(space, 1, this.prefs.aspect(), space.gap));
  });

  protected readonly channelRange = computed(() => {
    const limit = this.limit();
    return limit === null ? '' : `0–${limit - 1}`;
  });

  /** Why the grid is empty, once that is known. */
  protected readonly emptyText = computed(() => {
    const configured = this.configured();
    if (configured === null || this.liveAwaited() || this.channels().length > 0) return null;
    // Channels are only ever hidden by a known live set, so none of them is receiving video.
    return configured.length === 0
      ? 'The link selects no channels.'
      : 'No channel is receiving video.';
  });

  private readonly pageInput = viewChild<ElementRef<HTMLInputElement>>('pageInput');
  private readonly inspectorToggle = viewChild<ElementRef<HTMLButtonElement>>('inspectorToggle');
  private readonly tiles = viewChildren(ViewerTile, { read: ElementRef<HTMLElement> });
  private readonly injector = inject(Injector);

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
    this.space.set({ width: layout.areaWidth, height: layout.areaHeight, gap: layout.gap });
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
    this.state.jumpToChannel(Number.parseInt(input.value, 10));
  }

  protected toggleInspector(): void {
    this.prefs.setInspector(!this.prefs.inspector());
  }

  /**
   * Escape in the inspector or its close button. Focus goes back where the user works: the selected tile, or
   * with none on screen the toolbar button that opens the inspector again.
   */
  protected closeInspector(): void {
    this.prefs.setInspector(false);
    afterNextRender(
      () => {
        const index = this.state.pageChannels().indexOf(this.state.selected() ?? -1);
        // The tiles render in pageChannels order.
        const target = index < 0 ? this.inspectorToggle() : this.tiles()[index];
        target?.nativeElement.focus();
      },
      { injector: this.injector },
    );
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
      case 'ArrowRight': {
        const page = this.state.page();
        if (event.key === 'ArrowLeft') this.state.previous();
        else this.state.next();
        // The focused tile left with its page; keep keyboard focus in the grid, not on <body>.
        const fromTile = event.target instanceof Element && event.target.closest('app-viewer-tile');
        if (fromTile && this.state.page() !== page) this.focusFirstTile();
        break;
      }
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

  /** Focuses the first tile once the new page has rendered. */
  private focusFirstTile(): void {
    afterNextRender(() => this.tiles()[0]?.nativeElement.focus(), { injector: this.injector });
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
