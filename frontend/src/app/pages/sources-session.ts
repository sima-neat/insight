import { Injectable, signal } from '@angular/core';

/** What Streaming keeps of itself while another page is shown. */
export interface StreamingVisit {
  /** The selected slot's index; null when the user cleared the selection. */
  readonly slot: number | null;
}

/** What Media keeps of itself while another page is shown. */
export interface MediaVisit {
  /** The folder the browser shows; '' is the root. */
  readonly folder: string;
  /** The file selected for the side panel. */
  readonly selected: string | null;
  /** The files ticked for deletion. */
  readonly checked: readonly string[];
}

/** The forms the source switch can show for an empty slot: a camera registers the slot as a webcam. */
export type EmptySourceForm = 'file' | 'url';

/**
 * Where the user left Streaming and Media, so that coming back from another page finds them as
 * they were: #170 kept the selected slot, the media folder and the selection across its tabs, all
 * its state living in one component (Inv-SM §1.0). Provided in root because the pages are created
 * afresh on every visit; kept in memory only, so a reload starts over, on src1 and at the media
 * root, as #170 did. The Viewer keeps its own (`ViewerSession`).
 */
@Injectable({ providedIn: 'root' })
export class SourcesSession {
  /** Streaming as the last visit left it; before any, src1 selected, as in #170. */
  streaming: StreamingVisit = { slot: 1 };
  /** Media as the last visit left it; before any, the root with nothing selected. */
  media: MediaVisit = { folder: '', selected: null, checked: [] };

  private readonly emptyForms = signal<ReadonlyMap<number, EmptySourceForm>>(new Map());

  /**
   * The source form the user left an empty slot on, so that coming back to it shows the form it
   * was left on: an empty slot has no file, camera or pull to tell. A signal, since the panel
   * derives the form it shows from it.
   */
  emptyForm(slot: number): EmptySourceForm | undefined {
    return this.emptyForms().get(slot);
  }

  rememberEmptyForm(slot: number, form: EmptySourceForm): void {
    this.emptyForms.update((all) => new Map(all).set(slot, form));
  }
}
