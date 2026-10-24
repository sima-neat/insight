import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SlotsNotice } from './slots-notice';

/**
 * The main column of a page that lists things about the slots, Streaming's slots and Media's
 * files: the stale-status notice (`app-slots-notice`), then the page's list, given the rest of the
 * page's content box to scroll its rows inside:
 * `<app-slots-column><neat-select-list …/></app-slots-column>`. The content is one element.
 */
@Component({
  selector: 'app-slots-column',
  imports: [SlotsNotice],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<app-slots-notice /><ng-content />',
  styleUrl: './slots-column.css',
})
export class SlotsColumn {}
