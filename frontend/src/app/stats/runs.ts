import { formatRelativeTime } from '../relative-time';
import type { MetricStatus, RunMetadata, RunSample, RunSummary, SavedRun } from './api';
import { formatDuration, formatEnergy, isNumber } from './format';

/** How many runs can be compared at once; the backend refuses more. */
export const MAX_CHECKED_RUNS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME_BYTES = 80;
const NOTE_CHARACTERS = 512;
const MAX_TAGS = 16;
const TAG_CHARACTERS = 80;

// Spelled out rather than taken from `Intl`, so a date reads the same under any browser locale.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (value: number): string => String(value).padStart(2, '0');

/** "Oct 23", the month and day of a local date. */
function shortDate(date: Date): string {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** "08:41:10", the local time of day. */
function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** "Oct 25, 08:41:10", a local date and time of day. */
function dateTime(date: Date): string {
  return `${shortDate(date)}, ${clock(date)}`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/** A run still being recorded: Sentinel gives it no end yet. */
export function isRecording(run: RunSummary): boolean {
  return run.ended_at === null;
}

/** A run in one line: "Complete · 34.4 s · 275 J · 17 samples". */
export function runLine(run: RunSummary): string {
  return [
    isRecording(run) ? 'Recording' : 'Complete',
    formatDuration(run.duration_ms),
    formatEnergy(run.energy_joules),
    count(run.samples, 'sample'),
  ].join(' · ');
}

/**
 * When a run started: relative within a day, else its date ("Oct 23"), with the year when it is
 * not this year's ("Dec 31, 2025"). '' for a time that cannot be read.
 */
export function runWhen(startedAt: string, now: number): string {
  const time = Date.parse(startedAt);
  if (!Number.isFinite(time)) return '';
  if (now - time < DAY_MS) return formatRelativeTime(startedAt, now);
  const date = new Date(time);
  const year = date.getFullYear();
  return year === new Date(now).getFullYear() ? shortDate(date) : `${shortDate(date)}, ${year}`;
}

/**
 * Whether a run's checkbox can be ticked: never the recording run, whose samples are still
 * coming, and not an unchecked one once the comparison is full. A checked run can always be
 * unticked.
 */
export function canCheckRun(run: RunSummary, checked: readonly string[]): boolean {
  if (isRecording(run)) return false;
  return checked.includes(run.id) || checked.length < MAX_CHECKED_RUNS;
}

/** One metric of a saved run with its statistics over the run's own samples. */
export interface RunMetricRow {
  key: string;
  label: string;
  group: string;
  /** As Sentinel spells it; null for a metric without one. */
  unit: string | null;
  mean: number | null;
  minimum: number | null;
  maximum: number | null;
  /** The maximum against the metric's thresholds. */
  status: Exclude<MetricStatus, 'unavailable'>;
}

/** Minimum, maximum and mean of the readings of a key, in one pass: no spread, so no length limit. */
function statistics(
  samples: readonly RunSample[],
  key: string,
): Pick<RunMetricRow, 'minimum' | 'maximum' | 'mean'> {
  let count = 0;
  let sum = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const sample of samples) {
    const value = sample.values[key];
    if (!isNumber(value)) continue;
    count++;
    sum += value;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return count
    ? { minimum, maximum, mean: sum / count }
    : { minimum: null, maximum: null, mean: null };
}

function statusOf(
  maximum: number | null,
  warn: number | null,
  critical: number | null,
): RunMetricRow['status'] {
  if (!isNumber(maximum)) return 'ok';
  if (isNumber(critical) && maximum >= critical) return 'critical';
  return isNumber(warn) && maximum >= warn ? 'warn' : 'ok';
}

/**
 * Text order that does not depend on the browser's locale (the module words dates by hand for the
 * same reason): case-insensitive first, then by code unit.
 */
export function compareText(a: string, b: string): number {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x !== y) return x < y ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** The metrics of a saved run, by group and then label, with their statistics and status. */
export function runMetricRows(run: SavedRun): RunMetricRow[] {
  return run.metrics
    .map((metric): RunMetricRow => {
      const stats = statistics(run.samples, metric.key);
      return {
        key: metric.key,
        label: metric.label,
        group: metric.group,
        unit: metric.unit || null,
        ...stats,
        status: statusOf(stats.maximum, metric.warn, metric.critical),
      };
    })
    .sort((a, b) => compareText(a.group, b.group) || compareText(a.label, b.label));
}

/**
 * A saved run in one line of facts: "17 samples · 59 metrics · Oct 25, 08:41:10–08:41:44 · 1 past
 * a threshold". The clause for thresholds is left out at none, the time range when there is no
 * sample, and it is one timestamp for a single sample. A sample whose timestamp cannot be read
 * is left out of the range.
 */
export function runFacts(run: SavedRun): string {
  const facts = [count(run.samples.length, 'sample'), count(run.metrics.length, 'metric')];
  const times = run.samples.map((sample) => Date.parse(sample.timestamp)).filter(Number.isFinite);
  if (times.length > 0) {
    const from = new Date(times[0]);
    const to = new Date(times[times.length - 1]);
    const start = dateTime(from);
    if (times.length === 1) facts.push(start);
    else {
      const sameDay = shortDate(from) === shortDate(to);
      facts.push(`${start}–${sameDay ? '' : `${shortDate(to)}, `}${clock(to)}`);
    }
  }
  const past = runMetricRows(run).filter((row) => row.status !== 'ok').length;
  if (past > 0) facts.push(`${past} past a threshold`);
  return facts.join(' · ');
}

/** A time Sentinel gives, as a local date and time: "Oct 25, 08:41:10"; '' if unreadable. */
export function formatRunTime(iso: string | null): string {
  const time = Date.parse(iso ?? '');
  return Number.isFinite(time) ? dateTime(new Date(time)) : '';
}

/** A fact about a run as a key/value list shows it. */
export interface RunFact {
  label: string;
  value: string;
}

/** Names for the board facts Sentinel records today; any other keeps its key. */
const SYSTEM_LABELS: Record<string, string> = {
  architecture: 'Architecture',
  device_tree_model: 'Board model',
  hostname: 'Hostname',
  os_release: 'OS release',
};

/**
 * The name `/etc/os-release` gives the system (`PRETTY_NAME`), which Sentinel records whole: its
 * every line would fill the panel. The text as it is when it names none.
 */
function osName(release: string): string {
  const pretty = /^PRETTY_NAME=(?:"([^"]*)"|(.*))$/m.exec(release);
  return pretty ? (pretty[1] ?? pretty[2]).trim() : release;
}

/**
 * What Sentinel keeps about a run besides its name, note and tags (which a panel shows on their
 * own): its id, start and end, sample interval, Sentinel version, then the board's facts in the
 * order recorded.
 */
export function runMetadataRows(metadata: RunMetadata): RunFact[] {
  const interval = metadata.sample_interval_ms;
  const rows: RunFact[] = [
    { label: 'Id', value: metadata.id },
    { label: 'Started', value: formatRunTime(metadata.started_at) || '—' },
    {
      label: 'Ended',
      value:
        metadata.ended_at === null ? 'Still recording' : formatRunTime(metadata.ended_at) || '—',
    },
    { label: 'Sample interval', value: isNumber(interval) ? `${interval} ms` : '—' },
    { label: 'Sentinel version', value: metadata.sentinel_version },
  ];
  for (const [key, value] of Object.entries(metadata.system)) {
    rows.push({
      label: SYSTEM_LABELS[key] ?? key,
      value: key === 'os_release' ? osName(value) : value,
    });
  }
  return rows;
}

/** The parts of a run every run has; anything else a Sentinel build adds is listed as it came. */
const RUN_PARTS = new Set(['metadata', 'metrics', 'samples']);

/** What a run carries besides its metadata, metrics and samples, as text (JSON for non-strings). */
export function otherRunFields(run: SavedRun): { key: string; value: string }[] {
  return Object.entries(run)
    .filter(([key]) => !RUN_PARTS.has(key))
    .map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }));
}

/** The keys the samples of a run carry readings for that the run defines no metric for. */
export function undefinedKeys(run: SavedRun): string[] {
  const defined = new Set(run.metrics.map((metric) => metric.key));
  const keys = new Set(run.samples.flatMap((sample) => Object.keys(sample.values)));
  return [...keys].filter((key) => !defined.has(key)).sort();
}

/**
 * The value at `fraction` of the ascending `sorted`, by Sentinel's rule (the rank rounded:
 * `sorted[round((n - 1) * fraction)]`), so Insight's figures match the daemon's. Null for none.
 */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.round((sorted.length - 1) * fraction)];
}

/** "2026-10-25", the local day of a date, as file and trace names carry it. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The name a new trace starts with, from the local time: "run-2026-10-25-0841". */
export function traceName(date: Date): string {
  return `run-${localDay(date)}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** Tags typed as comma-separated text: trimmed, empty ones dropped, a repeat dropped. */
export function parseTags(text: string): string[] {
  const tags = text
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  return [...new Set(tags)];
}

/** Whether a text holds a character the server refuses in a name: codes below 32 and 127 to 159. */
function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159);
  });
}

/** The characters of a text as the server counts them: code points, not UTF-16 units. */
function characters(text: string): number {
  return Array.from(text).length;
}

/**
 * The first reason the server would refuse a trace, in its own order and limits (name in UTF-8
 * bytes, note and tags in characters), so the form says so before sending; null when it is fine.
 * Callers send exactly the tags they validated (trimmed, as `parseTags` returns them), so the
 * server counts the same text.
 */
export function validateTrace(name: string, note: string, tags: readonly string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name the trace so you can find its run later.';
  if (new TextEncoder().encode(trimmed).length > NAME_BYTES) {
    return 'The name can be at most 80 UTF-8 bytes.';
  }
  if (hasControlCharacter(trimmed)) return 'The name cannot contain control characters.';
  if (trimmed.includes(',')) {
    return 'The name cannot contain a comma; runs are compared by a comma-separated list of names.';
  }
  if (characters(note) > NOTE_CHARACTERS) return 'The note can be at most 512 characters.';
  if (tags.length > MAX_TAGS) return 'At most 16 tags can be attached to a trace.';
  for (const tag of tags) {
    const trimmedTag = tag.trim();
    if (!trimmedTag) return 'A tag cannot be empty.';
    if (characters(trimmedTag) > TAG_CHARACTERS) return 'A tag can be at most 80 characters.';
  }
  return null;
}
