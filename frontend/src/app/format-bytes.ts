import { NO_VALUE } from './no-value';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;
const PB = TB * 1024;

/**
 * A byte count for display: whole bytes below 1 KB, KB and MB to one decimal,
 * GB, TB and PB to two ("1.20 GB"), binary units (1 KB = 1024 B), and `NO_VALUE` for a count that
 * is not a number. One formatter for every size in the app (stored renditions, media files, the
 * memory and disk of the machine Insight runs on), so the same quantity reads the same everywhere.
 * There is no larger unit than PB, so a bigger count reads in PB.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return NO_VALUE;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes < TB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes < PB) return `${(bytes / TB).toFixed(2)} TB`;
  return `${(bytes / PB).toFixed(2)} PB`;
}
