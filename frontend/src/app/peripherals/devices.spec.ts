import type { CameraSetup } from '../board/api';
import type {
  CameraItem,
  MicrophoneItem,
  OtherItem,
  PeripheralItem,
  PeripheralSnapshot,
  SupportTier,
} from './api';
import { available, imx477, imx568, inUse, support, usb } from './cameras.testing';
import {
  boardCameraSetup,
  changeSummary,
  type DeviceActivity,
  deviceFacts,
  deviceGroups,
  deviceRow,
  isSnapshotStale,
  resolveDeviceId,
  severityInfo,
  sortIssues,
  tierInfo,
} from './devices';
import { onboardMic, yeti } from './microphones.testing';
import { peripheralSnapshot } from './snapshots.testing';

// #170's fixtures (model.test.js), typed: the cameras come from `cameras.testing.ts`, the
// microphones from `microphones.testing.ts`.

const idle: DeviceActivity = { previewing: null, testing: null };

/** A device of a kind Insight has no view for, as a later backend might report it. */
function other(kind: string, id: string, connection = 'i2c'): OtherItem {
  return {
    id,
    kind,
    connection,
    name: `${kind || 'device'} ${id}`,
    device: {},
    availability: available,
    notes: [],
    errors: [],
  };
}

const snapshot = peripheralSnapshot([usb, imx477, yeti, imx568, inUse], {
  issues: [
    {
      severity: 'info',
      code: 'no_usb_power',
      message: 'USB hub reports low power.',
      hint: 'Use a powered hub.',
    },
    {
      severity: 'error',
      code: 'tool_missing',
      message: 'v4l2-ctl is missing.',
      hint: 'Install v4l-utils on the board.',
    },
    {
      severity: 'warning',
      code: 'no_fuser',
      message: 'Availability is unknown.',
      hint: 'Install psmisc.',
    },
  ],
  changes: {
    added: [{ id: usb.id, name: usb.name }],
    removed: [{ id: 'mipi:gone', name: 'imx219' }],
  },
});

const unscanned = peripheralSnapshot(null);

/** The ids of each group's items, in the order the list shows them. */
function idsByGroup(snap: PeripheralSnapshot): Record<string, string[]> {
  const { groups, items } = deviceGroups(snap);
  return Object.fromEntries(
    groups.map((group) => [
      group.key,
      items.filter((item) => item.kind === group.key).map((item) => item.id),
    ]),
  );
}

describe('the device model', () => {
  // #170's grouping tests, on one list: a connection now orders rows within their kind's group.
  // On one list, a kind's group is the run of its items: the microphone follows the cameras.
  it('cameras are grouped MIPI first, then USB, ahead of the other kinds', () => {
    const ids = deviceGroups(snapshot).items.map((item) => item.id);
    expect(ids).toEqual([imx477.id, imx568.id, inUse.id, usb.id, yeti.id]);
  });

  it('microphones are grouped USB first, then on-board, after the cameras', () => {
    const ids = deviceGroups(peripheralSnapshot([onboardMic, imx477, yeti])).items.map(
      (item) => item.id,
    );
    expect(ids).toEqual([imx477.id, yeti.id, onboardMic.id]);
  });

  it('a kind the backend invents appears automatically, after the known ones', () => {
    const { groups, items } = deviceGroups(
      peripheralSnapshot([
        other('radar', 'r1'),
        imx477,
        other('radar', 'r2'),
        other('', 'x1'),
        other('gps_unit', 'g1'),
      ]),
    );
    expect(groups.map((group) => group.key)).toEqual([
      'camera',
      'microphone',
      'lidar',
      'gps_unit',
      '',
      'radar',
    ]);
    // Capitalised and pluralised; a device without a kind is "Other", keyed '' as `item.kind` is.
    expect(groups.slice(3).map((group) => group.label)).toEqual([
      'Gps units · 1',
      'Other · 1',
      'Radars · 2',
    ]);
    // Insight has no view for them: muted though they have devices (ruling F27).
    expect(groups.slice(3).every((group) => group.muted)).toBe(true);
    expect(items.map((item) => item.id)).toEqual([imx477.id, 'g1', 'x1', 'r1', 'r2']);
    expect(deviceRow(items[3], idle).icon).toBe('device');
  });

  it('groups read Cameras · N, LiDAR · none found, and not scanned yet before a scan; empty ones are muted', () => {
    expect(deviceGroups(snapshot).groups).toEqual([
      { key: 'camera', label: 'Cameras · 4', muted: false },
      { key: 'microphone', label: 'Microphones · 1', muted: false },
      { key: 'lidar', label: 'LiDAR · none found', muted: true },
    ]);
    expect(deviceGroups(peripheralSnapshot([yeti])).groups[0]).toEqual({
      key: 'camera',
      label: 'Cameras · none found',
      muted: true,
    });
    // Before a scan no count is claimed, and nothing is listed.
    for (const snap of [unscanned, null]) {
      expect(deviceGroups(snap)).toEqual({
        groups: [
          { key: 'camera', label: 'Cameras · not scanned yet', muted: true },
          { key: 'microphone', label: 'Microphones · not scanned yet', muted: true },
          { key: 'lidar', label: 'LiDAR · not scanned yet', muted: true },
        ],
        items: [],
      });
    }
    // A LiDAR Insight cannot show yet is counted and muted, its rows saying so (ruling F27).
    const lidar = other('lidar', 'l1', 'usb');
    const scanned = deviceGroups(peripheralSnapshot([lidar, other('lidar', 'l2', 'usb')]));
    expect(scanned.groups[2]).toEqual({ key: 'lidar', label: 'LiDAR · 2', muted: true });
    expect(deviceRow(lidar, idle)).toMatchObject({
      icon: 'lidar',
      chip: { label: 'Not supported yet', tone: 'neutral' },
    });
  });

  it('a device with an unknown connection is listed, not dropped', () => {
    const gmsl: CameraItem = { ...imx568, id: 'gmsl:cam', connection: 'gmsl' };
    const bluetooth: MicrophoneItem = { ...yeti, id: 'bt:mic', connection: 'bluetooth' };
    expect(
      idsByGroup(peripheralSnapshot([gmsl, usb, imx477, bluetooth, onboardMic, yeti])),
    ).toEqual({
      camera: [imx477.id, usb.id, gmsl.id],
      microphone: [yeti.id, onboardMic.id, bluetooth.id],
      lidar: [],
    });
    expect(deviceRow(gmsl, idle).connection).toBe('Gmsl');
    expect(deviceRow(bluetooth, idle).connection).toBe('Bluetooth');
  });

  it('a row names its kind icon, the name and subtitle, and the connection', () => {
    expect(deviceRow(imx477, idle)).toEqual({
      item: imx477,
      icon: 'camera',
      name: imx477.name,
      subtitle: '',
      connection: 'MIPI CSI',
      chip: { label: 'Available', tone: 'success' },
    });
    expect(deviceRow(onboardMic, idle)).toMatchObject({
      icon: 'microphone',
      connection: 'On-board ALSA',
    });
    // The USB generation follows the link speed; without one (every USB microphone) it is just
    // USB, not USB 1.1 (ruling F18).
    const speed = (speed_mbps?: number): CameraItem => ({
      ...usb,
      device: { ...usb.device, usb: { ...usb.device.usb, speed_mbps } },
    });
    expect(
      [10000, 5000, 480, 12, 1.5, undefined].map((mbps) => deviceRow(speed(mbps), idle).connection),
    ).toEqual(['USB 3.2', 'USB 3.0', 'USB 2.0', 'USB 1.1', 'USB 1.1', 'USB']);
    expect(deviceRow(yeti, idle).connection).toBe('USB');
  });

  it('a subtitle never repeats what the name already says', () => {
    const subtitle = (camera: CameraItem) => deviceRow(camera, idle).subtitle;
    // "imx477 5-001a" carries the model, so the subtitle beneath it must not read "imx477" again.
    expect(subtitle(imx477)).toBe('');
    // The USB camera reports its product string as both name and model, and its kernel path is not shown.
    expect(subtitle(usb)).toBe('');
    expect(subtitle({ ...imx477, name: 'C270', model: 'C270', device: {} })).toBe('');
    expect(subtitle({ ...imx477, name: 'cam', model: 'imx477', device: {} })).toBe('imx477');
  });

  // #170's `cameraDeviceId`, seen where it shows: the device id under a MIPI camera's name.
  it('a camera id prefers the stable name', () => {
    const named = { ...imx477, name: 'Front camera', model: null };
    expect(deviceRow(named, idle).subtitle).toBe(imx477.device.camera_name);
    // Without libcamera's name, the by-id link before the node, whose number can change.
    const linked = {
      ...named,
      device: { ...named.device, camera_name: null, by_id: '/dev/v4l/by-id/platform-imx477-video' },
    };
    expect(deviceRow(linked, idle).subtitle).toBe('/dev/v4l/by-id/platform-imx477-video');
    const unnamed = { ...named, device: { ...named.device, camera_name: null } };
    expect(deviceRow(unnamed, idle).subtitle).toBe('/dev/video3');
  });

  it('a webcam microphone names the camera it is part of', () => {
    const webcamMic: MicrophoneItem = {
      ...yeti,
      device: {
        ...yeti.device,
        alsa_name: 'hw:CARD=C920,DEV=0',
        part_of: { id: usb.id, name: 'HD Pro Webcam C920' },
      },
    };
    expect(deviceRow(webcamMic, idle).subtitle).toBe('Part of HD Pro Webcam C920');
    // The ALSA name is not shown under the title.
    expect(deviceRow(yeti, idle).subtitle).toBe('');
  });

  it('one chip per row: Previewing/Testing, then Last scan, then the tier; USB Unsupported is neutral', () => {
    const chip = (item: PeripheralItem, activity = idle) => deviceRow(item, activity).chip;
    expect(chip(imx477, { previewing: imx477.id, testing: null })).toEqual({
      label: 'Previewing',
      tone: 'info',
    });
    expect(chip(inUse, { previewing: inUse.id, testing: null }).label).toBe('Previewing');
    expect(chip(yeti, { previewing: null, testing: yeti.id })).toEqual({
      label: 'Testing',
      tone: 'info',
    });
    expect(chip(imx477, { previewing: usb.id, testing: yeti.id }).label).toBe('Available');
    // A camera kept from an earlier scan may be gone: that wins over its tier.
    expect(chip(inUse)).toEqual({ label: 'Last scan', tone: 'neutral' });
    expect(chip({ ...imx568, support: support('unverified') })).toEqual({
      label: 'Unverified',
      tone: 'warning',
    });
    // USB cameras preview fine, so Unsupported is not red.
    expect(chip(usb)).toEqual({ label: 'Unsupported', tone: 'neutral' });
    expect(chip(imx568)).toEqual({ label: 'Unsupported', tone: 'neutral' });
    expect(chip(onboardMic)).toEqual({ label: 'Available', tone: 'success' });
    expect(chip(other('radar', 'r1'))).toEqual({ label: 'Not supported yet', tone: 'neutral' });
  });

  // The tier half of #170's "labels for tiers, sources, and defaults" (ruling Q5; Task 7 did the rest).
  it('labels for tiers', () => {
    expect(tierInfo('available')).toEqual({ label: 'Available', tone: 'success' });
    expect(tierInfo('unverified')).toEqual({ label: 'Unverified', tone: 'warning' });
    expect(tierInfo('unsupported')).toEqual({ label: 'Unsupported', tone: 'neutral' });
    // Every mode is one of the three states.
    expect(tierInfo('bogus' as SupportTier)).toEqual(tierInfo('unsupported'));
  });

  it('deviceFacts lists the USB, MIPI and ALSA facts that are present, with their labels', () => {
    expect(deviceFacts(imx477)).toEqual([
      { term: 'libcamera name', value: imx477.device.camera_name },
      { term: 'Media device', value: '/dev/media0' },
      { term: 'Bus info', value: 'platform:csi2video@1' },
      { term: 'CSI receiver', value: 'csidev-40c3000.csi' },
    ]);
    expect(deviceFacts(imx568).map((fact) => fact.term)).toEqual([
      'libcamera name',
      'Media device',
    ]);
    expect(deviceFacts(usb)).toEqual([
      { term: 'Video node', value: '/dev/video0' },
      { term: 'By-id link', value: usb.device.by_id },
      { term: 'USB ID', value: '046d:0825' },
      { term: 'Manufacturer', value: 'Logitech' },
      { term: 'Product', value: 'HD Webcam C270' },
      { term: 'Bus path', value: '1-1.2' },
      { term: 'Link speed', value: '480 Mb/s' },
    ]);
    expect(deviceFacts(yeti)).toEqual([
      { term: 'ALSA card', value: '0: Nano (Yeti Nano)' },
      { term: 'Driver', value: 'USB-Audio' },
      { term: 'ALSA name', value: 'hw:CARD=Nano,DEV=0' },
      { term: 'PCM node', value: '/dev/snd/pcmC0D0c' },
      { term: 'By-path link', value: yeti.device.by_path },
      { term: 'By-id link', value: yeti.device.by_id },
      { term: 'USB ID', value: 'b58e:0005' },
      { term: 'Manufacturer', value: 'Blue Microphones' },
      { term: 'Product', value: 'Yeti Nano' },
      { term: 'Serial', value: '2127SG00CBA8_888-000441040606' },
      { term: 'Bus path', value: '1-3.1' },
    ]);
    // A card that reports less says less; card 0 is a card index like any other.
    const bare: MicrophoneItem = {
      ...onboardMic,
      device: {
        card_index: 0,
        card_id: null,
        card_name: null,
        card_driver: '',
        pcm_device: 0,
        pcm_node: null,
      },
    };
    expect(deviceFacts(bare)).toEqual([{ term: 'ALSA card', value: '0' }]);
    expect(deviceFacts(other('radar', 'r1'))).toEqual([]);
  });

  it('the selected device id survives refreshes and removals', () => {
    // #170's camera test, on one list: the first device listed is a MIPI camera.
    expect(resolveDeviceId(snapshot, null)).toBe(imx477.id);
    expect(resolveDeviceId(snapshot, usb.id)).toBe(usb.id);
    // Removed devices stay selected so the panel can explain.
    expect(resolveDeviceId(snapshot, 'mipi:gone')).toBe('mipi:gone');
    expect(resolveDeviceId(snapshot, 'usb:unknown')).toBe(imx477.id);
    expect(resolveDeviceId(peripheralSnapshot([]), 'usb:unknown')).toBeNull();
    expect(resolveDeviceId(null, null)).toBeNull();
  });

  it('the selected microphone survives refreshes and removals', () => {
    const mics = peripheralSnapshot([onboardMic, yeti], {
      changes: {
        added: [],
        removed: [{ id: 'usb:0c76:161f:1-3.2:c0', name: 'USB PnP Audio Device' }],
      },
    });
    expect(resolveDeviceId(mics, null)).toBe(yeti.id);
    expect(resolveDeviceId(mics, onboardMic.id)).toBe(onboardMic.id);
    expect(resolveDeviceId(mics, 'usb:0c76:161f:1-3.2:c0')).toBe('usb:0c76:161f:1-3.2:c0');
    expect(resolveDeviceId(mics, imx477.id)).toBe(yeti.id);
  });

  it('issues sort by severity and changes read as sentences', () => {
    expect(sortIssues(snapshot.issues).map((issue) => issue.severity)).toEqual([
      'error',
      'warning',
      'info',
    ]);
    expect(snapshot.issues.map((issue) => issue.severity)).toEqual(['info', 'error', 'warning']);
    expect(changeSummary(snapshot.changes)).toEqual([
      'Disconnected since last refresh: imx219',
      'New: HD Webcam C270',
    ]);
    expect(changeSummary({ added: [], removed: [{ id: 'mipi:gone', name: '' }] })).toEqual([
      'Disconnected since last refresh: mipi:gone',
    ]);
    expect(changeSummary(null)).toEqual([]);
    expect(['error', 'warning', 'info'].map((s) => severityInfo(s))).toEqual([
      { label: 'Error', tone: 'danger', rank: 0 },
      { label: 'Warning', tone: 'warning', rank: 1 },
      { label: 'Info', tone: 'info', rank: 2 },
    ]);
  });

  it('a snapshot is stale only when it was scanned for another board generation', () => {
    expect(isSnapshotStale({ generation: 3 }, snapshot)).toBe(false);
    expect(isSnapshotStale({ generation: 4 }, snapshot)).toBe(true);
    expect(isSnapshotStale({ generation: 4 }, { ...snapshot, scan_id: null })).toBe(false);
    expect(isSnapshotStale(null, snapshot)).toBe(false);
    expect(isSnapshotStale({ generation: 4 }, null)).toBe(false);
  });

  it('the camera setup belongs to the board that was scanned', () => {
    const cameraSetup: CameraSetup = {
      model: 'SiMa.ai Modalix SoM 16Gig Board',
      overlays: ['modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo'],
    };
    const scanned = peripheralSnapshot([], { camera_setup: cameraSetup });
    expect(boardCameraSetup({ generation: 3 }, scanned)).toBe(cameraSetup);
    // The selected board changed since the scan.
    expect(boardCameraSetup({ generation: 4 }, scanned)).toBeNull();
    // Not scanned yet.
    expect(boardCameraSetup({ generation: 3 }, { ...scanned, scan_id: null })).toBeNull();
    // An older Sentinel.
    expect(boardCameraSetup({ generation: 3 }, { ...scanned, camera_setup: null })).toBeNull();
    expect(boardCameraSetup(null, scanned)).toBeNull();
    expect(boardCameraSetup({ generation: 3 }, null)).toBeNull();
  });
});
