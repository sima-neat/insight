import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { NeatButton, NeatInput, NeatSlider, NeatSwitch, NeatTooltip } from '@sima/neat-ui';
import type { BooleanSettingId, NumericSettingId } from '../settings/schema';
import { type SettingsScope, ViewerSettingsStore } from '../settings/viewer-settings.store';

interface SettingBase {
  readonly label: string;
  /** An on/off setting this one only matters with, such as the trail under track history. */
  readonly requires?: BooleanSettingId;
}

/** An on/off setting, shown as a switch that carries its label. */
export interface SwitchSetting extends SettingBase {
  readonly control: 'switch';
  readonly id: BooleanSettingId;
}

/**
 * A number setting: on a slider with a readout of its value, or in a number field followed by its
 * unit. `min`, `max` and `step` are the control's, as the old dialog had them (Inv §5b); they may
 * be narrower than the range the store holds values to.
 */
export interface NumberSetting extends SettingBase {
  readonly control: 'slider' | 'number';
  readonly id: NumericSettingId;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Shown after a number field. */
  readonly unit?: string;
  /** A short line under the control. */
  readonly hint?: string;
  /** The value as words, as the slider's readout and the reset action say it: "300 ms". */
  readonly describe: (value: number) => string;
}

export type SettingControl = SwitchSetting | NumberSetting;

/** "1 channel", "2 channels". */
function channelCount(count: number): string {
  return `${count} ${count === 1 ? 'channel' : 'channels'}`;
}

/**
 * One setting of the inspector, for one scope. It shows the value in effect there and changes it
 * at once, as the scope's own value: on a channel that is an override, marked "overrides global"
 * beside the global value, with a reset to it; on "All channels" it is the global value, and the
 * row says which channels override it, with a reset of those overrides.
 *
 * The control is named by `name`, which says where the setting belongs when its label alone does
 * not (the Metadata tab has a "Show overlay" per type), and it is described by the override note,
 * so the override state is heard on focus.
 */
@Component({
  selector: 'app-setting-row',
  imports: [NeatButton, NeatInput, NeatSlider, NeatSwitch, NeatTooltip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (switchSetting(); as setting) {
      <button
        neatSwitch
        class="switch"
        [attr.aria-label]="fullName()"
        [attr.aria-describedby]="describedBy()"
        [checked]="switchValue()"
        [disabled]="disabled()"
        (checkedChange)="store.set(scope(), setting.id, $event)"
      >
        {{ setting.label }}
      </button>
    }
    @if (numberSetting(); as setting) {
      @if (setting.control === 'slider') {
        <div class="head">
          <span class="label" aria-hidden="true">{{ setting.label }}</span>
          <span class="readout">{{ setting.describe(numberValue()) }}</span>
        </div>
        <neat-slider
          [label]="fullName()"
          [describedBy]="describedBy()"
          [min]="setting.min"
          [max]="setting.max"
          [step]="setting.step"
          [disabled]="disabled()"
          [value]="numberValue()"
          (valueChange)="store.set(scope(), setting.id, $event)"
        />
      } @else {
        <div class="head">
          <label class="label" [for]="fieldId()">{{ setting.label }}</label>
          <span class="number">
            <span class="field">
              <input
                #field
                neatInput
                size="small"
                type="number"
                inputmode="numeric"
                [id]="fieldId()"
                [attr.aria-label]="fullName()"
                [attr.aria-describedby]="describedBy()"
                [min]="setting.min"
                [max]="setting.max"
                [step]="setting.step"
                [disabled]="disabled()"
                [value]="numberValue()"
                (change)="commit(setting, field)"
              />
            </span>
            @if (setting.unit) {
              <span class="unit">{{ setting.unit }}</span>
            }
          </span>
        </div>
      }
      @if (setting.hint) {
        <p class="hint" [id]="hintId()">{{ setting.hint }}</p>
      }
    }
    @if (overrides()) {
      <div class="scope-row">
        <p class="scope-note" [id]="noteId()">
          <span class="marker">overrides global</span> · Global: {{ globalText() }}
        </p>
        <button
          neatButton
          type="button"
          variant="text"
          size="small"
          [attr.aria-label]="resetLabel()"
          [neatTooltip]="resetLabel()"
          (click)="store.resetOverride(channel()!, setting().id)"
        >
          Reset
        </button>
      </div>
    }
    @if (overriddenOn().length > 0) {
      <div class="scope-row">
        <p class="scope-note" [id]="noteId()">{{ overriddenText() }}</p>
        <button
          neatButton
          type="button"
          variant="text"
          size="small"
          [attr.aria-label]="resetOverridesLabel()"
          (click)="resetOverrides()"
        >
          {{ resetOverridesText() }}
        </button>
      </div>
    }
  `,
  styleUrl: './setting-row.css',
})
export class SettingRow {
  readonly scope = input.required<SettingsScope>();
  readonly setting = input.required<SettingControl>();
  /** The control's accessible name; the setting's label when that says enough. */
  readonly name = input<string | undefined>(undefined);

  protected readonly store = inject(ViewerSettingsStore);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  protected readonly fullName = computed(() => this.name() ?? this.setting().label);
  protected readonly channel = computed(() => {
    const scope = this.scope();
    return scope === 'global' ? null : scope;
  });
  protected readonly switchSetting = computed(() => {
    const setting = this.setting();
    return setting.control === 'switch' ? setting : null;
  });
  protected readonly numberSetting = computed(() => {
    const setting = this.setting();
    return setting.control === 'switch' ? null : setting;
  });
  protected readonly switchValue = computed(() => {
    const setting = this.switchSetting();
    return setting !== null && this.store.value(this.scope(), setting.id);
  });
  protected readonly numberValue = computed(() => {
    const setting = this.numberSetting();
    return setting === null ? 0 : this.store.value(this.scope(), setting.id);
  });
  protected readonly disabled = computed(() => {
    const requires = this.setting().requires;
    return requires !== undefined && !this.store.value(this.scope(), requires);
  });

  // Ids are unique: the Viewer has one inspector, which shows one scope at a time.
  protected readonly fieldId = computed(() => `setting-${this.setting().id}`);
  protected readonly hintId = computed(() => `setting-hint-${this.setting().id}`);
  protected readonly noteId = computed(() => `setting-note-${this.setting().id}`);

  /** This channel holds its own value. */
  protected readonly overrides = computed(() => {
    const channel = this.channel();
    return channel !== null && this.store.isOverride(channel, this.setting().id);
  });
  /** The global value in words: on or off, or as the setting describes its numbers. */
  protected readonly globalText = computed(() => {
    const switchSetting = this.switchSetting();
    if (switchSetting !== null) return this.store.value('global', switchSetting.id) ? 'on' : 'off';
    const numberSetting = this.numberSetting()!;
    return numberSetting.describe(this.store.value('global', numberSetting.id));
  });
  protected readonly resetLabel = computed(
    () => `Reset ${this.fullName()} to the global value (${this.globalText()})`,
  );

  /** On "All channels", the channels that hold their own value instead of this one. */
  protected readonly overriddenOn = computed(() =>
    this.scope() === 'global' ? this.store.overridesOf(this.setting().id) : [],
  );
  protected readonly overriddenText = computed(() => {
    const channels = this.overriddenOn();
    return `Overridden on ${channelCount(channels.length)}: ${channels.join(', ')}`;
  });
  /** The button's text; its accessible name starts with it (WCAG 2.5.3, label in name). */
  protected readonly resetOverridesText = computed(
    () => `Reset on ${channelCount(this.overriddenOn().length)}`,
  );
  protected readonly resetOverridesLabel = computed(
    () => `${this.resetOverridesText()} to the global value: ${this.fullName()}`,
  );

  /**
   * What the control is described by: its hint and its override note, when it has them. Undefined
   * without either, which both `aria-describedby` and the slider's `describedBy` leave off.
   */
  protected readonly describedBy = computed(() => {
    const ids: string[] = [];
    if (this.numberSetting()?.hint) ids.push(this.hintId());
    if (this.overrides() || this.overriddenOn().length > 0) ids.push(this.noteId());
    return ids.length > 0 ? ids.join(' ') : undefined;
  });

  /** Focuses the number field, as after the late notice changed its value. */
  focusField(): void {
    this.field()?.nativeElement.focus();
  }

  /**
   * A number field's entry, as the old dialog's fields took it: held to the control's range, and
   * dropped when it is not a number (the store rounds whole-number settings). The field then shows
   * the value in effect, which may differ from what was typed.
   */
  protected commit(setting: NumberSetting, field: HTMLInputElement): void {
    const typed = Number.parseFloat(field.value);
    if (Number.isFinite(typed)) {
      this.store.set(this.scope(), setting.id, Math.min(setting.max, Math.max(setting.min, typed)));
    }
    field.value = String(this.numberValue());
  }

  protected resetOverrides(): void {
    const id = this.setting().id;
    for (const channel of this.overriddenOn()) this.store.resetOverride(channel, id);
  }
}
