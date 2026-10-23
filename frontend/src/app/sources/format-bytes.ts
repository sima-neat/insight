const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count as people read it: "1.2 GB", in the largest binary unit (1 KB = 1024 B) that keeps
 * the number at 1 or more, to one decimal; whole bytes below 1 KB. For the stored renditions and
 * the media library's file sizes alike, so both read the same.
 */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}
