import { DEVKIT } from '../board/board.testing';
import type { PeripheralItem, PeripheralSnapshot, SnapshotBoard } from './api';

/** What a test changes in a snapshot: any field, and any of the board's fields on their own. */
export type SnapshotOverrides = Partial<Omit<PeripheralSnapshot, 'board'>> & {
  board?: Partial<SnapshotBoard>;
};

/**
 * A scan of the SDK-paired DevKit (`DEVKIT`), the board of `previewSession()`, listing `items`;
 * `null` for the empty snapshot before a scan. The one snapshot builder of the unit tests (the
 * device model, the service, the board dialog and the Peripherals page).
 */
export function peripheralSnapshot(
  items: PeripheralItem[] | null,
  overrides: SnapshotOverrides = {},
): PeripheralSnapshot {
  const scanned = items !== null;
  const { board, ...rest } = overrides;
  return {
    board: { id: DEVKIT.id, label: DEVKIT.label, ...board },
    scan_id: scanned ? '42:2026-10-25T10:00:00Z' : null,
    scanned_at: scanned ? '2026-10-25T10:00:00Z' : null,
    ...(scanned ? { scan_ms: 3400 } : {}),
    items: items ?? [],
    issues: [],
    changes: null,
    camera_setup: null,
    ...rest,
  };
}
