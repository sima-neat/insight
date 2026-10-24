import { HttpClient } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { NeatButton, NeatCode, NeatNote } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatCollapsible } from '@sima/neat-ui/collapsible';
import { NeatDetails } from '@sima/neat-ui/details';
import { NeatDialog, NeatDialogActions, NeatDialogBody, NeatDialogRef } from '@sima/neat-ui/dialog';
import { NeatErrorNote } from '@sima/neat-ui/field';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { firstValueFrom } from 'rxjs';
import { messageOf, withRequestErrors } from '../sources/stream-lines';
import type { SystemInfo } from './api';
import {
  componentStatus,
  componentVersion,
  displayValue,
  portSummary,
  readableKey,
} from './readable';

const SYSINFO_URL = '/api/sysinfo';

/**
 * Opens the System Info dialog. `TopBarDialogs` calls it after importing this module on the first
 * open, so the dialog and the kit entries it uses stay out of the initial bundle.
 */
export function openSystemInfoDialog(injector: Injector): NeatDialogRef<void> {
  return injector.get(NeatDialog).open<void>(SystemInfoDialog, {
    title: 'System information',
    size: 'large',
  });
}

/** A term and its value, in words. */
type Entry = readonly [term: string, value: string];

/** `neat`'s fields of a section as words, without the schema name every section repeats. */
function entriesOf(section: Record<string, unknown> | undefined): Entry[] {
  return Object.entries(section ?? {})
    .filter(([key]) => key !== 'schema')
    .map(([key, value]) => [readableKey(key), displayValue(value)]);
}

/**
 * The System Info dialog (spec, "Peripherals, board connection and System Info"), opened by the
 * top bar's ⓘ from any page: the environment, Insight, its components, the ports the SDK
 * publishes and the update check, each a section of the outline. Environment, Insight and Update
 * check start open; Components and Exposed ports, the long ones, start closed.
 *
 * Every open and every Refresh asks `GET /api/sysinfo`, which runs `neat` for up to 15 s, so
 * Refresh waits for the answer in flight: there is never more than one request, and its answer
 * is the newest. A failed Refresh keeps what is shown and says so above it; before any data the
 * message stands alone (Inv-PB §6.6, where #170 dropped the data).
 *
 * Without the `neat` command Insight still answers, with `missing: ['neat']`. What only `neat`
 * knows (the environment, the components and the update check) is then replaced by one note,
 * while Insight's own section and the ports from its port map stay.
 */
@Component({
  selector: 'app-system-info-dialog',
  imports: [
    NeatButton,
    NeatCallout,
    NeatCode,
    NeatCollapsible,
    NeatDetails,
    NeatDialogActions,
    NeatDialogBody,
    NeatErrorNote,
    NeatNote,
    NeatStatusChip,
    NgTemplateOutlet,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './system-info-dialog.html',
  styleUrl: './system-info-dialog.css',
})
export class SystemInfoDialog {
  private readonly http = inject(HttpClient);
  protected readonly dialog = inject<NeatDialogRef<void>>(NeatDialogRef);

  /** The last good answer; null until the first one. */
  protected readonly info = signal<SystemInfo | null>(null);
  /** Why the newest request failed; cleared by the next good answer. */
  protected readonly failure = signal<string | null>(null);
  protected readonly loading = signal(false);

  /** `neat` is not installed: the sections that only it can fill are not shown. */
  protected readonly neatMissing = computed(() => this.info()?.missing?.includes('neat') ?? false);

  /** Under the title: which environment, and where Insight's web UI is (or the environment's mode). */
  protected readonly identity = computed(() => {
    const info = this.info();
    if (!info) return '';
    const label = info.environment?.['label'] ?? 'Neat Environment';
    const where = info.insight?.['webUiUrl'] ?? info.environment?.['mode'];
    return where ? `${label} · ${where}` : String(label);
  });

  protected readonly environment = computed(() => entriesOf(this.info()?.environment));
  protected readonly insight = computed(() => entriesOf(this.info()?.insight));
  protected readonly updateCheck = computed(() => entriesOf(this.info()?.updateCheck));

  protected readonly components = computed(() =>
    Object.entries(this.info()?.components ?? {}).map(([key, component]) => ({
      key,
      name: component.name || readableKey(key),
      version: componentVersion(component),
      status: componentStatus(component),
      note: component.latestVersion || component.detail || component.venv || '',
    })),
  );

  protected readonly ports = computed(() =>
    (this.info()?.exposedPorts ?? []).map((port) => ({
      name: readableKey(port.name),
      summary: portSummary(port),
    })),
  );

  constructor() {
    void this.refresh();
  }

  protected async refresh(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    try {
      this.info.set(
        await firstValueFrom(this.http.get<SystemInfo>(SYSINFO_URL).pipe(withRequestErrors())),
      );
      this.failure.set(null);
    } catch (failure) {
      this.failure.set(messageOf(failure));
    } finally {
      this.loading.set(false);
    }
  }
}
