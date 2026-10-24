import type { HostMetrics } from './api';
import { hostNotice, hostReadings } from './host-readings';

const GB = 1024 ** 3;

/** A local machine with every reading present; a test overrides what it is about. */
function host(overrides: Partial<HostMetrics> = {}): HostMetrics {
  return {
    cpu_load: 34,
    memory: { total: 16 * GB, used: 8 * GB, percent: 50 },
    disk: { mount: '/home/sima', total: 200 * GB, used: 120 * GB, percent: 60 },
    temperature_celsius_avg: null,
    REMOTE: false,
    ...overrides,
  };
}

describe('hostReadings', () => {
  it('the Insight host snapshot is modelled apart from the board telemetry, and an absent reading stays absent', () => {
    const readings = hostReadings(host({ cpu_load: 12.5 }));
    expect([readings.source, readings.offline, readings.empty]).toEqual(['local', false, false]);
    expect(readings.note).toBe('The machine Insight runs on, not the board.');
    expect(readings.rows).toEqual([
      { term: 'CPU', value: '12.5%' },
      { term: 'Memory', value: '50% · 8.00 GB of 16.00 GB' },
      { term: 'Disk', value: '60% · 120.00 GB of 200.00 GB · /home/sima' },
    ]);

    // What is not there has no row: no "0%", no dash.
    const partial = hostReadings(
      host({ cpu_load: 5, memory: {}, disk: null, temperature_celsius_avg: 46.5 }),
    );
    expect(partial.rows).toEqual([
      { term: 'CPU', value: '5%' },
      { term: 'Temperature', value: '46.5 °C' },
    ]);

    // A percentage with no byte counts is shown alone, and the bytes with no percentage likewise.
    expect(
      hostReadings(host({ cpu_load: null, memory: { percent: 37.3 }, disk: { used: 2 * GB } }))
        .rows,
    ).toEqual([{ term: 'Memory', value: '37.3%' }]);
    expect(
      hostReadings(
        host({ cpu_load: null, memory: { total: 4 * GB, used: GB }, disk: { mount: '/data' } }),
      ).rows,
    ).toEqual([{ term: 'Memory', value: '1.00 GB of 4.00 GB' }]);
  });

  it('keeps a percentage between 0 and 100', () => {
    const readings = hostReadings(host({ memory: { percent: 140 }, disk: { percent: -3 } }));
    expect(readings.rows.map((row) => row.value)).toEqual(['34%', '100%', '0%']);
  });

  it('leaves out the bytes of a negative or non-numeric count rather than formatting it', () => {
    const readings = hostReadings(
      host({
        cpu_load: null,
        memory: { total: -5, used: 10, percent: 20 },
        disk: { total: Number.NaN, used: 1, percent: 30, mount: '/' },
      }),
    );
    expect(readings.rows).toEqual([
      { term: 'Memory', value: '20%' },
      { term: 'Disk', value: '30% · /' },
    ]);
  });

  it('shows the temperature only when Insight reports one, never a remote 0', () => {
    const temperature = (overrides: Partial<HostMetrics>) =>
      hostReadings(host(overrides)).rows.find((row) => row.term === 'Temperature');
    expect(temperature({ temperature_celsius_avg: 48.5 })).toEqual({
      term: 'Temperature',
      value: '48.5 °C',
    });
    // A local 0 is a reading.
    expect(temperature({ temperature_celsius_avg: 0 })?.value).toBe('0 °C');
    expect(temperature({ temperature_celsius_avg: null })).toBeUndefined();
    expect(temperature({ temperature_celsius_avg: undefined })).toBeUndefined();
    expect(temperature({ REMOTE: true, temperature_celsius_avg: 0 })).toBeUndefined();
    expect(temperature({ REMOTE: true, temperature_celsius_avg: 41 })?.value).toBe('41 °C');
  });

  it('a remote DevKit says so, and one that is not connected says it reports nothing', () => {
    const connected = hostReadings(host({ REMOTE: true }));
    expect([connected.source, connected.offline]).toEqual(['remote', false]);
    expect(connected.note).toBe(
      'Remote DevKit from the legacy REMOTE_DEVKIT configuration, not the board.',
    );
    expect(connected.rows).toHaveLength(3);

    const offline = hostReadings({
      cpu_load: '',
      memory: {},
      disk: {},
      temperature_celsius_avg: 0,
      REMOTE: true,
    });
    expect([offline.source, offline.offline, offline.empty, offline.rows]).toEqual([
      'remote',
      true,
      false,
      [],
    ]);
    expect(hostNotice(offline)).toBe(
      'A remote DevKit is configured for this endpoint but is not connected, so it reports nothing.',
    );
  });

  it('This computer lists CPU, memory used of total and disk used of total with its mount', () => {
    const readings = hostReadings(
      host({
        cpu_load: 34,
        memory: { total: 16 * GB, used: 8 * GB, percent: 52 },
        disk: { mount: '/home/sima', total: 200 * GB, used: 120 * GB, percent: 61 },
      }),
    );
    // The shared byte formatter: two decimals from 1 GB, as Media and Streaming show sizes.
    expect(readings.rows).toEqual([
      { term: 'CPU', value: '34%' },
      { term: 'Memory', value: '52% · 8.00 GB of 16.00 GB' },
      { term: 'Disk', value: '61% · 120.00 GB of 200.00 GB · /home/sima' },
    ]);
  });
});

describe('hostNotice', () => {
  it('a host snapshot with no readings says so instead of showing empty rows', () => {
    const empty = hostReadings(host({ cpu_load: null, memory: {}, disk: null }));
    expect([empty.empty, empty.rows]).toEqual([true, []]);
    expect(hostNotice(empty)).toBe(
      'Insight answered with no CPU, memory or disk reading for this computer, so none is shown rather than zeros.',
    );
    expect(
      hostNotice(hostReadings(host({ REMOTE: true, memory: {}, disk: {}, cpu_load: null }))),
    ).toMatch(/not connected/);
    expect(hostNotice(hostReadings(host()))).toBe('');
  });

  it('a temperature alone is something to show, not an empty snapshot', () => {
    const readings = hostReadings(
      host({ cpu_load: null, memory: {}, disk: null, temperature_celsius_avg: 40 }),
    );
    expect([readings.empty, hostNotice(readings)]).toEqual([false, '']);
  });

  it('says Reading this computer… while no answer has come in', () => {
    expect(hostNotice(null)).toBe('Reading this computer…');
  });
});
