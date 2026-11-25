import type { RunSummary, SavedRun } from './api';
import {
  capChecked,
  MAX_CHECKED_RUNS,
  canCheckRun,
  checkBlockReason,
  formatRunTime,
  isRecording,
  isSavedRun,
  otherRunFields,
  parseTags,
  percentile,
  runFacts,
  runLine,
  runMetadataRows,
  runMetricRows,
  runWhen,
  traceName,
  undefinedKeys,
  validateTrace,
} from './runs';
import { ACTIVE_TRACE, RECORDING_RUN, RUNS_LIST, SAVED_RUN, savedRun } from './runs.testing';

const COMPLETE = RUNS_LIST[3];

/** A run summary with parts replaced. */
const summary = (extra: Partial<RunSummary>): RunSummary => ({ ...COMPLETE, ...extra });

/** A local time as the ISO string a sample carries, so the specs do not depend on the zone. */
const iso = (...parts: [number, number, number, number, number, number]): string =>
  new Date(...parts).toISOString();

describe('run lines', () => {
  it('a finished run reads state, duration, energy and samples', () => {
    expect(runLine(COMPLETE)).toBe('Complete · 34.3 s · 275 J · 17 samples');
  });

  it('the recording run says so, and an unmeasured energy is a dash', () => {
    expect(isRecording(RECORDING_RUN)).toBe(true);
    expect(isRecording(COMPLETE)).toBe(false);
    expect(runLine(RECORDING_RUN)).toBe('Recording · 12.0 s · 96 J · 7 samples');
    expect(runLine(summary({ energy_joules: null, samples: 1 }))).toBe(
      'Complete · 34.3 s · – · 1 sample',
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
  it('the recording run cannot be checked', () => {
    expect(canCheckRun(RECORDING_RUN)).toBe(false);
  });

  it('a finished run has a box', () => {
    expect(canCheckRun(COMPLETE)).toBe(true);
  });
});

describe('the cap on checked runs', () => {
  const ids = Array.from({ length: MAX_CHECKED_RUNS }, (_, i) => `checked-${i}`);

  it('is 8', () => {
    expect(MAX_CHECKED_RUNS).toBe(8);
  });

  it('blocks an unchecked run with the reason once 8 are checked', () => {
    expect(checkBlockReason(COMPLETE, ids)).toBe('At most 8 runs can be compared.');
  });

  it('blocks nothing below the cap, and never a checked run, which can always be unchecked', () => {
    expect(checkBlockReason(COMPLETE, ids.slice(1))).toBeNull();
    expect(checkBlockReason(summary({ id: ids[3] }), ids)).toBeNull();
  });
});

describe('capChecked', () => {
  const order = Array.from({ length: 12 }, (_, i) => `run-${i}`);

  it('leaves a selection within the cap as it is, in the order it was ticked', () => {
    const checked = ['run-5', 'run-1', 'run-3'];
    expect(capChecked(checked, order)).toBe(checked);
    const full = order.slice(0, MAX_CHECKED_RUNS).reverse();
    expect(capChecked(full, order)).toBe(full);
  });

  it('keeps the first 8 in display order when a bulk tick went past the cap', () => {
    expect(capChecked(order, order)).toEqual(order.slice(0, 8));
    // The display order decides, not the order the ticks came in; the survivors keep theirs.
    const shuffled = ['run-9', ...order.slice(0, 8).reverse(), 'run-11'];
    expect(capChecked(shuffled, order)).toEqual(order.slice(0, 8).reverse());
  });

  it('puts a run the list does not hold after the listed ones', () => {
    expect(capChecked(['gone', ...order.slice(0, 8)], order)).toEqual(order.slice(0, 8));
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

  it('sorts by group, then label, whatever the locale', () => {
    expect(runMetricRows(SAVED_RUN).map((row) => row.label)).toEqual([
      'CPU core 0 usage',
      'CPU core 11 usage',
      'eMMC disk used MB',
      'Linux memory used',
      'Current board power',
      'TOP RTSN-6',
    ]);
  });

  it('reads the statistics of a very long run without spreading its values', () => {
    const samples = Array.from({ length: 200_000 }, (_, i) => ({
      timestamp: SAVED_RUN.samples[0].timestamp,
      values: { rtsn_6: i % 1000 },
    }));
    const row = runMetricRows(savedRun({ samples })).find((r) => r.key === 'rtsn_6');
    expect(row).toMatchObject({ minimum: 0, maximum: 999, mean: 499.5, status: 'critical' });
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

  it('leaves a sample with an unreadable timestamp out of the range', () => {
    const run = savedRun({
      metrics: [],
      samples: [
        sample('nonsense'),
        sample(iso(2026, 9, 25, 8, 41, 10)),
        sample(iso(2026, 9, 25, 8, 41, 44)),
        sample(''),
      ],
    });
    expect(runFacts(run)).toBe('4 samples · 0 metrics · Oct 25, 08:41:10–08:41:44');
    expect(runFacts(savedRun({ metrics: [], samples: [sample('nonsense')] }))).toBe(
      '1 sample · 0 metrics',
    );
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
    expect(validateTrace('a\u007fb', '', [])).toBe('The name cannot contain control characters.');
    expect(validateTrace('a\u009fb', '', [])).toBe('The name cannot contain control characters.');
    expect(validateTrace('a\u00a0b', '', [])).toBeNull();
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
    expect(validateTrace('a', '', ['ok', '  '])).toBe('A tag cannot be empty.');
    expect(validateTrace('a', '', [''])).toBe('A tag cannot be empty.');
  });

  it('reports the first failure in the order name, note, tags', () => {
    expect(validateTrace('a,b', 'x'.repeat(513), ['x'.repeat(81)])).toMatch(/comma/);
    expect(validateTrace('a', 'x'.repeat(513), ['x'.repeat(81)])).toMatch(/note/);
  });
});

describe('formatRunTime', () => {
  it('words a time as its local date and time of day, and an unreadable one as nothing', () => {
    expect(formatRunTime(iso(2026, 9, 25, 8, 41, 10))).toBe('Oct 25, 08:41:10');
    expect(formatRunTime('nonsense')).toBe('');
    expect(formatRunTime(null)).toBe('');
  });
});

describe('runMetadataRows', () => {
  it('lists the id, times, sample interval, Sentinel version and the board facts', () => {
    const metadata = {
      ...SAVED_RUN.metadata,
      started_at: iso(2026, 8, 23, 15, 27, 12),
      ended_at: iso(2026, 8, 23, 15, 27, 19),
    };
    expect(runMetadataRows(metadata)).toEqual([
      { label: 'Id', value: '20260923T152712.952Z-insight-hw-1790177227' },
      { label: 'Started', value: 'Sep 23, 15:27:12' },
      { label: 'Ended', value: 'Sep 23, 15:27:19' },
      { label: 'Sample interval', value: '1989 ms' },
      { label: 'Sentinel version', value: 'main:80ab7de4da31' },
      { label: 'Architecture', value: 'aarch64' },
      { label: 'Board model', value: 'SiMa.ai Modalix SoM 16Gig Board' },
      { label: 'Hostname', value: 'modalix' },
      // The release file's own name for the system, rather than its every line.
      { label: 'OS release', value: 'eLxr 12 (aria)' },
    ]);
  });

  it('says what is not known, and keeps facts it has no name for under their key', () => {
    const metadata = {
      ...ACTIVE_TRACE,
      started_at: 'nonsense',
      sample_interval_ms: null,
      system: { os_release: 'NAME=Other', kernel: '6.1' },
    };
    expect(runMetadataRows(metadata)).toEqual([
      { label: 'Id', value: ACTIVE_TRACE.id },
      { label: 'Started', value: '–' },
      { label: 'Ended', value: 'Still recording' },
      { label: 'Sample interval', value: '–' },
      { label: 'Sentinel version', value: 'main:80ab7de4da31' },
      { label: 'OS release', value: 'NAME=Other' },
      { label: 'kernel', value: '6.1' },
    ]);
  });
});

describe('otherRunFields', () => {
  it('lists what a run carries besides its metadata, metrics and samples', () => {
    expect(otherRunFields(SAVED_RUN)).toEqual([]);
    const run = { ...SAVED_RUN, schema: 2, origin: 'cli', extra: { a: 1 } };
    expect(otherRunFields(run)).toEqual([
      { key: 'schema', value: '2' },
      { key: 'origin', value: 'cli' },
      { key: 'extra', value: '{"a":1}' },
    ]);
  });
});

describe('isSavedRun', () => {
  it('a body with a run’s parts is a run, one missing any is not', () => {
    expect(isSavedRun(SAVED_RUN)).toBe(true);
    expect(isSavedRun({ ...SAVED_RUN, samples: [] })).toBe(true);
    for (const body of [
      null,
      'run',
      [],
      { metrics: [], samples: [] },
      { ...SAVED_RUN, metadata: null },
      { ...SAVED_RUN, metrics: {} },
      { ...SAVED_RUN, samples: undefined },
    ]) {
      expect(isSavedRun(body)).toBe(false);
    }
  });
});
