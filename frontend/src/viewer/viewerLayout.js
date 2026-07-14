export const MAX_CHANNELS = 80;
export const DEFAULT_VISIBLE_PER_PAGE = 4;
export const PAGE_SIZE_PRESETS = Object.freeze([1, 4, 9, 16, 24, 36, 48]);

export function gridDimensions(count) {
  if (count === 24) return { columns: 4, rows: 6 };
  if (count === 48) return { columns: 6, rows: 8 };

  const columns = Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}

export function normalizeVisiblePerPage(value) {
  const requested = Number.parseInt(value, 10);
  if (Number.isNaN(requested)) return DEFAULT_VISIBLE_PER_PAGE;

  return PAGE_SIZE_PRESETS.reduce((closest, preset) =>
    Math.abs(preset - requested) < Math.abs(closest - requested) ? preset : closest,
  );
}
