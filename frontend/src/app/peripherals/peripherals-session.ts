import { Injectable } from '@angular/core';
import type { CameraModeChoice } from './api';

/** A preview the user left running when leaving Peripherals, to start again on coming back. */
export interface PreviewResume {
  cameraId: string;
  mode: CameraModeChoice;
  /** The board generation it ran on; another board's camera is not started. */
  generation: number;
}

/**
 * Where the user left Peripherals, so that coming back from another page finds it as it was.
 * Provided in root because the page is created afresh on every visit; kept in memory only, so a
 * reload starts over, as #170 did (Inv-PB §3.1). Like `SourcesSession` for Streaming and Media.
 */
@Injectable({ providedIn: 'root' })
export class PeripheralsSession {
  /** The selected device's item id; null before the first selection. */
  selectedId: string | null = null;
  /** The mode the user picked per camera, by item id; a camera without one uses its default. */
  readonly modes = new Map<string, CameraModeChoice>();
  /** Leaving Peripherals stops its preview and coming back starts it again (spec). */
  resume: PreviewResume | null = null;
  /**
   * Settles once the previews of the visits left so far are stopped, starts still in flight
   * included (`CameraPreview.release`). The next visit waits for it before it reads the running
   * preview and starts `resume`: the old start may still be running on the board.
   */
  leaving: Promise<void> = Promise.resolve();
}
