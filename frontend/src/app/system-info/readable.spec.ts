import type { SystemInsight } from './api';
import {
  componentNote,
  componentStatus,
  componentVersion,
  displayValue,
  entriesOf,
  insightEntries,
  portSummary,
  readableKey,
} from './readable';

/** Insight's own facts as `GET /api/system` answers them in the SDK. */
const INSIGHT: SystemInsight = {
  version: '0.12.0',
  build: { go_version: 'go1.26.0', platform: 'linux/arm64' },
  place: 'sdk',
  data_dir: '/home/sima/.local/share/neat-insight',
  port: 9900,
  web_ui_url: 'https://10.1.1.5:9900',
  network: { certificate_host: '10.1.1.5', browser_ice_address_source: 'default' },
  ports: {
    channels: 16,
    channels_source: 'port map',
    webrtc_start: 9200,
    webrtc_end: 9215,
    rtsp: 8554,
    whip: 8889,
    whip_ice: 8189,
  },
};

describe('insightEntries', () => {
  it('lists Insight’s version, build, place, addresses and ports, then neat’s word on its service', () => {
    expect(insightEntries(INSIGHT, { serviceState: 'Running', venv: '/opt/insight' })).toEqual([
      ['Version', '0.12.0'],
      ['Build', 'go1.26.0 · linux/arm64'],
      ['Runs', 'In the Neat SDK'],
      ['Web UI URL', 'https://10.1.1.5:9900'],
      ['Port', '9900'],
      ['Data folder', '/home/sima/.local/share/neat-insight'],
      ['Certificate host', '10.1.1.5'],
      ['Channels', '16 (port map)'],
      ['WebRTC ports', '9200–9215'],
      ['RTSP port', '8554'],
      ['WHIP port', '8889'],
      ['WHIP ICE port', '8189'],
      ['Service state', 'Running'],
      ['Virtual environment', '/opt/insight'],
    ]);
  });

  it('adds the build’s revision and time and the network’s resolved addresses, and leaves out what was not resolved', () => {
    const entries = insightEntries({
      ...INSIGHT,
      place: 'board',
      build: {
        ...INSIGHT.build,
        revision: '0123456789abcdef0123',
        time: '2026-11-18T12:00:00Z',
        modified: true,
      },
      network: {
        certificate_host: 'devkit.local',
        browser_ice_address: '192.168.1.20',
        browser_ice_address_source: 'flag',
        public_origin: 'https://insight.example.com',
        url_routing: 'path',
      },
      ports: { ...INSIGHT.ports, rtsp: 0 },
    });
    expect(entries).toContainEqual([
      'Build',
      '0123456789ab (modified) · 2026-11-18T12:00:00Z · go1.26.0 · linux/arm64',
    ]);
    expect(entries).toContainEqual(['Runs', 'On the board']);
    expect(entries).toContainEqual(['Browser ICE address', '192.168.1.20 (flag)']);
    expect(entries).toContainEqual(['Public origin', 'https://insight.example.com']);
    expect(entries).toContainEqual(['URL routing', 'path']);
    // The SDK publishes no RTSP port here, and neat has not answered.
    expect(entries.map(([term]) => term)).not.toContain('RTSP port');
    expect(entries.map(([term]) => term)).not.toContain('Service state');
  });
});

describe('entriesOf', () => {
  it('lists a section of neat’s answer as words', () => {
    expect(entriesOf({ sdkVersion: '2.1.0', offline: true, errors: ['a', 'b'] })).toEqual([
      ['SDK version', '2.1.0'],
      ['Offline', 'Yes'],
      ['Errors', 'a, b'],
    ]);
    expect(entriesOf(undefined)).toEqual([]);
  });
});

describe('readableKey', () => {
  it('readableKey reads camelCase, snake_case and dotted keys as words with their acronyms', () => {
    expect(readableKey('sdkVersion')).toBe('SDK version');
    expect(readableKey('devkitBuildVersion')).toBe('DevKit build version');
    expect(readableKey('webUiUrl')).toBe('Web UI URL');
    expect(readableKey('rtsp.tcp')).toBe('RTSP TCP');
    expect(readableKey('webrtcWhipIce')).toBe('WebRTC WHIP ICE');
    expect(readableKey('serviceState')).toBe('Service state');
    expect(readableKey('mainUI')).toBe('Main UI');
    expect(readableKey('venv')).toBe('Venv');
    expect(readableKey('neat_core')).toBe('Neat core');
    expect(readableKey('Sysroot')).toBe('Sysroot');
  });

  it('keeps its one special case: duration_ms reads "Duration"', () => {
    expect(readableKey('duration_ms')).toBe('Duration');
  });
});

describe('displayValue', () => {
  it('displayValue writes booleans as Yes/No text and empty values as -', () => {
    expect(displayValue(true)).toBe('Yes');
    expect(displayValue(false)).toBe('No');
    expect(displayValue(null)).toBe('-');
    expect(displayValue(undefined)).toBe('-');
    expect(displayValue('')).toBe('-');
  });

  it('joins arrays, writes objects as JSON and everything else as text', () => {
    expect(displayValue(['a', 'b'])).toBe('a, b');
    expect(displayValue([])).toBe('-');
    expect(displayValue({ a: 1 })).toBe('{"a":1}');
    expect(displayValue(0)).toBe('0');
    expect(displayValue('9.1')).toBe('9.1');
  });
});

describe('componentStatus', () => {
  it('says a service’s state, running in the success tone', () => {
    expect(componentStatus({ serviceState: 'Running' })).toEqual({
      label: 'Running',
      tone: 'success',
    });
    expect(componentStatus({ serviceState: 'Stopped', updateAvailable: true })).toEqual({
      label: 'Stopped',
      tone: 'neutral',
    });
  });

  it('says whether an update is available, once the component is known to be installed', () => {
    expect(componentStatus({ updateAvailable: true })).toEqual({
      label: 'Update available',
      tone: 'warning',
    });
    expect(componentStatus({ updateAvailable: false })).toEqual({
      label: 'Current',
      tone: 'success',
    });
    expect(componentStatus({ updateAvailable: null })).toBeNull();
    expect(componentStatus({})).toBeNull();
  });

  it('says nothing of the update for a component that is not installed', () => {
    expect(componentStatus({ installed: false, updateAvailable: false })).toBeNull();
    expect(componentStatus({ installed: false, updateAvailable: true })).toBeNull();
  });
});

describe('componentVersion', () => {
  it('joins the version, tag and channel that are set', () => {
    expect(componentVersion({ version: '1.4.0', tag: 'v1.4.0', channel: 'stable' })).toBe(
      '1.4.0 / tag v1.4.0 / channel stable',
    );
    expect(componentVersion({ tag: 'v1.4.0' })).toBe('tag v1.4.0');
    expect(componentVersion({ version: null, tag: '' })).toBe('-');
  });
});

describe('portSummary', () => {
  it('writes the protocol and the port, or the range', () => {
    expect(
      portSummary({ name: 'mainUI', protocol: 'tcp', hostPortStart: 9900, hostPortEnd: 9900 }),
    ).toBe('TCP 9900');
    expect(
      portSummary({ name: 'rtp', protocol: 'udp', hostPortStart: 9000, hostPortEnd: 9079 }),
    ).toBe('UDP 9000–9079');
    expect(portSummary({ name: 'x', protocol: 'tcp', hostPortStart: 80, hostPortEnd: null })).toBe(
      'TCP 80',
    );
    expect(portSummary({ name: 'x', hostPortStart: 80, hostPortEnd: null })).toBe('80');
    expect(
      portSummary({ name: 'x', protocol: 'tcp', hostPortStart: null, hostPortEnd: null }),
    ).toBe('-');
  });
});

describe('componentNote', () => {
  it('says the latest version only when it differs from the installed one', () => {
    expect(componentNote({ version: '0.9.1', latestVersion: '0.10.0' })).toBe('Latest 0.10.0');
    // Nothing installed to compare with: the latest is still news.
    expect(componentNote({ latestVersion: '0.10.0' })).toBe('Latest 0.10.0');
    expect(componentNote({ version: '0.9.2', latestVersion: '0.9.2' })).toBe('');
  });

  it('otherwise gives the detail, then the venv, as they are', () => {
    expect(
      componentNote({ version: '0.9.2', latestVersion: '0.9.2', detail: 'Not installed' }),
    ).toBe('Not installed');
    expect(componentNote({ detail: 'From a wheel', venv: '/opt/sdk' })).toBe('From a wheel');
    expect(componentNote({ venv: '/opt/sdk' })).toBe('/opt/sdk');
    expect(componentNote({})).toBe('');
    expect(componentNote({ latestVersion: null, detail: null, venv: '' })).toBe('');
  });
});
