import { Injectable } from '@angular/core';
import type { SettingTab } from './settings/schema';
import { START_POSITION, type ViewerPosition } from './viewer-state';

/** What the Viewer keeps of itself while another page is shown. */
export interface ViewerVisit {
  readonly position: ViewerPosition;
  readonly inspectorTab: SettingTab;
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
  lastVisit: ViewerVisit = { position: START_POSITION, inspectorTab: 'Metadata' };
}
