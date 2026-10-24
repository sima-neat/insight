import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * A failure said in place, under the form or the work it belongs to:
 * `<app-error-note role="alert">{{ message }}</app-error-note>`. The words and the role are the
 * caller's; a message of several lines (a server's diagnostics) keeps its line breaks.
 */
@Component({
  selector: 'app-error-note',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<ng-content />',
  styleUrl: './error-note.css',
})
export class ErrorNote {}
