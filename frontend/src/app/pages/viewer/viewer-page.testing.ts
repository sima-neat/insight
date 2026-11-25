import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NeatShell } from '@sima/neat-ui';

/**
 * A ResizeObserver that reports only when a test says so, with the box that test chooses. Install
 * it with `vi.stubGlobal('ResizeObserver', FakeResizeObserver)` and reset `instances` per test.
 */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  /**
   * The observer of the Viewer's tile grid, which sets the tile layout: the newest one, since a
   * Viewer opened again after navigating away has a grid of its own.
   */
  static grid(): FakeResizeObserver {
    return FakeResizeObserver.instances
      .filter((observer) => observer.observed[0]?.tagName === 'NEAT-TILE-GRID')
      .at(-1)!;
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {
    // The kit's slider shares an observer and lets go of its element this way.
  }

  disconnect(): void {
    // Nothing to stop: the fake reports only when told to.
  }

  resize(width: number, height: number): void {
    const entry = { target: this.observed[0], contentRect: { width, height } };
    this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

/** The app frame, so the Viewer page's toolbar has a top bar to render into. */
@Component({
  imports: [NeatShell, RouterOutlet],
  template: `<neat-shell appName="Neat Insight" [navItems]="[]"><router-outlet /></neat-shell>`,
})
export class ViewerShell {}
