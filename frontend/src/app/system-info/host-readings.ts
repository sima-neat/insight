import { formatBytes } from '../format-bytes';
import { formatValue, isNumber } from '../stats/format';
import type { HostReadings, Usage } from './api';

/** What System Info's "This computer" shows: each reading as words. */
export interface HostView {
  /** Whose numbers these are, under the section's heading. */
  note: string;
  /** Insight answered, but without a CPU, memory or disk reading. */
  empty: boolean;
  rows: { term: string; value: string }[];
}

const NOTE = 'The machine Insight runs on, not the board.';

/** A percentage as a reading between 0 and 100. */
function percentOf(value: unknown): string | null {
  return isNumber(value) ? formatValue(Math.max(0, Math.min(100, value)), '%') : null;
}

/** "<used> of <total>", when both are counts. A negative count is no reading, not "-5 B". */
function bytesOf(usage: Usage): string | null {
  const { used, total } = usage;
  return isNumber(used) && used >= 0 && isNumber(total) && total >= 0
    ? `${formatBytes(used)} of ${formatBytes(total)}`
    : null;
}

/**
 * One row for a memory or disk: the percentage, the bytes behind it and a disk's folder,
 * whichever are there. No percentage and no bytes is no row, so the folder alone never stands for
 * a reading.
 */
function usageRow(term: string, usage: Usage | null): HostView['rows'] {
  if (!usage) return [];
  const readings = [percentOf(usage.percent), bytesOf(usage)].filter((reading) => reading !== null);
  if (readings.length === 0) return [];
  return [{ term, value: [...readings, usage.path].filter(Boolean).join(' · ') }];
}

/**
 * The host's readings as the rows System Info lists. A reading that is not there (the first CPU
 * reading, a /proc file that could not be read) has no row, never a zero or a dash.
 */
export function hostView(readings: HostReadings): HostView {
  const cpu = percentOf(readings.cpu_percent);
  const rows: HostView['rows'] = [
    ...(cpu === null ? [] : [{ term: 'CPU', value: cpu }]),
    ...usageRow('Memory', readings.memory),
    ...usageRow('Disk', readings.disk),
  ];
  return { note: NOTE, empty: rows.length === 0, rows };
}

/**
 * What System Info says in place of the rows, or '' when there are rows to show. `null` is no
 * answer yet; a failed first read is shown as the failure by the dialog, not as this notice.
 */
export function hostNotice(view: HostView | null): string {
  if (!view) return 'Reading this computer…';
  return view.empty
    ? 'Insight answered with no CPU, memory or disk reading for this computer, so none is shown rather than zeros.'
    : '';
}
