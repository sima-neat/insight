const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/**
 * A byte count as #170 shows it: whole bytes below 1 KB, KB and MB to one decimal, GB to two
 * ("1.20 GB"), binary units (1 KB = 1024 B), and "-" for a count that is not a number. For the
 * stored renditions and the media library's file sizes alike, so both read the same.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}
