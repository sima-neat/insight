export const MAX_CHANNELS = 80;
export const DEFAULT_VISIBLE_PER_PAGE = 4;
export const PAGE_SIZE_PRESETS = Object.freeze([1, 4, 9, 16, 24, 36, 48]);

export function normalizeMaxChannels(value) {
  const requested = Number(value);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_CHANNELS) {
    return MAX_CHANNELS;
  }
  return requested;
}

export function parseChannelIndices(srcParam, maxChannels = MAX_CHANNELS) {
  const limit = normalizeMaxChannels(maxChannels);
  if (srcParam === null || srcParam === undefined) {
    return Array.from({ length: limit }, (_, index) => index);
  }

  const seen = new Set();
  srcParam
    .split(",")
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < limit)
    .forEach((value) => seen.add(value));
  return Array.from(seen).sort((a, b) => a - b);
}

export function pageSizePresetsForLimit(maxChannels = MAX_CHANNELS) {
  const limit = normalizeMaxChannels(maxChannels);
  const presets = PAGE_SIZE_PRESETS.filter((preset) => preset <= limit);
  if (limit < PAGE_SIZE_PRESETS[PAGE_SIZE_PRESETS.length - 1] && !presets.includes(limit)) presets.push(limit);
  return presets;
}

export function gridDimensions(count) {
  if (count === 24) return { columns: 6, rows: 4 };
  if (count === 48) return { columns: 8, rows: 6 };

  const columns = Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}

export function normalizeVisiblePerPage(value, maxChannels = MAX_CHANNELS) {
  const requested = Number.parseInt(value, 10);
  const presets = pageSizePresetsForLimit(maxChannels);
  if (Number.isNaN(requested)) return Math.min(DEFAULT_VISIBLE_PER_PAGE, normalizeMaxChannels(maxChannels));

  return presets.reduce((closest, preset) =>
    Math.abs(preset - requested) < Math.abs(closest - requested) ? preset : closest,
  );
}
