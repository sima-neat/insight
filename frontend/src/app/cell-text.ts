import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * A list cell's text on one line, cut with an ellipsis rather than wrapped, so every row keeps the
 * list's row height and a column narrower than its text clips it in the cell. For the app's
 * `neatColumn` templates (Streaming's slots, Media's library).
 */
@Component({
  selector: 'app-cell-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<ng-content />',
  styleUrl: './cell-text.css',
})
export class CellText {}
