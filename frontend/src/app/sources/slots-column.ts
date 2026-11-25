import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ListColumn } from '../list-column';
import { SlotsNotice } from './slots-notice';

/**
 * The main column of a page that lists things about the slots, Streaming's slots and Media's
 * files: the stale-status notice (`app-slots-notice`), then the page's list, laid out by
 * `app-list-column`: `<app-slots-column><neat-select-list …/></app-slots-column>`. The content is
 * one element.
 */
@Component({
  selector: 'app-slots-column',
  imports: [ListColumn, SlotsNotice],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<app-list-column><app-slots-notice /><ng-content /></app-list-column>',
  styleUrl: './slots-column.css',
})
export class SlotsColumn {}
