import { Injectable } from '@angular/core';
import { PrefixedStorage } from '../../prefixed-storage';

/** Every viewer key in `localStorage` starts with this, so the viewer leaves other keys alone. */
const PREFIX = 'neat-insight:viewer:';

/**
 * The Viewer's part of `localStorage`, addressed by names below `neat-insight:viewer:`, with the
 * never-throwing reads and writes of `PrefixedStorage`.
 *
 * Provided in root because the session copy of refused writes has to outlive the Viewer page: the
 * page provides the stores that read through this, and they are created afresh on every visit.
 */
@Injectable({ providedIn: 'root' })
export class ViewerStorage extends PrefixedStorage {
  constructor() {
    super(PREFIX);
  }
}
