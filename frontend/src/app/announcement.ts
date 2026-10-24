import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * A status line said to screen readers and never shown: `<app-announcement>{{ text }}</app-announcement>`.
 * The host is the live region (`role="status"`), always in the DOM, so a screen reader hears its
 * text as it changes. For news the screen already shows another way (System Info refreshed, a
 * scan running), where a visible line would repeat it. The app has no Tailwind setup, so the
 * kit's `sr-only` utility cannot be used from here; this is the app's one copy of the rule.
 */
@Component({
  selector: 'app-announcement',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'status' },
  template: '<ng-content />',
  styleUrl: './announcement.css',
})
export class Announcement {}
