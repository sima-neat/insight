import type { HostReadings } from './api';
import { hostNotice, hostView } from './host-readings';

const GiB = 1024 ** 3;

/** What `GET /api/system/host` answers, with what a test does not care about filled in. */
function readings(overrides: Partial<HostReadings> = {}): HostReadings {
  return {
    cpu_percent: 34,
    memory: { total: 16 * GiB, used: 8 * GiB, percent: 52 },
    disk: { path: '/home/sima', total: 200 * GiB, used: 120 * GiB, percent: 61 },
    ...overrides,
  };
}

describe('hostView', () => {
  it('lists CPU, memory used of total and disk used of total with its folder', () => {
    expect(hostView(readings())).toEqual({
      note: 'The machine Insight runs on, not the board.',
      empty: false,
      rows: [
        { term: 'CPU', value: '34%' },
        { term: 'Memory', value: '52% · 8.00 GB of 16.00 GB' },
        { term: 'Disk', value: '61% · 120.00 GB of 200.00 GB · /home/sima' },
      ],
    });
  });

  it('leaves out a reading that is not there, never a zero or a dash', () => {
    // The first CPU reading has nothing to compare with; a /proc file may be unreadable.
    expect(hostView(readings({ cpu_percent: null, disk: null })).rows).toEqual([
      { term: 'Memory', value: '52% · 8.00 GB of 16.00 GB' },
    ]);
  });

  it('keeps a percentage between 0 and 100', () => {
    expect(hostView(readings({ cpu_percent: 140 })).rows[0]).toEqual({
      term: 'CPU',
      value: '100%',
    });
    expect(hostView(readings({ cpu_percent: -3 })).rows[0]).toEqual({ term: 'CPU', value: '0%' });
  });

  it('leaves out the bytes of a negative count rather than formatting it', () => {
    const view = hostView(
      readings({
        cpu_percent: null,
        memory: { total: 16 * GiB, used: -5, percent: 52 },
        disk: null,
      }),
    );
    expect(view.rows).toEqual([{ term: 'Memory', value: '52%' }]);
  });
});

describe('hostNotice', () => {
  it('readings with no row say so instead of showing empty rows', () => {
    const empty = hostView({ cpu_percent: null, memory: null, disk: null });
    expect(empty.empty).toBe(true);
    expect(hostNotice(empty)).toBe(
      'Insight answered with no CPU, memory or disk reading for this computer, so none is shown rather than zeros.',
    );
    expect(hostNotice(hostView(readings()))).toBe('');
  });

  it('says Reading this computer… while no answer has come in', () => {
    expect(hostNotice(null)).toBe('Reading this computer…');
  });
});
