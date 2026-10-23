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
  linkedSignal,
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
  NeatPopover,
  NeatPopoverContent,
  NeatPopoverTrigger,
  NeatSlider,
  NeatSwitch,
  type NeatTileArea,
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
import { ViewerSession } from '../../viewer/viewer-session';
import {
  MAX_CHANNELS,
  normalizeMaxChannels,
  parseChannelIndices,
  readViewerParams,
  ViewerState,
} from '../../viewer/viewer-state';
import { ViewerTile } from '../../viewer/viewer-tile';

/** The narrowest tile the size slider offers, in CSS pixels; below it a stream is unreadable. */
const MIN_TILE_WIDTH = 120;

/**
 * Tiles per page that "Fit" steps through after fitting all: square grids, which fill a 16:9 area
 * evenly in both directions.
 */
const FIT_PRESETS: readonly number[] = [36, 25, 16, 9, 4, 1];

/** A step of "Fit": all the displayed channels on one page, or a number of tiles per page. */
type Fit = 'all' | number;

/** How the tooltip names a step. */
function describeFit(fit: Fit): string {
  return fit === 'all' ? 'fit all' : `fit ${fit}`;
}

/** The viewer storage name of the console-set debug flag (Inv §4c's `viewerDebug`). */
const DEBUG_FLAG = 'debug';

/**
 * Where the page's key shortcuts stay out of the way: controls that take these keys themselves
 * (text fields, the slider's arrows), the inspector, which has its own Escape, and the toolbar's
 * popovers, whose Escape closes them and nothing else. A dialog the page opens, such as a
 * confirmation, is modal: its buttons take the keys and nothing behind it does.
 */
const OWN_KEYS =
  'input, select, textarea, [contenteditable], [role="slider"], [neatPageAside], [role="dialog"], [role="alertdialog"]';

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
 * shown; leaving it closes every connection. Where the user was (page, selection, inspector tab)
 * goes to `ViewerSession` on leaving, and the next visit starts there.
 */
@Component({
  selector: 'app-viewer-page',
  imports: [
    NeatButton,
    NeatIcon,
    NeatInput,
    NeatPage,
    NeatPageToolbar,
    NeatPopover,
    NeatPopoverContent,
    NeatPopoverTrigger,
    NeatSlider,
    NeatSwitch,
    NeatTileGrid,
    NeatTooltip,
    ViewerInspector,
    ViewerTile,
  ],
  providers: [VfConnections, ViewerSettingsStore, LayoutPrefs, ChannelLiveness, ChannelLateness],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'onKeydown($event)', '(click)': 'deselectOnEmptySpace($event)' },
  templateUrl: './viewer.page.html',
  styleUrl: './viewer.page.css',
})
export class ViewerPage {
  protected readonly prefs = inject(LayoutPrefs);
  private readonly connections = inject(VfConnections);
  private readonly liveness = inject(ChannelLiveness);
  private readonly storage = inject(ViewerStorage);
  private readonly session = inject(ViewerSession);
  private readonly theme = inject(ThemeService);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

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
   * What the grid should show as far as it is known: the configured channels, only the live ones
   * while "Hide empty" is on, and null while the first ingest stats answer is awaited. If stats fail
   * before any answer every channel is shown, with a notice: an empty grid would say no channel has
   * video, which nobody knows. After an answer a failed poll keeps that answer's channels.
   */
  private readonly knownChannels = computed<readonly number[] | null>(() => {
    if (this.liveAwaited()) return null;
    const configured = this.configured() ?? [];
    const live = this.prefs.hideEmpty() ? this.liveness.live() : null;
    return live === null ? configured : configured.filter((channel) => live.has(channel));
  });

  /**
   * What the grid shows. While the first answer is awaited it keeps what it showed: on load that is
   * nothing, so no connection is opened per slot only to be closed a moment later, and after
   * switching "Hide empty" on mid-session the tiles stay, so the live ones keep their connections
   * instead of negotiating new ones when the answer comes. A link changed in place during that wait
   * (another `src` or limit) also keeps the old channels until the answer; the wait is one request.
   */
  private readonly channels = linkedSignal<readonly number[] | null, readonly number[]>({
    source: this.knownChannels,
    computation: (known, previous) => known ?? previous?.value ?? [],
  });

  /**
   * "Hide empty" is on but ingest stats are unavailable: the grid shows the last known live channels,
   * or every channel before any answer, and the page says why.
   */
  protected readonly liveUnknown = computed(
    () => this.prefs.hideEmpty() && this.liveness.unavailable(),
  );

  protected readonly state = new ViewerState(this.channels, this.session.startFor(this.params()));
  /** The channel the inspector shows; null for all channels. */
  readonly selectedChannel = this.state.selected.asReadonly();
  /** The inspector's open tab: the late chip opens General, where the raise actions are. */
  readonly inspectorTab = signal<SettingTab>(this.session.lastVisit.inspectorTab);

  /**
   * What the fit-all widths are worked out against: the grid's content box and the gap it packed
   * with, both from its layout. Null until it has measured itself, which is also when its tiles
   * first show, so the fit never needs a gap the grid has not reported.
   */
  private readonly space = signal<TileSpace | null>(null, { equal: sameSpace });

  /**
   * The size the user chose for this many channels: a width from the slider, or a fit from "Fit",
   * which follows the area like the default does. The default is the size at which all of them
   * fit on one page.
   */
  protected readonly tileWidth = computed(() => {
    const count = this.channels().length;
    const stored = this.prefs.tileWidthFor(count);
    if (stored !== null) return stored;
    const space = this.space();
    // Any width does before the first measurement: the grid shows nothing until it has one.
    if (space === null) return MIN_TILE_WIDTH;
    return fitAllTileWidth(space, this.storedFit() ?? count, space.gap);
  });

  /**
   * The fit remembered for the displayed count. One at or above the count (only from storage
   * edited by hand) would make tiles smaller than fitting all, so it is not used.
   */
  private readonly storedFit = computed(() => {
    const count = this.channels().length;
    const fit = this.prefs.fitFor(count);
    return fit !== null && fit < count ? fit : null;
  });

  /**
   * The steps of "Fit" for the displayed count: all, then the presets below the count. A preset
   * that comes out at the same tile width as the step before it (in a small area, say) is left
   * out, so every click changes the grid.
   */
  protected readonly fits = computed<Fit[]>(() => {
    const count = this.channels().length;
    if (count === 0) return [];
    const space = this.space();
    const fits: Fit[] = ['all'];
    let previous = space === null ? null : fitAllTileWidth(space, count, space.gap);
    for (const tiles of FIT_PRESETS) {
      if (tiles >= count) continue;
      if (space !== null) {
        const width = fitAllTileWidth(space, tiles, space.gap);
        if (width === previous) continue;
        previous = width;
      }
      fits.push(tiles);
    }
    return fits;
  });

  /** The step the grid is on; null while it shows a width chosen with the slider. */
  protected readonly currentFit = computed<Fit | null>(() => {
    const count = this.channels().length;
    if (this.prefs.tileWidthFor(count) !== null) return null;
    return this.storedFit() ?? 'all';
  });

  protected readonly fitLabel = computed(() => {
    const fit = this.currentFit();
    if (fit === null) return 'Fit';
    return fit === 'all' ? 'Fit all' : `Fit ${fit}`;
  });

  /** Fit is enabled exactly when a click would do something. */
  protected readonly canFit = computed(() => this.fitAfter(1) !== null);

  /**
   * The next step, which the accessible name (the visible label, the current step) does not carry,
   * against the kit tooltip's rule. Acceptable here: the button works fully without it (a tap
   * steps and the label shows where it went), keyboard and assistive technology get it as the
   * description on focus, and Shift has no touch equivalent anyway.
   */
  protected readonly fitTooltip = computed(() => {
    const next = this.fitAfter(1);
    return next === null ? null : `Next: ${describeFit(next)} (Shift: back)`;
  });

  /** The slider ends where one tile fills the area. */
  protected readonly sliderMax = computed(() => {
    const space = this.space();
    if (space === null) return MIN_TILE_WIDTH;
    return Math.max(MIN_TILE_WIDTH, fitAllTileWidth(space, 1, space.gap));
  });

  /**
   * Whether the "Go to channel" popover is open. The page holds it so that `/` can open it.
   */
  protected readonly channelJumpOpen = signal(false);

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
    effect(() => {
      // Only the link's channels can be selected; after the link changes in place (or the SDK's
      // limit was lowered since the visit a selection is remembered from) it is dropped rather
      // than inspected off the grid.
      const configured = this.configured();
      if (configured === null) return;
      untracked(() => {
        const selected = this.state.selected();
        if (selected !== null && !configured.includes(selected)) this.state.clearSelection();
      });
    });
    // Every connection ends with the page, whichever tiles still hold one.
    this.destroyRef.onDestroy(() => this.connections.closeAll());
    this.destroyRef.onDestroy(() => this.rememberVisit());
  }

  protected onLayout(layout: NeatTileLayout): void {
    this.space.set({ width: layout.areaWidth, height: layout.areaHeight, gap: layout.gap });
    this.state.perPage.set(layout.perPage);
  }

  protected rememberTileWidth(width: number): void {
    this.prefs.rememberTileWidth(this.channels().length, width);
  }

  /** "Fit": a click steps to the next step, a Shift+click to the one before. */
  protected cycleFit(event: MouseEvent): void {
    const next = this.fitAfter(event.shiftKey ? -1 : 1);
    if (next === null) return;
    const count = this.channels().length;
    if (next === 'all') this.prefs.forgetSize(count);
    else this.prefs.rememberFit(count, next);
  }

  /**
   * The step `step` away from the current one, going round; null when there is nothing to step
   * to. Steps are found by their tiles per page, so a remembered preset that is left out of the
   * steps (see `fits`) still steps to its neighbours. From a slider width, forward is fitting all
   * and back the last preset, as if the width sat just before "all".
   */
  private fitAfter(step: 1 | -1): Fit | null {
    const fits = this.fits();
    const current = this.currentFit();
    if (fits.length === 0) return null;
    if (current === null) return step === 1 ? fits[0] : fits[fits.length - 1];
    if (fits.length < 2) return null;
    const tiles = (fit: Fit) => (fit === 'all' ? Number.POSITIVE_INFINITY : fit);
    const ordered = step === 1 ? fits : [...fits].reverse();
    const next = ordered.find((fit) =>
      step === 1 ? tiles(fit) < tiles(current) : tiles(fit) > tiles(current),
    );
    return next ?? ordered[0];
  }

  protected goToPage(input: HTMLInputElement): void {
    this.state.goToPage(Number.parseInt(input.value, 10));
    this.showCurrentPage(input);
  }

  /** The field shows the page on screen again, whatever was typed into it. */
  protected showCurrentPage(input: HTMLInputElement): void {
    input.value = String(this.state.page() + 1);
  }

  /** Enter in the channel field: a displayed channel is gone to and the popover is done. */
  protected jumpToChannel(input: HTMLInputElement): void {
    if (this.state.jumpToChannel(Number.parseInt(input.value, 10))) this.channelJumpOpen.set(false);
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
   * A click into the grid area that lands on no tile (the gaps, the margin around the grid, the
   * notice) clears the selection, as Escape does; Escape is its keyboard equivalent, so the area
   * needs no key handler of its own. A tile's click selects it and bubbles here, so it is told
   * apart by where it started. The inspector is in the page but outside the grid area.
   */
  protected deselectOnEmptySpace(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('.grid-area') && !event.target.closest('app-viewer-tile')) {
      this.state.clearSelection();
    }
  }

  /**
   * ArrowLeft and ArrowRight page, `g` goes to the page field, `/` opens "Go to channel", Escape
   * clears the selection. Never with a modifier (those belong to the browser and the system), and
   * never for a key the focused control takes itself, as the original viewer did (Inv §4b). Shift
   * is no modifier for `/`: on many layouts (German among them) it is how that key is typed.
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      (event.shiftKey && event.key !== '/')
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
      // G as well, for Caps Lock: Shift+g never gets here.
      case 'g':
      case 'G': {
        const input = this.pageInput()?.nativeElement;
        if (input === undefined) return;
        // The g must not land in the field it focuses.
        event.preventDefault();
        input.focus();
        input.select();
        break;
      }
      case '/':
        // The slash must not land in the field the popover focuses.
        event.preventDefault();
        this.channelJumpOpen.set(true);
        break;
      case 'Escape':
        this.state.clearSelection();
        break;
    }
  }

  /** Hands where the user is to the next visit. */
  private rememberVisit(): void {
    const { src, maxChannels } = this.params();
    const link = { src, maxChannels };
    const previous = this.session.startFor(link);
    this.session.lastVisit = {
      link,
      position: {
        // A visit that left before showing any channel (the limit or the first ingest stats
        // answer still pending, no live channel) did not move from where the last one was.
        firstChannel: this.state.pageChannels()[0] ?? previous.firstChannel,
        selected: this.state.selected(),
      },
      inspectorTab: this.inspectorTab(),
    };
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
