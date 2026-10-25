import {
  ACTIVE_TRACE,
  COMPARE_RAW,
  RECORDING_RUN,
  RUNS_LIST,
  SAVED_RUN,
  runsAnswer,
  savedRun,
  traceAnswer,
} from './runs.testing';
import { METRICS_LIVE } from './stats.testing';
import traceStopped from '../../../../tests/fixtures/sentinel/trace-stopped.json';
import tracesActive from '../../../../tests/fixtures/sentinel/traces-active.json';

describe('the runs fixtures', () => {
  it('the list holds four completed runs and the recording one, newest first', () => {
    expect(RUNS_LIST).toHaveLength(5);
    expect(RUNS_LIST.filter((run) => run.ended_at === null)).toEqual([RECORDING_RUN]);
    expect(RUNS_LIST[0]).toBe(RECORDING_RUN);
    const starts = RUNS_LIST.map((run) => Date.parse(run.started_at));
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
    expect(new Set(RUNS_LIST.map((run) => run.id)).size).toBe(5);
  });

  it('a run id is its start time and the slug of its name, with no comma', () => {
    for (const run of RUNS_LIST) {
      expect(run.id, run.name).toMatch(/^\d{8}T\d{6}\.\d{3}Z-[a-z0-9-]+$/);
      expect(run.id).not.toContain(',');
    }
  });

  it('the active trace is the recording run, and the stop answer ends that same run', () => {
    expect(ACTIVE_TRACE.id).toBe(RECORDING_RUN.id);
    expect(ACTIVE_TRACE.ended_at).toBeNull();
    expect(tracesActive.trace.id).toBe(RECORDING_RUN.id);
    expect(tracesActive.summary).toEqual(RECORDING_RUN);
    expect(traceStopped.trace.id).toBe(RECORDING_RUN.id);
    expect(traceStopped.trace.ended_at).toBe(traceStopped.summary.ended_at);
    expect(traceStopped.summary.ended_at).not.toBeNull();
    // A stop answer's summary is of the finished run: nothing in it is still being recorded.
    expect(traceStopped.summary.duration_ms).toBeGreaterThan(RECORDING_RUN.duration_ms);
  });

  it('the answers carry the board and generation of the live capture', () => {
    expect(runsAnswer()).toEqual({
      board: METRICS_LIVE.board,
      generation: METRICS_LIVE.generation,
      sentinel: { runs: RUNS_LIST },
    });
    expect(runsAnswer([], 9).generation).toBe(9);
    expect(traceAnswer(null, null).sentinel).toEqual({ trace: null, summary: null });
    expect(traceAnswer(ACTIVE_TRACE, RECORDING_RUN, 3)).toMatchObject({
      generation: 3,
      sentinel: { trace: ACTIVE_TRACE, summary: RECORDING_RUN },
    });
    // A start answer has no summary at all.
    expect('summary' in traceAnswer(ACTIVE_TRACE).sentinel).toBe(false);
  });

  it('a saved run is the detail fixture, and overrides replace its parts', () => {
    expect(SAVED_RUN.metadata.id).toBe('20260923T152712.952Z-insight-hw-1790177227');
    expect(SAVED_RUN.samples).toHaveLength(4);
    expect(savedRun()).toEqual(SAVED_RUN);
    const other = savedRun({ samples: [] });
    expect(other.samples).toEqual([]);
    expect(other.metadata).toBe(SAVED_RUN.metadata);
  });

  it('the raw compare is the inner answer, with the baseline first', () => {
    expect(COMPARE_RAW.baseline_id).toBe(COMPARE_RAW.runs[0].metadata.id);
    expect(Object.keys(COMPARE_RAW.summaries).sort()).toEqual(
      COMPARE_RAW.runs.map((run) => run.metadata.id).sort(),
    );
  });
});
