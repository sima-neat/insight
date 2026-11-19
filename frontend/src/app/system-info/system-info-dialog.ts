import { HttpClient } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { NeatButton, NeatCode, NeatNote } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatCollapsible } from '@sima/neat-ui/collapsible';
import { NeatDetails } from '@sima/neat-ui/details';
import { NeatDialog, NeatDialogActions, NeatDialogBody, NeatDialogRef } from '@sima/neat-ui/dialog';
import { NeatErrorNote } from '@sima/neat-ui/field';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { Announcement } from '../announcement';
import { messageOf, withRequestErrors } from '../sources/stream-lines';
import type { HostReadings, SystemInfo } from './api';
import { hostNotice, hostView } from './host-readings';
import {
  componentNote,
  componentStatus,
  componentVersion,
  entriesOf,
  insightEntries,
  portSummary,
  readableKey,
} from './readable';

const SYSTEM_URL = '/api/system';
const HOST_URL = '/api/system/host';

/**
 * Opens the System Info dialog. `AppDialogs` calls it after importing this module on the first
 * open, so the dialog and the kit entries it uses stay out of the initial bundle.
 */
export function openSystemInfoDialog(injector: Injector): NeatDialogRef<void> {
  return injector.get(NeatDialog).open<void>(SystemInfoDialog, {
    title: 'System information',
    size: 'large',
  });
}

/**
 * The System Info dialog, opened by the rail's System information item from any page: the
 * environment, Insight, "This computer", its components, the ports the SDK publishes and the
 * update check, each a section of the outline. Environment, Insight, This computer and Update
 * check start open; Components and Exposed ports, the long ones, start closed.
 *
 * **Insight and neat** come from `GET /api/system`. Insight's own facts are always there; neat's
 * are from the server's last run of `neat --json`. Opening the dialog reads what the server holds;
 * while its first run of neat has not ended (`reading`) the dialog asks again with `refresh=true`,
 * which waits for that run. Refresh asks with `refresh=true`, which runs neat again (up to 15 s,
 * as it checks online for updates), so Refresh waits for the answer in flight: there is never more
 * than one request, and its answer is the newest. A failed Refresh keeps what is shown and says so
 * above it; before any data the message stands alone. What only neat knows (the environment, the
 * components and the update check) is replaced by one note while neat is missing, still being
 * read, or failed; Insight's section and the ports stay.
 *
 * **"This computer"** is the host's readings from `GET /api/system/host`, asked beside it. They
 * are quick, so they do not wait: a Refresh drops a read that is still out and keeps only the
 * newest answer. A failed read keeps the readings shown and says so in the section; neither
 * request's failure touches the other's data.
 */
@Component({
  selector: 'app-system-info-dialog',
  imports: [
    Announcement,
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
  private readonly destroyRef = inject(DestroyRef);
  protected readonly dialog = inject<NeatDialogRef<void>>(NeatDialogRef);

  /** The last good answer; null until the first one. */
  protected readonly info = signal<SystemInfo | null>(null);
  /** Why the newest request failed; cleared by the next good answer. */
  protected readonly failure = signal<string | null>(null);
  protected readonly loading = signal(false);
  /** What a screen reader is told when a Refresh has replaced the data (a failure is an alert). */
  protected readonly announcement = signal('');

  /** The last good answer of `/api/system/host`; null until the first one. */
  private readonly host = signal<HostReadings | null>(null);
  /** Why the newest read of `/api/system/host` failed; cleared by the next good answer. */
  protected readonly hostFailure = signal<string | null>(null);
  private hostRequest: Subscription | null = null;

  protected readonly readings = computed(() => {
    const host = this.host();
    return host && hostView(host);
  });
  /**
   * In place of the rows; "Reading this computer…" until the first answer, unless that failed.
   */
  protected readonly readingsNotice = computed(() =>
    this.hostFailure() && !this.readings() ? '' : hostNotice(this.readings()),
  );

  /** What neat's run came to: `ready` shows its sections, anything else says why there are none. */
  protected readonly neatState = computed(() => this.info()?.neat.state ?? null);
  /** Why neat could not be read, with its hint; '' unless it failed. */
  protected readonly neatError = computed(() => {
    const error = this.info()?.neat.error;
    return error ? [error.message, error.hint].filter(Boolean).join(' ') : '';
  });

  /** Under the title: which environment, and where Insight's web UI is. */
  protected readonly identity = computed(() => {
    const info = this.info();
    if (!info) return '';
    const label = info.neat.environment?.label || 'Neat Environment';
    return `${label} · ${info.insight.web_ui_url}`;
  });

  protected readonly environment = computed(() => entriesOf(this.info()?.neat.environment));
  protected readonly insight = computed(() => {
    const info = this.info();
    return info ? insightEntries(info.insight, info.neat.insight) : [];
  });
  protected readonly updateCheck = computed(() => entriesOf(this.info()?.neat.update_check));

  protected readonly components = computed(() =>
    Object.entries(this.info()?.neat.components ?? {}).map(([key, component]) => ({
      key,
      name: component.name || readableKey(key),
      version: componentVersion(component),
      status: componentStatus(component),
      note: componentNote(component),
    })),
  );

  protected readonly ports = computed(() =>
    (this.info()?.neat.exposed_ports ?? []).map((port) => ({
      name: readableKey(port.name),
      summary: portSummary(port),
    })),
  );

  constructor() {
    this.readHost();
    this.readSystem(false);
  }

  protected refresh(): void {
    if (this.loading()) return;
    this.readHost();
    this.readSystem(true);
  }

  /**
   * Reads System Info, with `refresh` running neat again. The request ends with the dialog: neat
   * takes seconds, and a reopened dialog would otherwise start a second run beside the one nobody
   * is waiting for. An answer whose neat is still being read asks again, waiting for that run.
   */
  private readSystem(refresh: boolean): void {
    this.loading.set(true);
    this.announcement.set('');
    this.http
      .get<SystemInfo>(SYSTEM_URL, refresh ? { params: { refresh: true } } : {})
      .pipe(withRequestErrors(), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (info) => {
          // Said for a Refresh only: the first answer replaces "Loading system information…".
          if (this.info()) this.announcement.set('System information refreshed.');
          this.info.set(info);
          this.failure.set(null);
          this.loading.set(false);
          if (!refresh && info.neat.state === 'reading') this.readSystem(true);
        },
        error: (failure: unknown) => {
          this.failure.set(messageOf(failure));
          this.loading.set(false);
        },
      });
  }

  /** Replaces a read still out: only the newest answer counts, and a stale one cannot land late. */
  private readHost(): void {
    this.hostRequest?.unsubscribe();
    this.hostRequest = this.http
      .get<HostReadings>(HOST_URL)
      .pipe(withRequestErrors(), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (host) => {
          this.host.set(host);
          this.hostFailure.set(null);
        },
        error: (failure: unknown) => this.hostFailure.set(messageOf(failure)),
      });
  }
}
