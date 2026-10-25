import { formatRelativeTime } from '../relative-time';
import type { RunSample, RunSummary, SavedRun } from './api';
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
  status: 'ok' | 'warn' | 'critical';
}

function readings(samples: readonly RunSample[], key: string): number[] {
  return samples.map((sample) => sample.values[key]).filter(isNumber);
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

/** The metrics of a saved run, by group and then label, with their statistics and status. */
export function runMetricRows(run: SavedRun): RunMetricRow[] {
  return run.metrics
    .map((metric): RunMetricRow => {
      const values = readings(run.samples, metric.key);
      const maximum = values.length ? Math.max(...values) : null;
      return {
        key: metric.key,
        label: metric.label,
        group: metric.group,
        unit: metric.unit || null,
        mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        minimum: values.length ? Math.min(...values) : null,
        maximum,
        status: statusOf(maximum, metric.warn, metric.critical),
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
}

/**
 * A saved run in one line of facts: "17 samples · 59 metrics · Oct 25, 08:41:10–08:41:44 · 1 past
 * a threshold". The clause for thresholds is left out at none, the time range when there is no
 * sample, and it is one timestamp for a single sample.
 */
export function runFacts(run: SavedRun): string {
  const facts = [count(run.samples.length, 'sample'), count(run.metrics.length, 'metric')];
  const first = run.samples.at(0);
  const last = run.samples.at(-1);
  if (first && last) {
    const from = new Date(Date.parse(first.timestamp));
    const to = new Date(Date.parse(last.timestamp));
    const start = `${shortDate(from)}, ${clock(from)}`;
    if (run.samples.length === 1) facts.push(start);
    else {
      const sameDay = shortDate(from) === shortDate(to);
      facts.push(`${start}–${sameDay ? '' : `${shortDate(to)}, `}${clock(to)}`);
    }
  }
  const past = runMetricRows(run).filter((row) => row.status !== 'ok').length;
  if (past > 0) facts.push(`${past} past a threshold`);
  return facts.join(' · ');
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

/** The name a new trace starts with, from the local time: "run-2026-10-25-0841". */
export function traceName(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `run-${day}-${pad(date.getHours())}${pad(date.getMinutes())}`;
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
  if (tags.some((tag) => characters(tag.trim()) > TAG_CHARACTERS)) {
    return 'A tag can be at most 80 characters.';
  }
  return null;
}
