import { DEVKIT } from '../board/board.testing';
import type { PeripheralItem, PeripheralSnapshot } from './api';

/**
 * A scan of the SDK-paired DevKit (`DEVKIT`) on board generation 3, the generation of
 * `previewSession()`, listing `items`; `null` for the empty snapshot the backend answers before a
 * scan. For the Peripherals page's specs.
 */
export function peripheralSnapshot(
  items: PeripheralItem[] | null,
  overrides: Partial<PeripheralSnapshot> = {},
): PeripheralSnapshot {
  const scanned = items !== null;
  return {
    board: {
      label: DEVKIT.label,
      source: 'sdk-env',
      hostname: null,
      machine: null,
      build_version: null,
      fingerprint: null,
    },
    generation: 3,
    scan_id: scanned ? '42:2026-10-25T10:00:00Z' : null,
    scanned_at: scanned ? '2026-10-25T10:00:00Z' : null,
    ...(scanned ? { scan_ms: 3400 } : {}),
    items: items ?? [],
    issues: [],
    changes: null,
    camera_setup: null,
    ...overrides,
  };
}
