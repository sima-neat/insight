import { formatBytes } from '../format-bytes';
import { formatValue, isNumber } from '../stats/format';
import type { HostMetrics, HostUsage } from './api';

/** What System Info's "This computer" shows: where the numbers come from, and each one as words. */
export interface HostReadings {
  source: 'local' | 'remote';
  /** Whose numbers these are, under the section's heading. */
  note: string;
  /** A remote DevKit that is configured but not connected, which reports nothing. */
  offline: boolean;
  /** Insight answered, but without a CPU, memory, disk or temperature reading. */
  empty: boolean;
  rows: { term: string; value: string }[];
}

const NOTES = {
  local: 'The machine Insight runs on, not the board.',
  remote: 'Remote DevKit from the legacy REMOTE_DEVKIT configuration, not the board.',
} as const;

/** A reading, or null for what is not there (`""` is a remote DevKit that is not connected). */
function numberOf(value: unknown): number | null {
  return isNumber(value) ? value : null;
}

/** A percentage as a reading between 0 and 100, as #170 clamped it. */
function percentOf(value: unknown): string | null {
  const number = numberOf(value);
  return number === null ? null : formatValue(Math.max(0, Math.min(100, number)), '%');
}

/** "<used> of <total>", when both are counts. A negative count is no reading, not "-5 B". */
function bytesOf(usage: HostUsage): string | null {
  const { used, total } = usage;
  return isNumber(used) && used >= 0 && isNumber(total) && total >= 0
    ? `${formatBytes(used)} of ${formatBytes(total)}`
    : null;
}

/**
 * One row for a memory or disk: the percentage, the bytes behind it and the mount, whichever are
 * there. No percentage and no bytes is no row, so the mount alone never stands for a reading.
 */
function usageRow(
  term: string,
  usage: HostUsage | null | undefined,
  mount?: string,
): HostReadings['rows'] {
  const readings = [percentOf(usage?.percent), usage ? bytesOf(usage) : null].filter(
    (reading) => reading !== null,
  );
  if (readings.length === 0) return [];
  return [{ term, value: [...readings, mount].filter(Boolean).join(' · ') }];
}

/**
 * The host snapshot as the rows System Info lists, ported from #170's `hostMetricsModel`
 * (model.js:1415-1441). A reading that is not there has no row, never a zero or a dash. A remote
 * DevKit that is configured but not connected answers with empty fields; that is `offline`, not a
 * machine at 0%.
 */
export function hostReadings(payload: HostMetrics): HostReadings {
  const remote = payload.REMOTE;
  const cpu = percentOf(payload.cpu_load);
  const temperature = numberOf(payload.temperature_celsius_avg);
  const offline = remote && cpu === null && !isNumber(payload.memory?.percent);
  const rows: HostReadings['rows'] = offline
    ? []
    : [
        ...(cpu === null ? [] : [{ term: 'CPU', value: cpu }]),
        ...usageRow('Memory', payload.memory),
        ...usageRow('Disk', payload.disk, payload.disk?.mount),
        // Only a Davinci board has a temperature, and the backend sends 0 for a remote DevKit it
        // cannot reach: either way, a reading that is not there is left out.
        ...(temperature === null || (remote && temperature === 0)
          ? []
          : [{ term: 'Temperature', value: formatValue(temperature, 'C') }]),
      ];
  return {
    source: remote ? 'remote' : 'local',
    note: NOTES[remote ? 'remote' : 'local'],
    offline,
    empty: !offline && rows.length === 0,
    rows,
  };
}

/**
 * What System Info says in place of the rows, or '' when there are rows to show. `null` is no
 * answer yet (ported from `hostNotice`, model.js:1450-1458); a failed first read is shown as the
 * failure by the dialog, not as this notice.
 */
export function hostNotice(readings: HostReadings | null): string {
  if (!readings) return 'Reading this computer…';
  if (readings.offline) {
    return 'A remote DevKit is configured for this endpoint but is not connected, so it reports nothing.';
  }
  return readings.empty
    ? 'Insight answered with no CPU, memory or disk reading for this computer, so none is shown rather than zeros.'
    : '';
}
