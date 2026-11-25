import { Injectable, signal, type WritableSignal } from '@angular/core';
import { type NeatAsideOpen, neatAsideOpen } from '@sima/neat-ui';
import { PrefixedStorage } from './prefixed-storage';

/** The pages whose side panel is remembered here; the Viewer keeps its own with its layout. */
export type AsidePage = 'streaming' | 'media' | 'peripherals' | 'stats';

const OPEN = 'open';
const CLOSED = 'closed';

const openName = (page: AsidePage) => `${page}:aside`;
const widthName = (page: AsidePage) => `${page}:aside-width`;

/**
 * Whether Streaming's, Media's, Peripherals' and Stats' side panels are open, and how wide:
 * remembered per page, across visits and reloads, as the Viewer remembers its own
 * (`LayoutPrefs.inspector`, `LayoutPrefs.inspectorWidth`). Open is stored as the text `open` or
 * `closed` under `neat-insight:<page>:aside`, the width in pixels as text under
 * `neat-insight:<page>:aside-width`. Both are plain text, which the kit's `neatStoredSignal` (JSON)
 * cannot read: `open` and `closed` are not JSON.
 *
 * On a wide screen a panel is open until the user closes it. A narrow screen floats the panel over
 * the page, so there it starts closed and opening or closing it is not remembered
 * (`neatAsideOpen`): a phone must not overwrite what was chosen on a wide screen. That choice
 * lives as long as this root service, so a phone keeps an opened panel for the session; the
 * Viewer's inspector, owned by its page, starts closed on every visit.
 */
@Injectable({ providedIn: 'root' })
export class AsidePrefs {
  private readonly storage = new PrefixedStorage('neat-insight:');
  /** What each page remembers for wide screens. */
  private readonly state: Record<AsidePage, WritableSignal<boolean>> = {
    streaming: signal(this.read('streaming')),
    media: signal(this.read('media')),
    peripherals: signal(this.read('peripherals')),
    stats: signal(this.read('stats')),
  };
  /** The width each page's panel was dragged to, in pixels; null is the kit's default. */
  private readonly widths: Record<AsidePage, WritableSignal<number | null>> = {
    streaming: signal(this.readWidth('streaming')),
    media: signal(this.readWidth('media')),
    peripherals: signal(this.readWidth('peripherals')),
    stats: signal(this.readWidth('stats')),
  };
  private readonly panels: Record<AsidePage, NeatAsideOpen> = {
    streaming: neatAsideOpen(this.state.streaming, (open) => this.remember('streaming', open)),
    media: neatAsideOpen(this.state.media, (open) => this.remember('media', open)),
    peripherals: neatAsideOpen(this.state.peripherals, (open) =>
      this.remember('peripherals', open),
    ),
    stats: neatAsideOpen(this.state.stats, (open) => this.remember('stats', open)),
  };

  /** Whether `page`'s side panel is open. */
  open(page: AsidePage): boolean {
    return this.panels[page].open();
  }

  setOpen(page: AsidePage, open: boolean): void {
    this.panels[page].set(open);
  }

  /**
   * The width `page`'s panel was given, in pixels, or null for the default. It is the wide-screen
   * panel's: the kit gives a narrow screen's floating panel no separator, so no narrow screen
   * writes it.
   */
  width(page: AsidePage): number | null {
    return this.widths[page]();
  }

  /** Remembers `page`'s panel width; null, the default, forgets it. */
  setWidth(page: AsidePage, width: number | null): void {
    if (this.widths[page]() === width) return;
    this.widths[page].set(width);
    if (width === null) this.storage.remove(widthName(page));
    else this.storage.set(widthName(page), String(width));
  }

  private remember(page: AsidePage, open: boolean): void {
    if (this.state[page]() === open) return;
    this.state[page].set(open);
    this.storage.set(openName(page), open ? OPEN : CLOSED);
  }

  private read(page: AsidePage): boolean {
    return this.storage.get(openName(page)) !== CLOSED;
  }

  /**
   * The stored width, or null for the default. A value that is not a positive number (edited by
   * hand, or written by another version) is the default: the kit clamps any width it is given, so
   * only what cannot be a width has to be refused here.
   */
  private readWidth(page: AsidePage): number | null {
    const stored = this.storage.get(widthName(page));
    if (stored === null || stored.trim() === '') return null;
    const width = Number(stored);
    return Number.isFinite(width) && width > 0 ? width : null;
  }
}
