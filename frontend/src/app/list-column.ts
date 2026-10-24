import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The main column of a page with a list: what stands above the list (a notice, banners) as its
 * first element, taking the height it needs (none while empty), then the list as its second,
 * given the rest of the page's content box to scroll its rows inside:
 * `<app-list-column><app-slots-notice /><neat-select-list …/></app-list-column>`. For
 * `neat-page scroll="none"` pages (Streaming, Media, Peripherals). An element taken out of the
 * flow (`app-announcement`) may sit in it too.
 */
@Component({
  selector: 'app-list-column',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<ng-content />',
  styleUrl: './list-column.css',
})
export class ListColumn {}
