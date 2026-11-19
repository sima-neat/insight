// Runs fixtures for specs and for Playwright: Sentinel's answers to its traces and runs routes,
// typed as the API's shapes (Insight passes them through as Sentinel gives them). Like
// `stats.testing.ts` it imports only types and JSON, with no vitest globals and no Angular, so
// Playwright can load it too.
import compareRaw from '../../../../tests/fixtures/sentinel/compare-raw.json';
import runDetail from '../../../../tests/fixtures/sentinel/run-detail-shape.json';
import runsList from '../../../../tests/fixtures/sentinel/runs-list.json';
import tracesActive from '../../../../tests/fixtures/sentinel/traces-active.json';
import type {
  CompareExport,
  DeleteAnswer,
  RunMetadata,
  RunsBody,
  RunSummary,
  SavedRun,
  TraceBody,
} from './api';

/**
 * The runs on a board: four finished and one still recording, newest first, as
 * `GET .../sentinel/runs` lists them. The finished ones are the runs of the detail and compare
 * fixtures (Modalix, 2026-09-23 and -24) and an older idle baseline.
 */
export const RUNS_LIST: RunSummary[] = runsList;

/** The run being recorded (`ended_at` null): the first of `RUNS_LIST`. */
export const RECORDING_RUN: RunSummary = RUNS_LIST[0];

/** The trace `GET .../sentinel/traces/active` names while `RECORDING_RUN` records. */
export const ACTIVE_TRACE: RunMetadata = tracesActive.trace;

/** `GET .../sentinel/runs/<id>` for the finished run `20260923T152712.952Z-...-1790177227`. */
export const SAVED_RUN: SavedRun = runDetail;

/**
 * `GET .../sentinel/compare?raw=true` for `tes3` (the baseline) against the run of `SAVED_RUN`,
 * four metrics each, one of which (`cpu_usage_pct`) neither run took a reading of.
 */
export const COMPARE_RAW: CompareExport = compareRaw;

/** An answer to the runs list. */
export function runsAnswer(runs: RunSummary[] = RUNS_LIST): RunsBody {
  return { runs };
}

/** The answer to a delete of `deleted`: the run that went and the runs that are left. */
export function deleteAnswer(deleted: RunSummary, left: RunSummary[]): DeleteAnswer {
  return { deleted: { id: deleted.id, name: deleted.name }, runs: { runs: left } };
}

/**
 * An answer about the trace: `summary` is left out (a start answer) unless given, and null where
 * the read answer has no trace to summarize.
 */
export function traceAnswer(trace: RunMetadata | null, summary?: RunSummary | null): TraceBody {
  return summary === undefined ? { trace } : { trace, summary };
}

/** `SAVED_RUN` with parts replaced. */
export function savedRun(overrides: Partial<SavedRun> = {}): SavedRun {
  return { ...SAVED_RUN, ...overrides };
}
