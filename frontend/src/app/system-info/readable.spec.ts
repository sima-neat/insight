import {
  componentStatus,
  componentVersion,
  displayValue,
  portSummary,
  readableKey,
} from './readable';

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

  it('keeps #170’s special case: duration_ms reads "Duration"', () => {
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

  it('says nothing of the update for a component that is not installed (#170 showed "-")', () => {
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
    expect(portSummary({ name: 'x', protocol: 'tcp', hostPortStart: 80 })).toBe('TCP 80');
    expect(portSummary({ name: 'x', hostPortStart: 80 })).toBe('80');
    expect(portSummary({ name: 'x', protocol: 'tcp', hostPortStart: null })).toBe('-');
  });
});
