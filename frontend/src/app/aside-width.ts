import type { PrefixedStorage } from './prefixed-storage';

/**
 * The side panel width kept under `name`, in pixels, or null for the kit's default. A value that
 * is not a positive number (edited by hand, or written by another version) is the default: the
 * kit clamps any width it is given, so only what cannot be a width has to be refused here.
 */
export function storedAsideWidth(storage: PrefixedStorage, name: string): number | null {
  const stored = storage.get(name);
  if (stored === null || stored.trim() === '') return null;
  const width = Number(stored);
  return Number.isFinite(width) && width > 0 ? width : null;
}

/** Keeps `width` under `name` as text; null, the default, removes it. */
export function storeAsideWidth(
  storage: PrefixedStorage,
  name: string,
  width: number | null,
): void {
  if (width === null) storage.remove(name);
  else storage.set(name, String(width));
}
