import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { NeatButton, NeatNote } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { CONNECTION_CODES, type BoardProblem } from '../../board/board-error';
import { BoardSettingsAction } from '../../board/board-settings-action';
import { BoardService } from '../../board/board.service';
import type { PeripheralIssue } from '../../peripherals/api';
import {
  changeSummary,
  isSnapshotStale,
  severityInfo,
  sortIssues,
} from '../../peripherals/devices';
import { PeripheralsService } from '../../peripherals/peripherals.service';

/**
 * What Peripherals says above its device list, in this order: the board changed since the scan
 * shown (with Refresh now), the peripherals could not be read, the last scan failed (with the board settings for a connection failure), what
 * changed since the scan before, and SiMa Sentinel's issues, errors first. Each is a callout under
 * the page's title, so its heading is a level 2.
 *
 * It reads the board and the scan from their services; the read failure is the page's, since the
 * page made the read. Refresh now is the page's own Refresh, which stops the page's preview first.
 */
@Component({
  selector: 'app-peripherals-banners',
  imports: [BoardSettingsAction, NeatButton, NeatCallout, NeatNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (stale()) {
      <neat-callout tone="warning" heading="Board changed — refresh" [headingLevel]="2">
        <p>
          These results are from {{ scannedLabel() }}; the selected board is now
          {{ targetLabel() || 'not set' }}. Preview is disabled until you refresh.
        </p>
        @if (targetLabel()) {
          <button
            neatButton
            neatCalloutActions
            type="button"
            size="small"
            variant="outlined"
            [attr.aria-disabled]="scanning() || null"
            (click)="refresh.emit()"
          >
            Refresh now
          </button>
        }
      </neat-callout>
    }

    @if (loadError(); as problem) {
      <neat-callout
        tone="danger"
        announce="alert"
        [heading]="'Could not load peripherals: ' + problem.message"
        [headingLevel]="2"
      >
        @if (problem.hint) {
          <p>{{ problem.hint }}</p>
        }
      </neat-callout>
    }

    @if (peripherals.scanError(); as problem) {
      <neat-callout
        tone="danger"
        announce="alert"
        [heading]="'Scan failed: ' + problem.message"
        [headingLevel]="2"
      >
        <!-- Separate blocks: a block projects into the actions only with one root element. -->
        @if (connectionFailed()) {
          <p>{{ problem.hint || 'Insight could not reach the board.' }}</p>
        } @else if (problem.hint) {
          <p>{{ problem.hint }}</p>
        }
        @if (connectionFailed()) {
          <app-board-settings-action neatCalloutActions />
        }
      </neat-callout>
    }

    @if (changes().length) {
      <neat-callout tone="info" announce="status">
        @for (line of changes(); track line) {
          <p>{{ line }}</p>
        }
      </neat-callout>
    }

    @for (issue of issues(); track $index) {
      <neat-callout [tone]="issue.tone" [heading]="issue.label" [headingLevel]="2">
        <p>{{ issue.message }}</p>
        @if (issue.hint) {
          <p neatNote>{{ issue.hint }}</p>
        }
      </neat-callout>
    }
  `,
  styleUrl: './peripherals-banners.css',
})
export class PeripheralsBanners {
  /** Why the page's read of the peripherals failed; null while it did not. */
  readonly loadError = input<BoardProblem | null>(null);
  /** Refresh now. */
  readonly refresh = output<void>();

  private readonly board = inject(BoardService);
  protected readonly peripherals = inject(PeripheralsService);

  protected readonly stale = computed(() =>
    isSnapshotStale(this.board.id(), this.peripherals.snapshot()),
  );
  protected readonly scannedLabel = computed(() => this.peripherals.snapshot()?.board.label ?? '');
  protected readonly targetLabel = computed(() => this.board.selected()?.label ?? '');
  protected readonly scanning = computed(() => this.peripherals.scanning() !== null);
  /** A failure of the SSH connection itself, which the board's settings are the place to fix. */
  protected readonly connectionFailed = computed(() =>
    CONNECTION_CODES.has(this.peripherals.scanError()?.code ?? ''),
  );
  protected readonly changes = computed(() =>
    changeSummary(this.peripherals.snapshot()?.changes ?? null),
  );
  /** The issues, errors first, each with its severity's word and tone. */
  protected readonly issues = computed(() =>
    sortIssues(this.peripherals.snapshot()?.issues ?? []).map((issue: PeripheralIssue) => ({
      ...severityInfo(issue.severity),
      message: issue.message,
      hint: issue.hint,
    })),
  );
}
