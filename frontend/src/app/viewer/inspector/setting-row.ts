import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  NeatButton,
  NeatConfirm,
  NeatIcon,
  NeatInlineButton,
  NeatInput,
  NeatLine,
  NeatLineEnd,
  NeatLineList,
  NeatSlider,
  NeatSwitch,
  NeatTooltip,
} from '@sima/neat-ui';
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
export function channelCount(count: number): string {
  return `${count} ${count === 1 ? 'channel' : 'channels'}`;
}

/** "1 setting", "2 settings". */
export function settingCount(count: number): string {
  return `${count} ${count === 1 ? 'setting' : 'settings'}`;
}

/**
 * One setting of the inspector, for one scope. It shows the value in effect there and changes it
 * at once, as the scope's own value: on a channel that is an override, marked "overrides global"
 * beside the global value, with a reset to it; on "All channels" it is the global value, and the
 * row says how many channels override it. That note unfolds into the channels and their values,
 * each with a "Use global" that applies at once, and a reset of all of them, which asks first.
 *
 * The control is named by `name`, which says where the setting belongs when its label alone does
 * not (the Metadata tab has a "Show overlay" per type), and it is described by the override note,
 * so the override state is heard on focus.
 */
@Component({
  selector: 'app-setting-row',
  imports: [
    NeatButton,
    NeatIcon,
    NeatInlineButton,
    NeatInput,
    NeatLine,
    NeatLineEnd,
    NeatLineList,
    NeatSlider,
    NeatSwitch,
    NeatTooltip,
  ],
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
      <div class="overrides">
        <p class="note">
          <button
            neatInlineButton
            type="button"
            [id]="noteId()"
            [attr.aria-expanded]="open()"
            [attr.aria-controls]="open() ? listId() : null"
            (click)="open.set(!open())"
          >
            <span class="dot" aria-hidden="true"></span>
            {{ overriddenText() }}
            <neat-icon class="chevron" [class.open]="open()" name="next" [size]="16" />
          </button>
        </p>
        @if (open()) {
          <ul neatLineList class="channels" [id]="listId()">
            @for (line of lines(); track line.channel) {
              <li neatLine>
                <span>Channel {{ line.channel }}</span>
                <span class="value">{{ line.value }}</span>
                <button
                  neatInlineButton
                  neatLineEnd
                  class="use-global"
                  type="button"
                  [attr.aria-label]="useGlobalLabel(line.channel)"
                  (click)="useGlobal(line.channel)"
                >
                  Use global
                </button>
              </li>
            }
            <li neatLine>
              <button
                neatInlineButton
                type="button"
                [attr.aria-label]="resetOverridesLabel()"
                (click)="resetOverrides()"
              >
                {{ resetOverridesText() }}
              </button>
            </li>
          </ul>
        }
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
  private readonly confirm = inject(NeatConfirm);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

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
  protected readonly listId = computed(() => `setting-overrides-${this.setting().id}`);

  /** This channel holds its own value. */
  protected readonly overrides = computed(() => {
    const channel = this.channel();
    return channel !== null && this.store.isOverride(channel, this.setting().id);
  });
  /** The global value in words: on or off, or as the setting describes its numbers. */
  protected readonly globalText = computed(() =>
    this.valueText(this.store.value('global', this.setting().id)),
  );
  protected readonly resetLabel = computed(
    () => `Reset ${this.fullName()} to the global value (${this.globalText()})`,
  );

  /** On "All channels", the channels that hold their own value instead of this one. */
  protected readonly overriddenOn = computed(() =>
    this.scope() === 'global' ? this.store.overridesOf(this.setting().id) : [],
  );
  /** Each overriding channel with its value, for the list. */
  protected readonly lines = computed(() => {
    const id = this.setting().id;
    return this.overriddenOn().map((channel) => ({
      channel,
      value: this.valueText(this.store.value(channel, id), true),
    }));
  });
  /** Whether the list is unfolded. */
  protected readonly open = signal(false);
  protected readonly overriddenText = computed(
    () => `Overridden on ${channelCount(this.overriddenOn().length)}`,
  );
  /** The button's text; its accessible name starts with it (WCAG 2.5.3, label in name). */
  protected readonly resetOverridesText = computed(
    () => `Reset on ${channelCount(this.overriddenOn().length)}…`,
  );
  protected readonly resetOverridesLabel = computed(
    () =>
      `Reset on ${channelCount(this.overriddenOn().length)} to the global value: ${this.fullName()}`,
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

  constructor() {
    // Not remembered: once the last override has gone, the note comes back folded.
    effect(() => {
      if (this.overriddenOn().length === 0) this.open.set(false);
    });
  }

  /**
   * Focuses the control, for after something that held focus went: the late notice's button, or
   * the list of overriding channels once none is left. A disabled number field cannot take focus
   * (a slider stays focusable), so focus then goes to the row's label, which is focusable by
   * script only.
   */
  focusControl(): void {
    const row = this.host.nativeElement;
    const control = row.querySelector<HTMLElement>(
      'input:not(:disabled), [role="switch"], [role="slider"]',
    );
    if (control !== null) {
      control.focus();
      return;
    }
    const label = row.querySelector<HTMLElement>('.label');
    if (label !== null) {
      label.tabIndex = -1;
      label.focus();
    }
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

  protected useGlobalLabel(channel: number): string {
    return `Use global value on channel ${channel}: ${this.fullName()}`;
  }

  /**
   * Gives the channel's value back at once (Inv §5c). Its line goes, and with it the focus, so
   * focus moves first to a neighbouring line, or to the control when this was the last.
   */
  protected useGlobal(channel: number): void {
    const buttons = this.host.nativeElement.querySelectorAll<HTMLElement>('.use-global');
    const index = this.overriddenOn().indexOf(channel);
    const neighbour = buttons[index + 1] ?? buttons[index - 1];
    if (neighbour === undefined) this.focusControl();
    else neighbour.focus();
    this.store.resetOverride(channel, this.setting().id);
  }

  /**
   * Asks, then gives back every channel's value for this setting, for the channels that hold one
   * when Reset is pressed. The list that opened the dialog goes with the last of them, and the
   * dialog gives focus back to it, so focus goes to the control instead.
   */
  protected async resetOverrides(): Promise<void> {
    const id = this.setting().id;
    const count = this.overriddenOn().length;
    const confirmed = await this.confirm.ask({
      title: `Reset ${this.fullName()} on ${channelCount(count)}?`,
      message: `${count === 1 ? 'It goes' : 'They go'} back to the global value (${this.globalText()}). This can't be undone.`,
      confirmLabel: 'Reset',
      tone: 'danger',
    });
    if (!confirmed) return;
    this.focusControl();
    for (const channel of this.store.overridesOf(id)) this.store.resetOverride(channel, id);
  }

  /** A value in words: a switch as on or off ("On", "Off" listed alone), a number as described. */
  private valueText(value: boolean | number, listed = false): string {
    if (typeof value === 'boolean') {
      if (listed) return value ? 'On' : 'Off';
      return value ? 'on' : 'off';
    }
    return this.numberSetting()!.describe(value);
  }
}
