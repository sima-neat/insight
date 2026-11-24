import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
} from '@angular/core';
import { NeatAsideHeading, NeatNote } from '@sima/neat-ui';
import { NeatCollapsible } from '@sima/neat-ui/collapsible';
import { NeatDetails } from '@sima/neat-ui/details';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { NeatFigure, NeatTable } from '@sima/neat-ui/table';
import { formatDuration } from '../../duration';
import { NO_VALUE } from '../../no-value';
import { type PanelChip, PanelTitle } from '../../panel-title';
import type { RunSummary, SavedRun } from '../../stats/api';
import { ENERGY_LABEL } from '../../stats/compare';
import { formatEnergy, formatValue, statusLabel } from '../../stats/format';
import {
  formatRunTime,
  isRecording,
  otherRunFields,
  runFacts,
  runMetadataRows,
  runMetricRows,
  undefinedKeys,
} from '../../stats/runs';
import { SentinelRuns } from '../../stats/sentinel-runs';
import { SentinelFailureCallout } from './sentinel-failure-callout';

/** The recording run's chip, beside its name. */
const RECORDING_CHIP: PanelChip = { label: 'Recording', tone: 'info' };

/** A group of a run's metrics as the table shows it. */
interface MetricGroup {
  readonly name: string;
  readonly rows: readonly {
    key: string;
    label: string;
    mean: string;
    minimum: string;
    maximum: string;
    /** Warning or Critical on the maximum; null within the levels. */
    chip: PanelChip | null;
  }[];
}

/** A saved run's metrics under their groups, in `runMetricRows`' order, worded in their units. */
function metricGroups(run: SavedRun): MetricGroup[] {
  const groups: { name: string; rows: MetricGroup['rows'][number][] }[] = [];
  for (const row of runMetricRows(run)) {
    let group = groups.at(-1);
    if (group?.name !== row.group) {
      group = { name: row.group, rows: [] };
      groups.push(group);
    }
    group.rows.push({
      key: row.key,
      label: row.label,
      mean: formatValue(row.mean, row.unit),
      minimum: formatValue(row.minimum, row.unit),
      maximum: formatValue(row.maximum, row.unit),
      chip: row.status === 'ok' ? null : statusLabel(row.status),
    });
  }
  return groups;
}

/** The sentence about readings a run has no definition for. */
function undefinedSentence(keys: readonly string[]): string {
  if (keys.length === 0) return '';
  const values = keys.length === 1 ? '1 value it carries' : `${keys.length} values it carries`;
  return `This run also recorded ${values} no definition for: ${keys.join(', ')}.`;
}

/**
 * The side panel of Stats' Runs view: one run in detail. A finished run is
 * read in full (`SentinelRuns.readRun`) once per run, not on every read of the list, and shows
 * its facts, note and tags, each metric's mean, minimum and maximum over the run's samples (with
 * a Warning or Critical chip where the maximum passed a level), and its metadata folded.
 *
 * The recording run is not read: its samples are still coming. It shows the trace's summary so
 * far (the 30 s trace read) and the note and tags it was started with; before the first trace
 * read after a start from Insight, which answers no summary, the figures are the run list's.
 * Once its trace stops, the list gives the run an end and the panel reads it.
 */
@Component({
  selector: 'app-run-panel',
  imports: [
    NeatAsideHeading,
    NeatCollapsible,
    NeatDetails,
    NeatFigure,
    NeatNote,
    NeatStatusChip,
    NeatTable,
    NgTemplateOutlet,
    PanelTitle,
    SentinelFailureCallout,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './run-panel.html',
  styleUrl: './run-panel.css',
})
export class RunPanel {
  readonly run = input.required<RunSummary>();

  private readonly runs = inject(SentinelRuns);

  protected readonly recording = computed(() => isRecording(this.run()));
  protected readonly chip = computed(() => (this.recording() ? RECORDING_CHIP : null));

  /**
   * The id to read the run by, once it is finished. A computed of its own, so that the list read
   * again, which gives the same run as a new object, leaves it as it is and does not read again.
   */
  private readonly readId = computed(() => (this.recording() ? undefined : this.run().id));
  /** The finished run in full. A read that is no longer the current one (`stale`) shows nothing. */
  private readonly detail = resource({
    params: () => this.readId(),
    loader: ({ params }) => this.runs.readRun(params),
  });
  private readonly read = computed(() => (this.detail.hasValue() ? this.detail.value() : null));
  protected readonly failure = computed(() => {
    const read = this.read();
    return read && 'failure' in read ? read.failure : null;
  });
  protected readonly saved = computed(() => {
    const read = this.read();
    if (!read || !('run' in read)) return null;
    const run = read.run;
    const { note, tags } = run.metadata;
    return {
      facts: runFacts(run),
      note: note ?? '',
      tags,
      groups: metricGroups(run),
      undefined: undefinedSentence(undefinedKeys(run)),
      metadata: runMetadataRows(run.metadata),
      others: otherRunFields(run),
    };
  });

  /** The recording run's figures: the trace's summary when it is this run's, else the list's. */
  protected readonly live = computed(() => {
    const run = this.run();
    const trace = this.runs.trace();
    const summary = this.runs.traceSummary();
    const figures = summary?.id === run.id ? summary : run;
    const own = trace?.id === run.id ? trace : null;
    return {
      facts: [
        { label: 'Started', value: formatRunTime(figures.started_at) || NO_VALUE },
        { label: 'Duration', value: formatDuration(figures.duration_ms) },
        { label: 'Samples', value: String(figures.samples) },
        { label: ENERGY_LABEL, value: formatEnergy(figures.energy_joules) },
      ],
      note: own?.note ?? '',
      tags: own?.tags ?? [],
    };
  });

  /** The failed run is being read again: Retry waits, and says so. */
  protected readonly retrying = computed(() => this.detail.isLoading());

  protected retry(): void {
    if (!this.retrying()) this.detail.reload();
  }
}
