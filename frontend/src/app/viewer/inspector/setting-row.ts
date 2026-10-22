import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
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

/**
 * One setting of the inspector, for one scope. It shows the value in effect there and changes it
 * at once, as the scope's own value: on a channel that is an override, marked "overrides global"
 * with a reset to the global value; on "All channels" it is the global value, and the row says
 * how many channels override it, with a reset of those overrides.
 */
@Component({
  selector: 'app-setting-row',
  imports: [NeatButton, NeatInput, NeatSlider, NeatSwitch, NeatTooltip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'group', '[attr.aria-label]': 'setting().label' },
  template: `
    @if (switchSetting(); as setting) {
      <button
        neatSwitch
        class="switch"
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
          [label]="setting.label"
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
                inputmode="decimal"
                [id]="fieldId()"
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
        <p class="hint">{{ setting.hint }}</p>
      }
    }
    @if (overrides()) {
      <p class="scope-note">
        <span class="marker">overrides global</span>
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
      </p>
    }
    @if (overriddenOn().length > 0) {
      <p class="scope-note">
        <span>{{ overriddenText() }}</span>
        <button neatButton type="button" variant="text" size="small" (click)="resetOverrides()">
          Reset those to global
        </button>
      </p>
    }
  `,
  styleUrl: './setting-row.css',
})
export class SettingRow {
  readonly scope = input.required<SettingsScope>();
  readonly setting = input.required<SettingControl>();

  protected readonly store = inject(ViewerSettingsStore);

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
  /** Ids are unique: the Viewer has one inspector, which shows one scope at a time. */
  protected readonly fieldId = computed(() => `setting-${this.setting().id}`);

  /** This channel holds its own value. */
  protected readonly overrides = computed(() => {
    const channel = this.channel();
    return channel !== null && this.store.isOverride(channel, this.setting().id);
  });
  protected readonly resetLabel = computed(() => {
    const switchSetting = this.switchSetting();
    const numberSetting = this.numberSetting();
    let global = '';
    if (switchSetting !== null)
      global = this.store.value('global', switchSetting.id) ? 'on' : 'off';
    if (numberSetting !== null) {
      global = numberSetting.describe(this.store.value('global', numberSetting.id));
    }
    return `Reset to the global value, ${global}`;
  });

  /** On "All channels", the channels that hold their own value instead of this one. */
  protected readonly overriddenOn = computed(() =>
    this.scope() === 'global' ? this.store.overridesOf(this.setting().id) : [],
  );
  protected readonly overriddenText = computed(() => {
    const count = this.overriddenOn().length;
    return `Overridden on ${count} ${count === 1 ? 'channel' : 'channels'}`;
  });

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
