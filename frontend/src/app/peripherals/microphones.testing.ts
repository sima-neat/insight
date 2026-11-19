import { DEVKIT } from '../board/board.testing';
import type { MicrophoneItem, MicTestStatus } from './api';
import { available } from './cameras.testing';

// Microphone items as `snapshotOf` builds them from a real DevKit scan, for the device list and
// the microphone test.

/** The Blue Yeti Nano; Sentinel reports no USB speed for a microphone. */
export const yeti: MicrophoneItem = {
  id: 'microphone:alsa:3ff3d77bf791d455',
  kind: 'microphone',
  connection: 'usb',
  name: 'Yeti Nano',
  device: {
    card_index: 0,
    card_id: 'Nano',
    card_name: 'Yeti Nano',
    card_driver: 'USB-Audio',
    pcm_device: 0,
    pcm_node: '/dev/snd/pcmC0D0c',
    alsa_name: 'hw:CARD=Nano,DEV=0',
    by_path: '/dev/snd/by-path/platform-7ff0000000.pci-pci-0003:01:00.0-usb-0:3.1:1.0',
    by_id: '/dev/snd/by-id/usb-Blue_Microphones_Yeti_Nano_2127SG00CBA8_888-000441040606-00',
    usb: {
      vendor_id: 'b58e',
      product_id: '0005',
      manufacturer: 'Blue Microphones',
      product: 'Yeti Nano',
      serial: '2127SG00CBA8_888-000441040606',
      bus_path: '1-3.1',
    },
  },
  availability: available,
  capture: [
    {
      format: 'S24_3LE',
      channels: 2,
      bits: 24,
      rates: [32000, 44100, 48000],
      rate_range: null,
      channel_map: ['FL', 'FR'],
    },
  ],
  record: '1f0c6e2a9b3d4c5e',
  notes: [],
  errors: [],
};

export const onboardMic: MicrophoneItem = {
  id: 'microphone:alsa:0a1b2c3d4e5f6071',
  kind: 'microphone',
  connection: 'onboard',
  name: 'sima-audio',
  device: {
    card_index: 1,
    card_id: 'simaaudio',
    card_name: 'sima-audio',
    card_driver: 'simple-card',
    pcm_device: 0,
    pcm_node: '/dev/snd/pcmC1D0c',
    alsa_name: 'hw:CARD=simaaudio,DEV=0',
  },
  availability: available,
  capture: null,
  record: '9a8b7c6d5e4f3a2b',
  notes: ['Capture formats cannot be read without opening the device.'],
  errors: [],
};

/**
 * A test of the Yeti on the DevKit as `GET .../microphones/test` answers it: recording by
 * default. A `ready` one carries `level`, a `failed` one `error`; pass them with the state.
 */
export function micTestStatus(overrides: Partial<MicTestStatus> = {}): MicTestStatus {
  return {
    id: 't1',
    microphone: yeti.id,
    board: DEVKIT.id,
    state: 'recording',
    device: 'plughw:CARD=Nano,DEV=0',
    format: { rate: 48000, channels: 2, bits: 16, seconds: 30 },
    elapsed_ms: 0,
    ...overrides,
  };
}

/** The Yeti's test once it recorded something: ready to play, not silent. */
export function readyTest(overrides: Partial<MicTestStatus> = {}): MicTestStatus {
  return micTestStatus({
    state: 'ready',
    elapsed_ms: 4200,
    level: { peak_dbfs: -9, rms_dbfs: -24.5, silent: false },
    ...overrides,
  });
}

/** A test's recording as the panel's `<audio>` loads it. */
export function testAudioUrl(id = 't1'): string {
  return `/api/boards/${encodeURIComponent(DEVKIT.id)}/microphones/${encodeURIComponent(yeti.id)}/test.wav?test=${id}`;
}
