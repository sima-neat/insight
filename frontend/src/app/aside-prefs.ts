import { Injectable, signal, type WritableSignal } from '@angular/core';
import { type NeatAsideOpen, neatAsideOpen } from '@sima/neat-ui';
import { PrefixedStorage } from './prefixed-storage';

/** The pages whose side panel is remembered here; the Viewer keeps its own in its layout. */
export type AsidePage = 'streaming' | 'media' | 'peripherals' | 'stats';

const OPEN = 'open';
const CLOSED = 'closed';

/**
 * Whether Streaming's, Media's, Peripherals' and Stats' side panels are open: remembered per page,
 * across visits and reloads, as the Viewer remembers its own (`LayoutPrefs.inspector`). One rule
 * for all five pages.
 * Stored as `neat-insight:<page>:aside`; on a wide screen a panel is open until the user closes it,
 * as it was before anything was remembered. A narrow screen floats the panel over the page, so
 * there it starts closed and opening or closing it is not remembered (`neatAsideOpen`): a phone
 * must not overwrite what was chosen on a wide screen.
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

  private remember(page: AsidePage, open: boolean): void {
    if (this.state[page]() === open) return;
    this.state[page].set(open);
    this.storage.set(`${page}:aside`, open ? OPEN : CLOSED);
  }

  private read(page: AsidePage): boolean {
    return this.storage.get(`${page}:aside`) !== CLOSED;
  }
}
