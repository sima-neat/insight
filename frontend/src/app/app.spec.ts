import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { App } from './app';
import { appConfig } from './app.config';

describe('App', () => {
  it('frames the routed page in the kit shell with the app name and the Insight rail', async () => {
    TestBed.configureTestingModule({ providers: appConfig.providers });
    const fixture = TestBed.createComponent(App);
    await TestBed.inject(Router).navigateByUrl('/viewer');
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;

    expect(root.querySelector('neat-shell')?.textContent).toContain('Neat Insight');
    expect(Array.from(root.querySelectorAll('nav a'), (a) => a.textContent?.trim())).toEqual([
      'Media',
      'Streaming',
      'Viewer',
      'Peripherals',
      'Stats',
    ]);
    expect(root.querySelector('neat-shell app-viewer-page')).not.toBeNull();
  });
});
