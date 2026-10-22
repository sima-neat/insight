import { Injectable } from '@angular/core';
import type { SettingTab } from './settings/schema';
import { START_POSITION, type ViewerParams, type ViewerPosition } from './viewer-state';

/**
 * What makes two Viewer links show the same view: the channel subset and the channel limit as the
 * link gives them. A link without `max_channels` takes the SDK's limit, which is the same for every
 * such link; a limit changed since is covered by the fallbacks for channels no longer shown.
 */
export type ViewerLink = Pick<ViewerParams, 'src' | 'maxChannels'>;

/** What the Viewer keeps of itself while another page is shown. */
export interface ViewerVisit {
  /** The link the visit showed; null before any visit. */
  readonly link: ViewerLink | null;
  readonly position: ViewerPosition;
  readonly inspectorTab: SettingTab;
}

function sameLink(a: ViewerLink | null, b: ViewerLink): boolean {
  return a !== null && a.src === b.src && a.maxChannels === b.maxChannels;
}

/**
 * Where the user left the Viewer, so that coming back from another page finds it as it was (the
 * spec's "layout, page, channel and settings survive navigation"; layout and settings outlive the
 * page through storage). Provided in root because the Viewer page, and everything it provides, is
 * created afresh on every visit. Kept in memory only: a reload starts on the first page.
 *
 * Connections are not kept: leaving the page still closes them.
 */
@Injectable({ providedIn: 'root' })
export class ViewerSession {
  /** The last visit as the page left it; before any, the first page on the Metadata tab. */
  lastVisit: ViewerVisit = { link: null, position: START_POSITION, inspectorTab: 'Metadata' };

  /**
   * Where a visit to `link` starts: the last visit's position when it showed the same link, else
   * the first page with nothing selected. The position of another view (another subset, order or
   * limit) would open the new one mid-grid on a channel picked for the old one.
   */
  startFor(link: ViewerLink): ViewerPosition {
    return sameLink(this.lastVisit.link, link) ? this.lastVisit.position : START_POSITION;
  }
}
