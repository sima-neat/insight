import type { NeatTone } from '@sima/neat-ui';
import { NO_VALUE } from '../no-value';
import type { ExposedPort, NeatComponent, SystemInsight, SystemNeat } from './api';

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
 * word is capitalized and the rest lowercased, and the acronyms keep their spelling
 * (`sdkVersion` is "SDK version", `rtsp.tcp` is "RTSP TCP"); `duration_ms` reads "Duration".
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
 * A value of `neat`'s answer as text. A boolean is Yes or No in words, never a chip: a tone for
 * it would be wrong, since `offline: true` would read as good news.
 */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return NO_VALUE;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.join(', ') : NO_VALUE;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** A term and its value, in words. */
export type Entry = readonly [term: string, value: string];

/** A section of `neat`'s answer as words, one entry per field. */
export function entriesOf(section: object | undefined): Entry[] {
  return Object.entries(section ?? {}).map(([key, value]) => [
    readableKey(key),
    displayValue(value),
  ]);
}

/** Where Insight runs, in words. */
const PLACES: Record<SystemInsight['place'], string> = {
  board: 'On the board',
  sdk: 'In the Neat SDK',
  host: 'On this computer',
};

/** A port range as "9200–9215", or the one port. */
function range(start: number, end: number): string {
  return start === end ? `${start}` : `${start}–${end}`;
}

/**
 * Insight's own section: its version and build, where it runs, its data folder and address, the
 * network and ports it resolved at start, then what `neat` says of its service (`service`, absent
 * while neat has not answered). A fact Insight did not resolve (no public origin, the SDK's RTSP
 * port 0) is left out; a resolved value keeps the source it came from beside it.
 */
export function insightEntries(insight: SystemInsight, service?: SystemNeat['insight']): Entry[] {
  const { build, network, ports } = insight;
  const buildText = [
    build.revision && `${build.revision.slice(0, 12)}${build.modified ? ' (modified)' : ''}`,
    build.time,
    build.go_version,
    build.platform,
  ]
    .filter(Boolean)
    .join(' · ');
  const entries: (Entry | false | '' | null | undefined)[] = [
    ['Version', insight.version],
    ['Build', buildText],
    ['Runs', PLACES[insight.place] ?? insight.place],
    ['Web UI URL', insight.web_ui_url],
    ['Port', String(insight.port)],
    ['Data folder', insight.data_dir],
    ['Certificate host', network.certificate_host],
    network.browser_ice_address && [
      'Browser ICE address',
      `${network.browser_ice_address} (${network.browser_ice_address_source})`,
    ],
    network.public_origin && ['Public origin', network.public_origin],
    network.url_routing && ['URL routing', network.url_routing],
    ['Channels', `${ports.channels} (${ports.channels_source})`],
    ['WebRTC ports', range(ports.webrtc_start, ports.webrtc_end)],
    ports.rtsp > 0 && ['RTSP port', String(ports.rtsp)],
    ['WHIP port', String(ports.whip)],
    ['WHIP ICE port', String(ports.whip_ice)],
    service?.serviceState && ['Service state', service.serviceState],
    service?.venv && ['Virtual environment', service.venv],
  ];
  return entries.filter((entry): entry is Entry => !!entry);
}

export interface ComponentStatus {
  label: string;
  tone: NeatTone;
}

/**
 * A component's status chip, or null when there is nothing to say: a service's state; otherwise,
 * for a component that is not known to be missing, whether an update is available. A component
 * that is not installed has no update status ("Current" would be untrue).
 */
export function componentStatus(component: Partial<NeatComponent>): ComponentStatus | null {
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

/**
 * A component's version line: `1.2.0 / tag v1.2.0 / channel stable`, or `NO_VALUE` when it has
 * none.
 */
export function componentVersion(component: Partial<NeatComponent>): string {
  const parts = [
    component.version,
    component.tag && `tag ${component.tag}`,
    component.channel && `channel ${component.channel}`,
  ].filter(Boolean);
  return parts.join(' / ') || NO_VALUE;
}

/** An exposed port as `TCP 9900`, or `UDP 9000–9079` for a range; `NO_VALUE` without a port. */
export function portSummary(port: ExposedPort): string {
  const { hostPortStart: start, hostPortEnd: end } = port;
  if (start === null || start === undefined) return NO_VALUE;
  const ports = end === null || end === undefined ? `${start}` : range(start, end);
  return port.protocol ? `${port.protocol.toUpperCase()} ${ports}` : ports;
}

/**
 * The muted line under a component: the latest version when it differs from the installed one
 * (an update to take; equal, it would only repeat the version above), else what `neat` says
 * about the component, else its virtual environment. Empty when there is none.
 */
export function componentNote(component: Partial<NeatComponent>): string {
  const { latestVersion, version } = component;
  if (latestVersion && latestVersion !== version) return `Latest ${latestVersion}`;
  return component.detail || component.venv || '';
}
