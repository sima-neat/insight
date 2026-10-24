import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A text field under its visible name: `<app-field label="Stream URL"><input neatInput …>
 * </app-field>`. The field sits inside the label, which names it, and a click on the name focuses
 * it; the kit's select shows its name the same way (`showLabel`).
 */
@Component({
  selector: 'app-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The rule cannot see a control projected into the label, which is how this one gets its own.
  template: `
    <!-- eslint-disable-next-line @angular-eslint/template/label-has-associated-control -->
    <label
      ><span>{{ label() }}</span
      ><ng-content
    /></label>
  `,
  styleUrl: './field-label.css',
})
export class FieldLabel {
  readonly label = input.required<string>();
}
