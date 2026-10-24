import { Injectable, signal, type WritableSignal } from '@angular/core';
import { PrefixedStorage } from './prefixed-storage';

/** The pages whose side panel is remembered here; the Viewer keeps its own in its layout. */
export type AsidePage = 'streaming' | 'media' | 'peripherals';

const OPEN = 'open';
const CLOSED = 'closed';

/**
 * Whether Streaming's, Media's and Peripherals' side panels are open: remembered per page, across
 * visits and reloads, as the Viewer remembers its own (`LayoutPrefs.inspector`). One rule for all
 * four pages.
 * Stored as `neat-insight:<page>:aside`; a panel is open until the user closes it, as it was before
 * anything was remembered.
 */
@Injectable({ providedIn: 'root' })
export class AsidePrefs {
  private readonly storage = new PrefixedStorage('neat-insight:');
  private readonly state: Record<AsidePage, WritableSignal<boolean>> = {
    streaming: signal(this.read('streaming')),
    media: signal(this.read('media')),
    peripherals: signal(this.read('peripherals')),
  };

  /** Whether `page`'s side panel is open. */
  open(page: AsidePage): boolean {
    return this.state[page]();
  }

  setOpen(page: AsidePage, open: boolean): void {
    if (this.state[page]() === open) return;
    this.state[page].set(open);
    this.storage.set(`${page}:aside`, open ? OPEN : CLOSED);
  }

  private read(page: AsidePage): boolean {
    return this.storage.get(`${page}:aside`) !== CLOSED;
  }
}
