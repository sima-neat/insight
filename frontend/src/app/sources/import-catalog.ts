import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import { NeatButton, NeatNote } from '@sima/neat-ui';
import { NeatErrorNote } from '@sima/neat-ui/field';
import { NeatInput } from '@sima/neat-ui/input';
import { NeatColumn, NeatSelectList } from '@sima/neat-ui/select-list';
import { NeatTab, NeatTabs } from '@sima/neat-ui/tabs';
import { CellText } from '../cell-text';
import type { CatalogAsset, CatalogIndex, CatalogSource } from './api';
import {
  assetMatchesSearch,
  assetsOfSource,
  catalogAssetLabel,
  type CatalogFilter,
  matchesFilter,
  previewOf,
  sortCatalogAssets,
  sourceMatchesSearch,
  totalBytes,
} from './catalog';
import { CatalogFilters } from './catalog-filters';
import { formatBytes } from './format-bytes';
import { ImportRunner } from './import-runner';
import { ImportSession } from './import-session';
import { MediaLibraryService } from './media-library.service';
import { ImportPreview } from './import-preview';
import { ImportSummary } from './import-summary';
import type { FilePreview } from './preview-frame';
import { codecLabel } from './slot-row';
import { messageOf } from './stream-lines';

/** A catalog asset as a list row shows it. */
interface AssetRow {
  readonly asset: CatalogAsset;
  /** The source's title, as the by-type list names an asset. */
  readonly source: string;
  readonly label: string;
  readonly size: string;
}

interface SourceRow {
  readonly source: CatalogSource;
  readonly title: string;
  /** Its importable variants, whatever the filter. */
  readonly variants: number;
}

const byAssetPath = (row: AssetRow) => row.asset.path;
const bySourceId = (row: SourceRow) => row.source.id;

/**
 * What the Catalog tab keeps while the dialog is open: `neat-tabs` destroys a tab's panel when
 * another opens, and coming back must not refetch the catalog or forget the choices made. The
 * filter is one for both browsing modes, as in #170. Provided by the dialog.
 */
@Injectable()
export class CatalogTabState {
  readonly index = signal<CatalogIndex | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly search = signal('');
  readonly mode = signal<string | undefined>('type');
  readonly filter = signal<CatalogFilter>({ profile: '', codec: '' });
  /** By name: the source picked; null shows the first that matches the search. */
  readonly sourceId = signal<string | null>(null);
  /** By name: the variant picked; null takes the first that passes the filter. */
  readonly variantPath = signal<string | null>(null);
  /** By type: the assets checked, including those the search or filter hides now. */
  readonly typePaths = signal<readonly string[]>([]);
}

/**
 * The import dialog's Catalog tab (Inv-SM §1.1): the published catalog, loaded when the tab first
 * opens, browsed by asset type or by asset name with one shared filter, and imported through
 * `ImportRunner.importCatalog`, one asset after the other.
 */
@Component({
  selector: 'app-import-catalog',
  imports: [
    CatalogFilters,
    CellText,
    ImportPreview,
    ImportSummary,
    NeatButton,
    NeatColumn,
    NeatErrorNote,
    NeatInput,
    NeatNote,
    NeatSelectList,
    NeatTab,
    NeatTabs,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import-catalog.html',
  styleUrl: './import-catalog.css',
})
export class ImportCatalog {
  protected readonly state = inject(CatalogTabState);
  protected readonly runner = inject(ImportRunner);
  private readonly session = inject(ImportSession);
  private readonly library = inject(MediaLibraryService);

  protected readonly byAssetPath = byAssetPath;
  protected readonly bySourceId = bySourceId;

  protected readonly importing = computed(() => this.runner.job() === 'catalog');

  private readonly sources = computed(() => this.state.index()?.sources ?? []);
  /** Every asset, preview clips included: the by-type filter offers what all of them have. */
  protected readonly assets = computed(() => this.state.index()?.assets ?? []);
  private readonly sourcesById = computed(
    () => new Map(this.sources().map((source) => [source.id, source])),
  );

  // ---- By asset name ----

  protected readonly sourceRows = computed((): readonly SourceRow[] => {
    const search = this.state.search();
    const assets = this.assets();
    return this.sources()
      .filter((source) => sourceMatchesSearch(source, search))
      .map((source) => ({
        source,
        title: source.title || source.id,
        variants: assets.filter((asset) => asset.source_id === source.id && !asset.preview).length,
      }));
  });
  /** As #170: the source picked even when the search hides it, else the first one shown. */
  protected readonly selectedSource = computed(
    () =>
      this.sources().find((source) => source.id === this.state.sourceId()) ??
      this.sourceRows()[0]?.source ??
      null,
  );
  protected readonly selectedSourceRow = computed(
    () => this.sourceRows().find((row) => row.source === this.selectedSource()) ?? null,
  );
  /** The selected source's assets, preview clips included: its filter offers what they have. */
  protected readonly sourceAssets = computed(() => {
    const source = this.selectedSource();
    return source ? assetsOfSource(this.assets(), source.id) : [];
  });
  protected readonly preview = computed(() => previewOf(this.sourceAssets()));
  protected readonly previewFile = computed((): FilePreview | null => {
    const preview = this.preview();
    return preview ? { kind: 'video', src: preview.url, path: catalogAssetLabel(preview) } : null;
  });
  /** What the source's summary says under its title. */
  protected readonly sourceNotes = computed(() => {
    const preview = this.preview();
    return [
      this.selectedSource()?.description || 'Curated Insight media asset.',
      ...(preview ? [`Preview: ${catalogAssetLabel(preview)}`] : []),
    ];
  });
  protected readonly variantRows = computed(() =>
    this.rows(this.sourceAssets().filter((asset) => matchesFilter(asset, this.state.filter()))),
  );
  /** As #170: the variant picked, else the first one that passes the filter. */
  protected readonly selectedVariant = computed(
    () =>
      this.variantRows().find((row) => row.asset.path === this.state.variantPath()) ??
      this.variantRows()[0] ??
      null,
  );

  protected readonly variantNotes = computed(() => {
    const variant = this.selectedVariant();
    return variant ? [variant.asset.path, `Total selected: ${variant.size}`] : [];
  });

  // ---- By asset type ----

  protected readonly typeRows = computed(() => {
    const search = this.state.search();
    const filter = this.state.filter();
    const sources = this.sourcesById();
    return this.rows(
      sortCatalogAssets(
        this.assets().filter(
          (asset) =>
            matchesFilter(asset, filter) &&
            assetMatchesSearch(asset, sources.get(asset.source_id), search),
        ),
      ),
    );
  });
  /**
   * The assets checked by type, of those the list shows. One the search or the filter hides is
   * neither counted nor imported, as in #170; unlike #170, which dropped it, it stays checked for
   * when it shows again, as the kit's checked list keeps keys it does not list.
   */
  protected readonly typeSelection = computed((): readonly AssetRow[] => {
    const checked = new Set(this.state.typePaths());
    return this.typeRows().filter((row) => checked.has(row.asset.path));
  });
  protected readonly typeBytes = computed(() =>
    formatBytes(totalBytes(this.typeSelection().map((row) => row.asset))),
  );
  protected readonly filterSummary = computed(() => {
    const { profile, codec } = this.state.filter();
    return `${profile || 'Any resolution & fps'} / ${codec ? codecLabel(codec) : 'Any codec'}`;
  });

  constructor() {
    if (this.state.index() === null && !this.state.loading()) void this.load();
  }

  protected async load(): Promise<void> {
    this.state.loading.set(true);
    this.state.error.set(null);
    try {
      this.state.index.set(await this.library.catalog());
    } catch (failure) {
      this.state.error.set(messageOf(failure));
    } finally {
      this.state.loading.set(false);
    }
  }

  protected setSearch(value: string): void {
    this.state.search.set(value);
  }

  /** A different source starts from its own variants, unfiltered, as #170 did. */
  protected pickSource(row: SourceRow | null): void {
    if (!row || row.source.id === this.selectedSource()?.id) return;
    this.state.sourceId.set(row.source.id);
    this.state.filter.set({ profile: '', codec: '' });
    this.state.variantPath.set(null);
  }

  protected pickVariant(row: AssetRow | null): void {
    this.state.variantPath.set(row?.asset.path ?? null);
  }

  /** A click on an asset's row checks or unchecks it, as #170's checkbox labels did. */
  protected toggleType(row: AssetRow): void {
    const path = row.asset.path;
    this.state.typePaths.update((paths) =>
      paths.includes(path) ? paths.filter((one) => one !== path) : [...paths, path],
    );
  }

  /** Checks every asset the list shows, keeping those checked before. */
  protected checkAllTypes(): void {
    this.state.typePaths.update((paths) => [
      ...new Set([...paths, ...this.typeRows().map(byAssetPath)]),
    ]);
  }

  protected clearTypes(): void {
    this.state.typePaths.set([]);
  }

  protected importRows(rows: readonly AssetRow[]): void {
    const assets = rows.map((row) => row.asset);
    if (assets.length === 0 || this.runner.busy()) return;
    void this.session.run(() => this.runner.importCatalog(assets));
  }

  protected importVariant(): void {
    const variant = this.selectedVariant();
    if (variant) this.importRows([variant]);
  }

  private rows(assets: readonly CatalogAsset[]): readonly AssetRow[] {
    const sources = this.sourcesById();
    return assets.map((asset) => ({
      asset,
      source: sources.get(asset.source_id)?.title || asset.source_title || asset.source_id,
      label: catalogAssetLabel(asset),
      size: formatBytes(asset.bytes || 0),
    }));
  }
}
