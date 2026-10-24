import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { NeatSelect, type NeatSelectOption } from '@sima/neat-ui/select';
import type { CatalogAsset } from './api';
import { catalogCodecs, type CatalogFilter, catalogProfiles } from './catalog';
import { codecLabel } from './slot-row';

const ANY: NeatSelectOption<string> = { value: '', label: 'Any' };

/**
 * The catalog's Resolution & FPS and Codec filter, one component for both browsing modes (#170
 * wrote the two selects out twice). It offers the values `assets` have: every asset's when
 * browsing by type, the selected source's when browsing by name.
 */
@Component({
  selector: 'app-catalog-filters',
  imports: [NeatSelect],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <neat-select
      label="Resolution & FPS"
      showLabel
      [options]="profiles()"
      [value]="filter().profile"
      (valueChange)="set({ profile: $event ?? '' })"
    />
    <neat-select
      label="Codec"
      showLabel
      [options]="codecs()"
      [value]="filter().codec"
      (valueChange)="set({ codec: $event ?? '' })"
    />
  `,
  styleUrl: './catalog-filters.css',
})
export class CatalogFilters {
  readonly assets = input.required<readonly CatalogAsset[]>();
  readonly filter = model.required<CatalogFilter>();

  protected readonly profiles = computed(() => [
    ANY,
    ...catalogProfiles(this.assets()).map((profile) => ({ value: profile, label: profile })),
  ]);
  protected readonly codecs = computed(() => [
    ANY,
    ...catalogCodecs(this.assets()).map((codec) => ({ value: codec, label: codecLabel(codec) })),
  ]);

  protected set(change: Partial<CatalogFilter>): void {
    this.filter.update((filter) => ({ ...filter, ...change }));
  }
}
