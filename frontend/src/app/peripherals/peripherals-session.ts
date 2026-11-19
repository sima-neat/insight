import { Injectable, signal } from '@angular/core';
import type { PreviewMode } from './api';

/** A preview the user left running when leaving Peripherals, to start again on coming back. */
export interface PreviewResume {
  cameraId: string;
  mode: PreviewMode;
  /** The id of the board it ran on; another board's camera is not started. */
  board: string;
}

/**
 * Where the user left Peripherals, so that coming back from another page finds it as it was.
 * Provided in root because the page is created afresh on every visit; kept in memory only, so a
 * reload starts over. Like `SourcesSession` for Streaming and Media.
 */
@Injectable({ providedIn: 'root' })
export class PeripheralsSession {
  /** The selected device's item id; null before the first selection. */
  selectedId: string | null = null;
  private readonly modesValue = signal<ReadonlyMap<string, PreviewMode>>(new Map());
  /**
   * The mode the user picked per camera, by item id; a camera without one uses its default. A
   * signal, since the page also sets it (a preview adopted as it opens) while that camera's panel
   * may already show.
   */
  readonly modes = this.modesValue.asReadonly();
  /** Leaving Peripherals stops its preview and coming back starts it again. */
  resume: PreviewResume | null = null;
  /**
   * Settles once the previews of the visits left so far are stopped, starts still in flight
   * included (`CameraPreview.release`). The next visit waits for it before it reads the running
   * preview and starts `resume`: the old start may still be running on the board.
   */
  leaving: Promise<void> = Promise.resolve();

  setMode(cameraId: string, mode: PreviewMode): void {
    this.modesValue.update((modes) => new Map(modes).set(cameraId, mode));
  }
}
