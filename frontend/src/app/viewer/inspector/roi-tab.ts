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
  output,
  viewChild,
} from '@angular/core';
import {
  NeatConfirm,
  NeatInlineButton,
  NeatLine,
  NeatLineEnd,
  NeatLineList,
  NeatNumberField,
  NeatSegmented,
  type NeatSegmentedOption,
} from '@sima/neat-ui';
import { type NeatRoiDrawMode, NeatRoiSwatch, neatRoiNames } from '@sima/neat-ui/video';
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
  imports: [
    NeatInlineButton,
    NeatLine,
    NeatLineEnd,
    NeatLineList,
    NeatNumberField,
    NeatRoiSwatch,
    NeatSegmented,
    SettingRow,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let drawOn = backdrop();
    @if (scope() === 'global' && drawOn !== null) {
      <neat-number-field
        label="Draw on channel"
        [value]="drawOn"
        [accept]="isDisplayed"
        (commit)="backdropChange.emit($event)"
      />
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
      <!-- "regions", "delete" and "delete-all" carry no styles: they are hooks, for remove() to find
           the buttons and for the specs and e2e tests to find the list. -->
      <ul neatLineList class="regions">
        @for (row of rows(); track $index) {
          <li
            neatLine
            [class.highlighted]="highlighted() === $index"
            (pointerenter)="highlighted.set($index)"
            (pointerleave)="highlighted.set(null)"
          >
            <neat-roi-swatch [type]="regions()[$index].type" />
            <span>{{ row }}</span>
            <button
              neatInlineButton
              neatLineEnd
              class="delete"
              type="button"
              [attr.aria-label]="'Delete ' + row"
              (click)="remove($index)"
              (focus)="highlighted.set($index)"
              (blur)="highlighted.set(null)"
            >
              Delete
            </button>
          </li>
        }
        <li neatLine>
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
  /**
   * The index of the region the pointer or keyboard focus is on, in the list or on the preview:
   * the same index the preview's editor takes, so either side marks the other. The inspector owns
   * it, since the editor is not in this tab.
   */
  readonly highlighted = model.required<number | null>();
  /**
   * On "All channels", the channel whose preview the regions are drawn on; null where there is none
   * to draw on, and the field to choose it is then left out.
   */
  readonly backdrop = input<number | null>(null);
  /**
   * The channel the user chose in "Draw on channel", the shown one included: choosing is not the
   * same as the default being in effect, and the owner pins what is chosen.
   */
  readonly backdropChange = output<number>();
  /** The channels the Viewer displays, the only ones the backdrop can be. */
  readonly channels = input.required<readonly number[]>();

  private readonly roi = inject(RoiStore);
  private readonly confirm = inject(NeatConfirm);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly draw = viewChild.required(NeatSegmented);

  protected readonly drawModes = DRAW_MODES;
  protected readonly settings = ROI_SETTINGS;

  protected readonly regions = computed(() => this.roi.editable(this.scope())());

  /** Each region's name, as the preview's Delete bubble names it: "Inclusion 1", "Exclusion 1", … */
  protected readonly rows = computed(() => neatRoiNames(this.regions()));

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

  /** The field takes exactly the channels the Viewer displays, which the owner then adopts. */
  protected readonly isDisplayed = (channel: number): boolean => this.channels().includes(channel);

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

  private focusDraw(): void {
    this.draw().focus();
  }
}
