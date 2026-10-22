// Test support for the specs of the egress report and the connection that sends it.

import type { NeatFrameStats } from '@sima/neat-ui';

/**
 * vf's `BrowserEgressReport` (egress_stats.go, Inv §2c). vf unmarshals the whole report at once,
 * so one field of the wrong JSON type (a fraction in an integer, a string in a number) drops the
 * report silently. `uint`/`int` must be whole numbers, `float1` keeps at most one decimal place,
 * and `optional` fields are Go pointers or `omitempty` values the browser may lack: they are
 * omitted, never sent as null.
 */
type Kind = 'string' | 'int' | 'uint' | 'float' | 'float1' | 'bool';
interface Field {
  kind: Kind;
  optional?: true;
}
const VF_SCHEMA: Record<string, Record<string, Field>> = {
  '': { type: { kind: 'string' }, channel: { kind: 'int' }, time: { kind: 'string' } },
  connection: {
    connection_state: { kind: 'string' },
    ice_connection_state: { kind: 'string' },
    ice_gathering_state: { kind: 'string' },
    signaling_state: { kind: 'string' },
  },
  inbound_rtp: {
    bytes_received: { kind: 'uint', optional: true },
    packets_received: { kind: 'uint', optional: true },
    packets_lost: { kind: 'int', optional: true },
    frames_received: { kind: 'uint', optional: true },
    frames_decoded: { kind: 'uint', optional: true },
    frames_dropped: { kind: 'uint', optional: true },
    frames_per_second: { kind: 'float', optional: true },
    decoder_implementation: { kind: 'string', optional: true },
    power_efficient_decoder: { kind: 'bool', optional: true },
    frame_width: { kind: 'uint', optional: true },
    frame_height: { kind: 'uint', optional: true },
    freeze_count: { kind: 'uint', optional: true },
    pause_count: { kind: 'uint', optional: true },
    bitrate_bps: { kind: 'float1' },
    average_jitter_buffer_delay_ms: { kind: 'float1' },
  },
  video: {
    ready_state: { kind: 'uint' },
    paused: { kind: 'bool' },
    current_time: { kind: 'float' },
    video_width: { kind: 'uint', optional: true },
    video_height: { kind: 'uint', optional: true },
    last_frame_age_ms: { kind: 'int', optional: true },
    active: { kind: 'bool' },
  },
  data_channel: {
    state: { kind: 'string' },
    metadata_messages_per_sec: { kind: 'uint' },
  },
  synchronization: {
    video_sync_buffer_ms: { kind: 'uint' },
    metadata_retention_ms: { kind: 'uint' },
    jitter_buffer_target_supported: { kind: 'bool' },
    jitter_buffer_target_applied: { kind: 'bool' },
    jitter_buffer_target_ms: { kind: 'float' },
    timestamp_matches: { kind: 'uint' },
    arrival_fallbacks: { kind: 'uint' },
    frame_misses: { kind: 'uint' },
    metadata_expired: { kind: 'uint' },
    metadata_evicted: { kind: 'uint' },
    metadata_late: { kind: 'uint' },
    metadata_lateness_recent_median_ms: { kind: 'float', optional: true },
    metadata_lateness_recent_max_ms: { kind: 'float', optional: true },
    untimestamped_metadata_received: { kind: 'uint' },
    timestamped_metadata_pending: { kind: 'uint' },
    arrival_metadata_pending: { kind: 'uint' },
  },
};

function hasKind(value: unknown, kind: Kind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'bool':
      return typeof value === 'boolean';
    case 'int':
      return Number.isInteger(value);
    case 'uint':
      return Number.isInteger(value) && (value as number) >= 0;
    case 'float':
      return typeof value === 'number' && Number.isFinite(value);
    case 'float1':
      return typeof value === 'number' && Math.round(value * 10) / 10 === value;
  }
}

/** Every mismatch between a report and the schema, as `group.field: problem`. */
export function schemaViolations(report: object, requireOptional: boolean): string[] {
  const violations: string[] = [];
  const root = report as Record<string, unknown>;
  for (const [group, fields] of Object.entries(VF_SCHEMA)) {
    const values = (group === '' ? root : root[group]) as Record<string, unknown> | undefined;
    if (typeof values !== 'object' || values === null) {
      violations.push(`${group}: missing`);
      continue;
    }
    for (const [name, field] of Object.entries(fields)) {
      const present = Object.hasOwn(values, name);
      if (!present) {
        if (requireOptional || !field.optional) violations.push(`${group}.${name}: missing`);
        continue;
      }
      if (!hasKind(values[name], field.kind)) {
        violations.push(`${group}.${name}: ${JSON.stringify(values[name])} is not ${field.kind}`);
      }
    }
    const known = new Set(Object.keys(fields));
    if (group !== '') {
      for (const name of Object.keys(values)) {
        if (!known.has(name)) violations.push(`${group}.${name}: not in vf's schema`);
      }
    }
  }
  const groups = new Set(Object.keys(VF_SCHEMA));
  for (const name of Object.keys(root)) {
    if (!groups.has(name) && !Object.hasOwn(VF_SCHEMA[''], name)) {
      violations.push(`${name}: not in vf's schema`);
    }
  }
  return violations;
}

/** Frame stats as a playing tile emits them. */
export const SAMPLE_FRAME_STATS: NeatFrameStats = {
  timestampMatches: 120,
  arrivalFallbacks: 3,
  frameMisses: 2,
  expired: 1,
  evicted: 0,
  untimestampedReceived: 4,
  late: 5,
  timestampedPending: 6,
  arrivalPending: 7,
  recentLatenessMedianMs: 41.5,
  recentLatenessMaxMs: 88.25,
  metadataMessagesPerSecond: 30,
  video: {
    readyState: 4,
    paused: false,
    currentTime: 12.345,
    videoWidth: 1920,
    videoHeight: 1080,
    lastFrameAgeMs: 16,
    active: true,
  },
};
