import type { NeatTone } from '@sima/neat-ui';
import type { ExposedPort, SystemComponent } from './api';

/** Words that keep their own spelling in a key, by their lowercase form. */
const ACRONYMS: Record<string, string> = {
  sdk: 'SDK',
  ui: 'UI',
  url: 'URL',
  devkit: 'DevKit',
  id: 'ID',
  ip: 'IP',
  tcp: 'TCP',
  udp: 'UDP',
  rtsp: 'RTSP',
  rtp: 'RTP',
  webrtc: 'WebRTC',
  whip: 'WHIP',
  ice: 'ICE',
  ssh: 'SSH',
  json: 'JSON',
};

/**
 * A key of `neat`'s answer as words: camelCase, snake_case and dotted keys are split, the first
 * word is capitalised and the rest lowercased, and the acronyms keep their spelling
 * (`sdkVersion` is "SDK version", `rtsp.tcp` is "RTSP TCP"). #170 only split on `_`, so it
 * showed "SdkVersion" (Inv-PB §6.4); its one special case, `duration_ms` as "Duration", stays.
 */
export function readableKey(key: string): string {
  if (key === 'duration_ms') return 'Duration';
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words
    .map(
      (word, index) =>
        ACRONYMS[word] ?? (index === 0 ? word[0].toUpperCase() + word.slice(1) : word),
    )
    .join(' ');
}

/**
 * A value of `neat`'s answer as text. A boolean is Yes or No in words, never a chip: #170's
 * tone for it was wrong, since `offline: true` read as good news (Inv-PB §6.5).
 */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface ComponentStatus {
  label: string;
  tone: NeatTone;
}

/**
 * A component's status chip, or null when there is nothing to say: a service's state; otherwise,
 * for a component that is not known to be missing, whether an update is available. A component
 * that is not installed has no update status (#170 showed "-"; "Current" would be untrue).
 */
export function componentStatus(component: SystemComponent): ComponentStatus | null {
  if (component.serviceState) {
    return {
      label: component.serviceState,
      tone: component.serviceState.toLowerCase() === 'running' ? 'success' : 'neutral',
    };
  }
  if (component.installed === false) return null;
  if (component.updateAvailable === true) return { label: 'Update available', tone: 'warning' };
  if (component.updateAvailable === false) return { label: 'Current', tone: 'success' };
  return null;
}

/** A component's version line: `1.2.0 / tag v1.2.0 / channel stable`, or "-" when it has none. */
export function componentVersion(component: SystemComponent): string {
  const parts = [
    component.version,
    component.tag && `tag ${component.tag}`,
    component.channel && `channel ${component.channel}`,
  ].filter(Boolean);
  return parts.join(' / ') || '-';
}

/** An exposed port as `TCP 9900`, or `UDP 9000–9079` for a range; "-" when it has no port. */
export function portSummary(port: ExposedPort): string {
  const { hostPortStart: start, hostPortEnd: end } = port;
  if (start === null || start === undefined) return '-';
  const range = end === null || end === undefined || end === start ? `${start}` : `${start}–${end}`;
  return port.protocol ? `${port.protocol.toUpperCase()} ${range}` : range;
}

/**
 * The muted line under a component: the latest version when it differs from the installed one
 * (an update to take; equal, it would only repeat the version above), else what `neat` says
 * about the component, else its virtual environment. Empty when there is none.
 */
export function componentNote(component: SystemComponent): string {
  const { latestVersion, version } = component;
  if (latestVersion && latestVersion !== version) return `Latest ${latestVersion}`;
  return component.detail || component.venv || '';
}
