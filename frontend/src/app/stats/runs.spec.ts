import type { RunSummary, SavedRun } from './api';
import {
  MAX_CHECKED_RUNS,
  canCheckRun,
  isRecording,
  parseTags,
  percentile,
  runFacts,
  runLine,
  runMetricRows,
  runWhen,
  traceName,
  undefinedKeys,
  validateTrace,
} from './runs';
import { RECORDING_RUN, RUNS_LIST, SAVED_RUN, savedRun } from './runs.testing';

const COMPLETE = RUNS_LIST[3];

/** A run summary with parts replaced. */
const summary = (extra: Partial<RunSummary>): RunSummary => ({ ...COMPLETE, ...extra });

/** A local time as the ISO string a sample carries, so the specs do not depend on the zone. */
const iso = (...parts: [number, number, number, number, number, number]): string =>
  new Date(...parts).toISOString();

describe('run lines', () => {
  it('a finished run reads state, duration, energy and samples', () => {
    expect(runLine(COMPLETE)).toBe('Complete · 34.4 s · 275 J · 17 samples');
  });

  it('the recording run says so, and an unmeasured energy is a dash', () => {
    expect(isRecording(RECORDING_RUN)).toBe(true);
    expect(isRecording(COMPLETE)).toBe(false);
    expect(runLine(RECORDING_RUN)).toBe('Recording · 12.0 s · 96 J · 7 samples');
    expect(runLine(summary({ energy_joules: null, samples: 1 }))).toBe(
      'Complete · 34.4 s · — · 1 sample',
    );
  });
});

describe('runWhen', () => {
  const now = new Date(2026, 9, 25, 12, 0, 0).getTime();

  it('is relative within a day', () => {
    expect(runWhen(iso(2026, 9, 25, 11, 0, 0), now)).toBe('1 h ago');
  });

  it('is a short date after a day, with the year when it is not this year', () => {
    expect(runWhen(iso(2026, 9, 23, 15, 27, 12), now)).toBe('Oct 23');
    expect(runWhen(iso(2025, 11, 31, 9, 0, 0), now)).toBe('Dec 31, 2025');
  });

  it('is empty for a time that cannot be read', () => {
    expect(runWhen('nonsense', now)).toBe('');
  });
});

describe('checking runs', () => {
  const ids = Array.from({ length: MAX_CHECKED_RUNS }, (_, i) => `checked-${i}`);

  it('the recording run cannot be checked', () => {
    expect(canCheckRun(RECORDING_RUN, [])).toBe(false);
  });

  it('a ninth run cannot be checked, but a checked one can be unchecked', () => {
    expect(MAX_CHECKED_RUNS).toBe(8);
    expect(canCheckRun(COMPLETE, ids)).toBe(false);
    expect(canCheckRun(COMPLETE, ids.slice(1))).toBe(true);
    expect(canCheckRun(summary({ id: ids[3] }), ids)).toBe(true);
  });
});

describe('runMetricRows', () => {
  it('computes the statistics of a metric from the run own samples', () => {
    const row = runMetricRows(SAVED_RUN).find((r) => r.key === 'rtsn_6');
    expect(row).toMatchObject({
      key: 'rtsn_6',
      label: 'TOP RTSN-6',
      group: 'TOP',
      unit: 'C',
      minimum: 39.490478515625,
      maximum: 40.3436279296875,
      status: 'ok',
    });
    expect(row?.mean).toBeCloseTo(39.7891, 3);
  });

  it('rates the maximum against the warn and critical thresholds', () => {
    const peak = (value: number) =>
      runMetricRows(
        savedRun({
          samples: [
            { timestamp: SAVED_RUN.samples[0].timestamp, values: { rtsn_6: 30 } },
            { timestamp: SAVED_RUN.samples[1].timestamp, values: { rtsn_6: value } },
          ],
        }),
      ).find((r) => r.key === 'rtsn_6')?.status;
    expect(peak(69.9)).toBe('ok');
    expect(peak(70)).toBe('warn');
    expect(peak(85)).toBe('critical');
  });

  it('leaves the statistics null for a metric with no reading and the unit null for none', () => {
    const run = savedRun({
      metrics: [
        {
          ...SAVED_RUN.metrics[0],
          key: 'none',
          label: 'None',
          unit: '',
          warn: null,
          critical: null,
        },
      ],
      samples: [{ timestamp: SAVED_RUN.samples[0].timestamp, values: { none: null } }],
    });
    expect(runMetricRows(run)).toEqual([
      {
        key: 'none',
        label: 'None',
        group: SAVED_RUN.metrics[0].group,
        unit: null,
        mean: null,
        minimum: null,
        maximum: null,
        status: 'ok',
      },
    ]);
  });

  it('sorts by group, then label', () => {
    const rows = runMetricRows(SAVED_RUN);
    const sorted = [...rows].sort(
      (a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label),
    );
    expect(rows.map((r) => r.key)).toEqual(sorted.map((r) => r.key));
    expect(rows).toHaveLength(SAVED_RUN.metrics.length);
  });
});

describe('runFacts', () => {
  const sample = (stamp: string) => ({ timestamp: stamp, values: { rtsn_6: 40 } });
  const two = (hot: number): SavedRun =>
    savedRun({
      metrics: [SAVED_RUN.metrics[0]],
      samples: [
        sample(iso(2026, 9, 25, 8, 41, 10)),
        { ...sample(iso(2026, 9, 25, 8, 41, 44)), values: { rtsn_6: hot } },
      ],
    });

  it('counts samples and metrics and gives the time range', () => {
    expect(runFacts(two(40))).toBe('2 samples · 1 metric · Oct 25, 08:41:10–08:41:44');
  });

  it('adds how many metrics reached a threshold, and omits the clause at none', () => {
    expect(runFacts(two(72))).toBe(
      '2 samples · 1 metric · Oct 25, 08:41:10–08:41:44 · 1 past a threshold',
    );
  });

  it('names the date twice when the run crosses midnight', () => {
    const run = savedRun({
      samples: [sample(iso(2026, 9, 25, 23, 59, 50)), sample(iso(2026, 9, 26, 0, 0, 10))],
    });
    expect(runFacts(run)).toContain('Oct 25, 23:59:50–Oct 26, 00:00:10');
  });

  it('gives a single sample as one timestamp, and none as no time', () => {
    const one = savedRun({ metrics: [], samples: [sample(iso(2026, 9, 25, 8, 41, 10))] });
    expect(runFacts(one)).toBe('1 sample · 0 metrics · Oct 25, 08:41:10');
    expect(runFacts(savedRun({ metrics: [], samples: [] }))).toBe('0 samples · 0 metrics');
  });
});

describe('undefinedKeys', () => {
  it('lists the sample keys with no definition, once and in order', () => {
    expect(undefinedKeys(SAVED_RUN)).toEqual([]);
    const run = savedRun({
      samples: [
        { timestamp: 'a', values: { rtsn_6: 1, zeta: 2, alpha: null } },
        { timestamp: 'b', values: { alpha: 1, rtsn_6: 2 } },
      ],
    });
    expect(undefinedKeys(run)).toEqual(['alpha', 'zeta']);
  });
});

describe('percentile', () => {
  it('rounds the rank as Sentinel does', () => {
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3);
    expect(percentile([7], 0.95)).toBe(7);
  });

  it('is null for no values', () => {
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('trace names and tags', () => {
  it('prefills the name from the local time', () => {
    expect(traceName(new Date(2026, 9, 25, 8, 41))).toBe('run-2026-10-25-0841');
  });

  it('parseTags splits on commas, trims, and drops empties and repeats', () => {
    expect(parseTags(' a, b,,a ')).toEqual(['a', 'b']);
    expect(parseTags('')).toEqual([]);
  });
});

describe('validateTrace', () => {
  it('accepts a good trace', () => {
    expect(validateTrace(' compiler-v2 ', 'a note', ['a', 'b'])).toBeNull();
  });

  it('asks for a name', () => {
    expect(validateTrace('  ', '', [])).toBe('Name the trace so you can find its run later.');
  });

  it('counts the name in UTF-8 bytes, not characters', () => {
    const message = 'The name can be at most 80 UTF-8 bytes.';
    expect(validateTrace('é'.repeat(41), '', [])).toBe(message);
    expect(validateTrace('é'.repeat(40), '', [])).toBeNull();
  });

  it('refuses control characters and a comma in the name', () => {
    expect(validateTrace('a\nb', '', [])).toBe('The name cannot contain control characters.');
    expect(validateTrace('a\u0085b', '', [])).toBe('The name cannot contain control characters.');
    expect(validateTrace('a,b', '', [])).toBe(
      'The name cannot contain a comma; runs are compared by a comma-separated list of names.',
    );
  });

  it('limits the note to 512 characters', () => {
    const message = 'The note can be at most 512 characters.';
    expect(validateTrace('a', 'x'.repeat(513), [])).toBe(message);
    expect(validateTrace('a', 'x'.repeat(512), [])).toBeNull();
    // Characters, not UTF-16 units: 512 emoji are fine.
    expect(validateTrace('a', '😀'.repeat(512), [])).toBeNull();
  });

  it('limits the tags to 16 of at most 80 characters', () => {
    expect(
      validateTrace(
        'a',
        '',
        Array.from({ length: 17 }, (_, i) => `t${i}`),
      ),
    ).toBe('At most 16 tags can be attached to a trace.');
    expect(validateTrace('a', '', ['x'.repeat(81)])).toBe('A tag can be at most 80 characters.');
    expect(validateTrace('a', '', ['x'.repeat(80)])).toBeNull();
  });

  it('reports the first failure in the order name, note, tags', () => {
    expect(validateTrace('a,b', 'x'.repeat(513), ['x'.repeat(81)])).toMatch(/comma/);
    expect(validateTrace('a', 'x'.repeat(513), ['x'.repeat(81)])).toMatch(/note/);
  });
});
