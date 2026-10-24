/**
 * The device model: what Peripherals' list, rows and Details say about a scan, as pure functions
 * of the snapshot (#170's `peripherals/model.js`, copy per Inv-PB §2.2). #170's tones map to the
 * kit's: ok `success`, warn `warning`, periph-danger `danger`, periph-info `info`, none `neutral`;
 * Unsupported is `neutral`, not red, since USB cameras are Unsupported and preview fine (spec,
 * "One chip per row").
 */

import type { NeatIconName, NeatTone } from '@sima/neat-ui';
import type { NeatSelectListGroup } from '@sima/neat-ui/select-list';
import type { BoardState, CameraSetup } from '../board/api';
import type {
  CameraItem,
  DeviceChanges,
  MicrophoneItem,
  PeripheralItem,
  PeripheralIssue,
  PeripheralSnapshot,
  SupportTier,
  UsbFacts,
} from './api';

export interface DeviceChip {
  label: string;
  tone: NeatTone;
}

/** Which camera this page previews and which microphone it tests, by item id. */
export interface DeviceActivity {
  previewing: string | null;
  testing: string | null;
}

/** One row of the device list. */
export interface DeviceRow {
  item: PeripheralItem;
  icon: NeatIconName;
  name: string;
  /** The model or "Part of …" under the name; '' for none. */
  subtitle: string;
  /** How the device is attached, in words: "MIPI CSI", "USB 3.0", "On-board ALSA". */
  connection: string;
  chip: DeviceChip;
}

/** One fact of a device's Details. */
export interface DeviceFact {
  term: string;
  value: string;
}

/** The list of devices: its groups in order, and the items in the order the list shows them. */
export interface DeviceGroups {
  groups: NeatSelectListGroup[];
  items: PeripheralItem[];
}

/**
 * The kinds Insight knows a name and an icon for, in the list's order. Cameras and microphones
 * have a view; LiDAR is a name only, as in #170. A kind the backend invents gets the generic
 * `device` icon.
 */
const KNOWN_KINDS: readonly { kind: string; label: string; icon: NeatIconName }[] = [
  { kind: 'camera', label: 'Cameras', icon: 'camera' },
  { kind: 'microphone', label: 'Microphones', icon: 'microphone' },
  { kind: 'lidar', label: 'LiDAR', icon: 'lidar' },
];

const VIEWED_KINDS: ReadonlySet<string> = new Set(['camera', 'microphone']);

/**
 * The order of the connections within a kind's group. A connection not listed comes after these,
 * in the scan's order: #170 dropped such devices from its lists (Inv-PB §1.1), which hid a device
 * the board reported.
 */
const CONNECTION_ORDER: Readonly<Record<string, readonly string[]>> = {
  camera: ['mipi', 'usb'],
  microphone: ['usb', 'onboard'],
};

const TIERS: Record<SupportTier, DeviceChip> = {
  available: { label: 'Available', tone: 'success' },
  unverified: { label: 'Unverified', tone: 'warning' },
  unsupported: { label: 'Unsupported', tone: 'neutral' },
};

const SEVERITIES: Record<PeripheralIssue['severity'], DeviceChip & { rank: number }> = {
  error: { label: 'Error', tone: 'danger', rank: 0 },
  warning: { label: 'Warning', tone: 'warning', rank: 1 },
  info: { label: 'Info', tone: 'info', rank: 2 },
};

const PREVIEWING: DeviceChip = { label: 'Previewing', tone: 'info' };
const TESTING: DeviceChip = { label: 'Testing', tone: 'info' };
const LAST_SCAN: DeviceChip = { label: 'Last scan', tone: 'neutral' };
const NOT_SUPPORTED: DeviceChip = { label: 'Not supported yet', tone: 'neutral' };

/** A snapshot counts as scanned once a scan made it; the empty one before any has no `scan_id`. */
export function isScanned(snapshot: PeripheralSnapshot | null): snapshot is PeripheralSnapshot {
  return snapshot !== null && snapshot.scan_id !== null;
}

export function isCamera(item: PeripheralItem): item is CameraItem {
  return item.kind === 'camera';
}

export function isMicrophone(item: PeripheralItem): item is MicrophoneItem {
  return item.kind === 'microphone';
}

/** A tier's label and tone; anything but the three tiers reads as Unsupported. */
export function tierInfo(tier: SupportTier): DeviceChip {
  return TIERS[tier] ?? TIERS.unsupported;
}

/** A Sentinel issue's severity label, tone and sort rank; an unknown severity reads as Info. */
export function severityInfo(severity: string): DeviceChip & { rank: number } {
  return SEVERITIES[severity as PeripheralIssue['severity']] ?? SEVERITIES.info;
}

/**
 * The device list's groups and its items in the order shown. The groups are Cameras,
 * Microphones and LiDAR, then every other kind the scan reports, by label; each is keyed by the
 * kind (`item.kind`), so `groupOf = item => item.kind`. Every kind with an item has a group:
 * nothing is dropped.
 *
 * A heading counts its devices ("Cameras · 3"), or says why it has none: "none found" after a
 * scan, "not scanned yet" before one. It is muted when it has no devices, and for a kind Insight
 * has no view for even with devices (ruling F27), whose rows say "Not supported yet".
 */
export function deviceGroups(snapshot: PeripheralSnapshot | null): DeviceGroups {
  const scanned = isScanned(snapshot);
  const byKind = new Map<string, PeripheralItem[]>();
  for (const item of scanned ? snapshot.items : []) {
    const list = byKind.get(item.kind);
    if (list) list.push(item);
    else byKind.set(item.kind, [item]);
  }

  const known = KNOWN_KINDS.map(({ kind, label }) => ({ kind, label }));
  const extra = [...byKind.keys()]
    .filter((kind) => !KNOWN_KINDS.some((entry) => entry.kind === kind))
    .map((kind) => ({ kind, label: kindLabel(kind) }))
    .sort((a, b) => compare(a.label, b.label) || compare(a.kind, b.kind));

  const groups: NeatSelectListGroup[] = [];
  const items: PeripheralItem[] = [];
  for (const { kind, label } of [...known, ...extra]) {
    const devices = byConnection(kind, byKind.get(kind) ?? []);
    const state = devices.length
      ? String(devices.length)
      : scanned
        ? 'none found'
        : 'not scanned yet';
    groups.push({
      key: kind,
      label: `${label} · ${state}`,
      muted: !devices.length || !VIEWED_KINDS.has(kind),
    });
    items.push(...devices);
  }
  return { groups, items };
}

/**
 * The device to select after a scan: the one selected before while it is listed, or while the
 * scan reports it removed (its panel then explains that it is gone); otherwise the first device
 * the list shows, or null with none.
 */
export function resolveDeviceId(
  snapshot: PeripheralSnapshot | null,
  previousId: string | null,
): string | null {
  const { items } = deviceGroups(snapshot);
  if (previousId !== null) {
    if (items.some((item) => item.id === previousId)) return previousId;
    if (snapshot?.changes?.removed.some((removed) => removed.id === previousId)) return previousId;
  }
  return items[0]?.id ?? null;
}

/** A device's row: its kind icon, name and subtitle, connection, and one chip (spec, "One chip per row"). */
export function deviceRow(item: PeripheralItem, activity: DeviceActivity): DeviceRow {
  return {
    item,
    icon: KNOWN_KINDS.find((entry) => entry.kind === item.kind)?.icon ?? 'device',
    name: item.name,
    subtitle: isCamera(item)
      ? cameraSubtitle(item)
      : isMicrophone(item)
        ? microphoneSubtitle(item)
        : '',
    connection: connectionLabel(item),
    chip: rowChip(item, activity),
  };
}

/**
 * The facts a device's Details lists, each only when the backend reported it: the libcamera
 * facts of a MIPI camera (any camera that is not USB, as the backend reads it), the V4L2 and USB
 * facts of a USB camera, and the ALSA and USB facts of a microphone. A kind Insight has no view
 * for has none.
 */
export function deviceFacts(item: PeripheralItem): DeviceFact[] {
  if (isCamera(item)) {
    const device = item.device;
    if (item.connection === 'usb') {
      return facts([
        ['Video node', device.video_node],
        ['By-id link', device.by_id],
        ...usbFacts(device.usb),
      ]);
    }
    return facts([
      ['libcamera name', device.camera_name],
      ['Media device', device.media_device],
      ['Bus info', device.bus_info],
      ['CSI receiver', device.csi],
    ]);
  }
  if (isMicrophone(item)) {
    const device = item.device;
    return facts([
      ['ALSA card', alsaCard(device.card_index, device.card_id, device.card_name)],
      ['Driver', device.card_driver],
      ['ALSA name', device.alsa_name],
      ['PCM node', device.pcm_node],
      ['By-path link', device.by_path],
      ['By-id link', device.by_id],
      ...usbFacts(device.usb),
    ]);
  }
  return [];
}

/** The change summary's lines: the devices gone since the last scan, then the new ones. */
export function changeSummary(changes: DeviceChanges | null): string[] {
  const names = (list: DeviceChanges['added']) =>
    list.map((device) => device.name || device.id).join(', ');
  const lines: string[] = [];
  if (changes?.removed.length)
    lines.push(`Disconnected since last refresh: ${names(changes.removed)}`);
  if (changes?.added.length) lines.push(`New: ${names(changes.added)}`);
  return lines;
}

/** The issues, errors first, then warnings, then info; the scan's order within each. */
export function sortIssues(issues: readonly PeripheralIssue[]): PeripheralIssue[] {
  return [...issues].sort((a, b) => severityInfo(a.severity).rank - severityInfo(b.severity).rank);
}

/**
 * The snapshot describes another board than the one selected: it was scanned for an earlier
 * generation. The page then asks for a refresh and blocks previews.
 */
export function isSnapshotStale(
  board: Pick<BoardState, 'generation'> | null,
  snapshot: PeripheralSnapshot | null,
): boolean {
  return board !== null && isScanned(snapshot) && snapshot.generation !== board.generation;
}

/**
 * The camera setup SiMa Sentinel read from the board's device tree, for the board it scanned:
 * null before a scan, after the selected board changed, or from an older Sentinel.
 */
export function boardCameraSetup(
  board: Pick<BoardState, 'generation'> | null,
  snapshot: PeripheralSnapshot | null,
): CameraSetup | null {
  if (board === null || !isScanned(snapshot) || snapshot.generation !== board.generation) {
    return null;
  }
  return snapshot.camera_setup;
}

/** A kind's group label, as #170 named a kind it had no name for: "gps_unit" reads "Gps units". */
function kindLabel(kind: string): string {
  const text = kind.replace(/[_-]+/g, ' ').trim();
  if (!text) return 'Other';
  return text.charAt(0).toUpperCase() + text.slice(1) + (text.endsWith('s') ? '' : 's');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A kind's devices in its connection order; each connection keeps the scan's order. */
function byConnection(kind: string, devices: PeripheralItem[]): PeripheralItem[] {
  const order = CONNECTION_ORDER[kind] ?? [];
  const rank = (item: PeripheralItem) => {
    const index = order.indexOf(item.connection);
    return index === -1 ? order.length : index;
  };
  // `sort` is stable, so devices of one connection stay in the scan's order.
  return [...devices].sort((a, b) => rank(a) - rank(b));
}

/**
 * The device id under a MIPI camera's name: libcamera's name, which is stable, before the by-id
 * link and the `/dev/videoN` node, whose number can change across reboots.
 */
function cameraDeviceId(camera: CameraItem): string {
  const device = camera.device;
  return device.camera_name || device.by_id || device.video_node || '';
}

/** The model and the device id, each left out when the name already says it. */
function cameraSubtitle(camera: CameraItem): string {
  // A USB camera's kernel path is not shown under its name.
  const deviceId = camera.connection === 'usb' ? '' : cameraDeviceId(camera);
  // The name already carries the model for a MIPI camera ("imx477 5-001a"), so repeating it says nothing.
  const model = camera.model && !camera.name.includes(camera.model) ? camera.model : '';
  return [model, deviceId !== camera.name ? deviceId : ''].filter(Boolean).join(' · ');
}

/** Ties a webcam's or headset's microphone to the camera item the same USB device produced. */
function microphoneSubtitle(mic: MicrophoneItem): string {
  const name = mic.device.part_of?.name;
  return name ? `Part of ${name}` : '';
}

function connectionLabel(item: PeripheralItem): string {
  switch (item.connection) {
    case 'mipi':
      return 'MIPI CSI';
    case 'usb':
      return usbLabel(usbOf(item)?.speed_mbps);
    case 'onboard':
      return 'On-board ALSA';
    default:
      return item.connection.charAt(0).toUpperCase() + item.connection.slice(1);
  }
}

/**
 * The USB generation the link speed implies. Without a speed, which the backend never sends for
 * a microphone, it is "USB": guessing 1.1 would mislabel the device (ruling F18).
 */
function usbLabel(speedMbps: number | undefined): string {
  if (speedMbps === undefined) return 'USB';
  if (speedMbps >= 10000) return 'USB 3.2';
  if (speedMbps >= 5000) return 'USB 3.0';
  if (speedMbps >= 480) return 'USB 2.0';
  return 'USB 1.1';
}

function usbOf(item: PeripheralItem): UsbFacts | undefined {
  return isCamera(item) || isMicrophone(item) ? item.device.usb : undefined;
}

/** The first that applies: this page's activity, a camera kept from an earlier scan, the tier. */
function rowChip(item: PeripheralItem, activity: DeviceActivity): DeviceChip {
  if (item.id === activity.previewing) return PREVIEWING;
  if (item.id === activity.testing) return TESTING;
  if (isCamera(item)) {
    // The camera may have been unplugged since that scan, so it says where it comes from.
    return item.modes_source === 'previous-scan' ? LAST_SCAN : tierInfo(item.support.tier);
  }
  if (isMicrophone(item)) return TIERS.available;
  return NOT_SUPPORTED;
}

function usbFacts(usb: UsbFacts | undefined): [string, string | number | null | undefined][] {
  return [
    ['USB ID', usb?.vendor_id && usb.product_id ? `${usb.vendor_id}:${usb.product_id}` : null],
    ['Manufacturer', usb?.manufacturer],
    ['Product', usb?.product],
    ['Serial', usb?.serial],
    ['Bus path', usb?.bus_path],
    ['Link speed', usb?.speed_mbps === undefined ? null : `${usb.speed_mbps} Mb/s`],
  ];
}

/** "0: Nano (Yeti Nano)", from the parts the card reported; null with none. */
function alsaCard(index: number | null, id: string | null, name: string | null): string | null {
  const head = [index === null ? '' : String(index), id ?? ''].filter(Boolean).join(': ');
  const text = [head, name ? `(${name})` : ''].filter(Boolean).join(' ');
  return text || null;
}

/** The facts with a value; '' and null mean not reported. */
function facts(rows: [string, string | number | null | undefined][]): DeviceFact[] {
  return rows
    .filter(
      (row): row is [string, string | number] =>
        row[1] !== null && row[1] !== undefined && row[1] !== '',
    )
    .map(([term, value]) => ({ term, value: String(value) }));
}
