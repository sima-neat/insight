import { computed, linkedSignal, signal, type Signal, untracked } from '@angular/core';
import type { ParamMap } from '@angular/router';
import type { NeatColorScheme } from '@sima/neat-ui';

/** vf has exactly this many channel slots, 0 to 79 (Inv §2d). */
export const MAX_CHANNELS = 80;

/** `max_channels` as vf's slots allow it: a whole number from 1 to 80, else all 80 (Inv §4c). */
export function normalizeMaxChannels(value: unknown): number {
  const requested = Number(value);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_CHANNELS) {
    return MAX_CHANNELS;
  }
  return requested;
}

/**
 * The channels a `src` list names, below `maxChannels` and each once (Inv §4a). A missing `src`
 * means every channel; an empty one, none. Unlike 829ec7c, which sorted them, the list keeps the
 * order `src` gives, so a link can arrange its tiles.
 */
export function parseChannelIndices(
  src: string | null,
  maxChannels: unknown = MAX_CHANNELS,
): number[] {
  const limit = normalizeMaxChannels(maxChannels);
  if (src === null) return Array.from({ length: limit }, (_, index) => index);

  const channels = new Set<number>();
  for (const value of src.split(',')) {
    const channel = Number.parseInt(value, 10);
    if (Number.isInteger(channel) && channel >= 0 && channel < limit) channels.add(channel);
  }
  return [...channels];
}

/** The Viewer's URL parameters (Inv §4c), as the page acts on them. */
export interface ViewerParams {
  /** The channel subset, unparsed: `parseChannelIndices` needs the limit, which may come later. */
  readonly src: string | null;
  /** The channel limit the link carries, or null to ask Flask (`/api/viewer-url`). */
  readonly maxChannels: number | null;
  /** The colour scheme for this page load, or null to keep the user's own. */
  readonly mode: NeatColorScheme | null;
  /** Log connection events to the console. */
  readonly debug: boolean;
}

export function readViewerParams(params: ParamMap): ViewerParams {
  const maxChannels = params.get('max_channels');
  const mode = params.get('mode');
  return {
    src: params.get('src'),
    maxChannels: maxChannels === null ? null : normalizeMaxChannels(maxChannels),
    mode: mode === 'light' || mode === 'dark' ? mode : null,
    debug: params.get('debug') === '1',
  };
}

interface PagingSource {
  readonly channels: readonly number[];
  readonly perPage: number | null;
}

function pageCountOf(channels: number, perPage: number): number {
  return Math.max(1, Math.ceil(channels / perPage));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The Viewer's paging and selection over the channels it displays. `perPage` comes from the tile
 * grid's layout; until the grid has measured itself it is null and no page shows a channel, so no
 * connection is opened for a tile that is then paged away.
 */
export class ViewerState {
  /** How many tiles fit on screen, from the grid; null until it reports. */
  readonly perPage = signal<number | null>(null);
  /** The channel the inspector shows, or null for all channels. */
  readonly selected = signal<number | null>(null);

  /**
   * The current page, 0-based. When the channels or `perPage` change it is clamped into range,
   * except that a selected channel that was on screen stays on screen: the area shrinking (the
   * inspector opening, a smaller window) must not page the user away from what they inspect. A
   * selected channel the user had paged away from does not pull them back.
   */
  readonly page = linkedSignal<PagingSource, number>({
    source: () => ({ channels: this.channels(), perPage: this.perPage() }),
    computation: (next, previous) => {
      const current = previous?.value ?? 0;
      if (next.perPage === null) return current;
      const selected = untracked(this.selected);
      if (previous?.source.perPage != null && selected !== null) {
        const { channels, perPage } = previous.source;
        const wasShown = channels
          .slice(current * perPage, (current + 1) * perPage)
          .includes(selected);
        const index = next.channels.indexOf(selected);
        if (wasShown && index >= 0) return Math.floor(index / next.perPage);
      }
      return clamp(current, 0, pageCountOf(next.channels.length, next.perPage) - 1);
    },
  });

  readonly pageCount = computed(() => {
    const perPage = this.perPage();
    return perPage === null ? 1 : pageCountOf(this.channels().length, perPage);
  });

  /** The channels on the current page, in display order. */
  readonly pageChannels = computed(() => {
    const perPage = this.perPage();
    if (perPage === null) return [];
    const start = this.page() * perPage;
    return this.channels().slice(start, start + perPage);
  });

  /** @param channels the channels displayed, in order: the configured ones, filtered. */
  constructor(private readonly channels: Signal<readonly number[]>) {}

  next(): void {
    this.page.set(Math.min(this.page() + 1, this.pageCount() - 1));
  }

  previous(): void {
    this.page.set(Math.max(this.page() - 1, 0));
  }

  /** Goes to the 1-based `page`, clamped into range; anything but a whole number is ignored. */
  goToPage(page: number): void {
    if (!Number.isInteger(page)) return;
    this.page.set(clamp(page, 1, this.pageCount()) - 1);
  }

  /**
   * Goes to the page holding `channel` and selects it. A channel that is not displayed (outside
   * the subset or the limit, or hidden as empty) changes nothing.
   */
  jumpToChannel(channel: number): void {
    const perPage = this.perPage();
    const index = this.channels().indexOf(channel);
    if (perPage === null || index < 0) return;
    this.page.set(Math.floor(index / perPage));
    this.selected.set(channel);
  }

  select(channel: number): void {
    this.selected.set(channel);
  }

  clearSelection(): void {
    this.selected.set(null);
  }
}
