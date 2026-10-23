import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  model,
} from '@angular/core';
import {
  NeatConfirm,
  NeatInlineButton,
  NeatInput,
  NeatSegmented,
  type NeatSegmentedOption,
} from '@sima/neat-ui';
import type { NeatRoiDrawMode } from '@sima/neat-ui/video';
import { RoiStore } from '../settings/roi-store';
import type { SettingsScope } from '../settings/viewer-settings.store';
import { type SettingControl, SettingRow } from './setting-row';

const DRAW_MODES: readonly NeatSegmentedOption<NeatRoiDrawMode>[] = [
  { value: 'off', label: 'Off' },
  { value: 'inclusion', label: 'Inclusion' },
  { value: 'exclusion', label: 'Exclusion' },
];

const ROI_SETTINGS: readonly SettingControl[] = [
  { control: 'switch', id: 'general.showRoi', label: 'Show regions' },
  { control: 'switch', id: 'general.applyRoiFiltering', label: 'Filter by regions' },
];

const TYPE_NAMES = { inclusion: 'Inclusion', exclusion: 'Exclusion' } as const;

/** "2 and 6", "2, 6 and 9". */
function listChannels(channels: readonly number[]): string {
  return `${channels.slice(0, -1).join(', ')} and ${channels[channels.length - 1]}`;
}

/**
 * The inspector's ROI tab, for one scope: the regions of interest of all channels, or of the
 * selected one. The inspector's preview carries the editor; this tab holds what goes with it: the
 * draw switch, the list of regions with their deletes, where the regions come from, and the Show
 * and Filter switches. On "All channels" it also chooses the channel the regions are drawn on,
 * which is only a backdrop.
 *
 * Every edit replaces the scope's whole list, starting from what the editor shows
 * (`RoiStore.editable`), so the first edit of a channel that inherits keeps the global regions it
 * showed. The list is the keyboard's way to remove regions, since drawing is pointer-only; when the
 * control that had focus goes with an edit, focus moves to the nearest one left.
 */
@Component({
  selector: 'app-roi-tab',
  imports: [NeatInlineButton, NeatInput, NeatSegmented, SettingRow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (scope() === 'global') {
      <label class="field">
        Draw on channel
        <span class="number-field">
          <input
            #backdropInput
            neatInput
            size="small"
            inputmode="numeric"
            aria-label="Draw on channel"
            [value]="backdrop() ?? ''"
            (keydown.enter)="applyBackdrop(backdropInput)"
            (blur)="applyBackdrop(backdropInput)"
          />
        </span>
      </label>
    }
    <div class="draw">
      <span class="label" aria-hidden="true">Draw</span>
      <neat-segmented label="Draw" [options]="drawModes" [(value)]="drawMode" />
    </div>
    <p class="hint">
      @if (drawMode() === 'off') {
        Regions filter what the viewer shows; the pipeline still detects everything.
      } @else {
        Click to add points; click the first point or double-click to close. Escape cancels.
      }
    </p>
    @if (rows().length === 0) {
      <p class="empty">No regions.</p>
    } @else {
      <ul class="regions">
        @for (row of rows(); track $index) {
          <li class="line">
            <span>{{ row }}</span>
            <button
              neatInlineButton
              class="delete"
              type="button"
              [attr.aria-label]="'Delete ' + row"
              (click)="remove($index)"
            >
              Delete
            </button>
          </li>
        }
        <li class="line">
          <button neatInlineButton class="delete-all" type="button" (click)="removeAll()">
            Delete all…
          </button>
        </li>
      </ul>
    }
    @if (ownChannel(); as channel) {
      <p class="note own">
        Own regions ·
        <button
          neatInlineButton
          type="button"
          [attr.aria-label]="'Use the global regions on channel ' + channel"
          (click)="useGlobal(channel)"
        >
          Use global
        </button>
      </p>
    }
    @if (ownersText(); as text) {
      <p class="note owners">{{ text }}</p>
    }
    @for (setting of settings; track setting.id) {
      <app-setting-row [scope]="scope()" [setting]="setting" />
    }
  `,
  styleUrl: './roi-tab.css',
})
export class RoiTab {
  readonly scope = input.required<SettingsScope>();
  /** What a click on the preview does; the inspector resets it when the channel or tab changes. */
  readonly drawMode = model.required<NeatRoiDrawMode>();
  /** On "All channels", the channel whose preview the regions are drawn on. */
  readonly backdrop = model<number | null>(null);
  /** The channels the Viewer displays, the only ones the backdrop can be. */
  readonly channels = input.required<readonly number[]>();

  private readonly roi = inject(RoiStore);
  private readonly confirm = inject(NeatConfirm);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly drawModes = DRAW_MODES;
  protected readonly settings = ROI_SETTINGS;

  private readonly regions = computed(() => this.roi.editable(this.scope())());

  /** Each region's name, numbered per type in list order: "Inclusion 1", "Exclusion 1", … */
  protected readonly rows = computed(() => {
    const counts = { inclusion: 0, exclusion: 0 };
    return this.regions().map((region) => `${TYPE_NAMES[region.type]} ${++counts[region.type]}`);
  });

  /** The selected channel, while it stores a list of its own (an empty one included). */
  protected readonly ownChannel = computed(() => {
    const scope = this.scope();
    return scope !== 'global' && this.roi.own(scope)() !== null ? scope : null;
  });

  /**
   * On "All channels", the channels that do not show these regions, named only: a channel's list
   * is given back from that channel, and an action here as well would put it in two places.
   */
  protected readonly ownersText = computed(() => {
    if (this.scope() !== 'global') return null;
    const owners = this.roi.channelsWithOwn()();
    if (owners.length === 0) return null;
    return owners.length === 1
      ? `Channel ${owners[0]} uses its own regions.`
      : `Channels ${listChannels(owners)} use their own regions.`;
  });

  /**
   * Enter in the field or leaving it: a displayed channel becomes the backdrop and anything else
   * is dropped; either way the field then shows the backdrop, as the page field does.
   */
  protected applyBackdrop(input: HTMLInputElement): void {
    const typed = input.value.trim();
    const channel = /^\d+$/.test(typed) ? Number(typed) : Number.NaN;
    if (this.channels().includes(channel)) this.backdrop.set(channel);
    input.value = String(this.backdrop() ?? '');
  }

  /**
   * Deletes the region at `index`. Its row's Delete had focus; once the list has rendered, focus
   * goes to the Delete now at that place (the next region's), else the previous one's, else
   * Delete all, else Draw.
   */
  protected remove(index: number): void {
    this.roi.set(
      this.scope(),
      this.regions().filter((_, at) => at !== index),
    );
    afterNextRender(
      () => {
        const host = this.host.nativeElement;
        const deletes = host.querySelectorAll<HTMLElement>('.delete');
        const target =
          deletes[index] ?? deletes[index - 1] ?? host.querySelector<HTMLElement>('.delete-all');
        if (target === null) this.focusDraw();
        else target.focus();
      },
      { injector: this.injector },
    );
  }

  /**
   * Asks, then stores an empty list: on a channel that is still a list of its own, so the channel
   * shows no regions rather than the global ones. The list goes with the button that opened the
   * dialog, which gives focus back to it, so focus goes to Draw.
   */
  protected async removeAll(): Promise<void> {
    const scope = this.scope();
    const confirmed = await this.confirm.ask({
      title: 'Delete all regions?',
      message:
        scope === 'global'
          ? 'The regions for all channels are deleted.'
          : `Channel ${scope}'s regions are deleted; it will show none, not the global ones.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!confirmed) return;
    this.focusDraw();
    this.roi.set(scope, []);
  }

  /** Gives back the channel's own list; its line goes with the focused button, so focus goes to Draw. */
  protected useGlobal(channel: number): void {
    this.focusDraw();
    this.roi.useGlobal(channel);
  }

  /** Focuses the Draw control where keyboard focus enters it: its checked option. */
  private focusDraw(): void {
    this.host.nativeElement
      .querySelector<HTMLElement>('neat-segmented [role="radio"][tabindex="0"]')
      ?.focus();
  }
}
