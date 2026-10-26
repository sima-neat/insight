/**
 * What this tab remembers about its webcams across a reload: per slot, which camera it used and
 * whether it was sending. `sessionStorage` on purpose: it survives a reload of this tab and is
 * not shared with any other, so a tab only ever resumes cameras it had running itself. It is the
 * only place that touches it, every access in try/catch: storage can be missing or refuse
 * access, and the app then simply does not resume.
 */
export interface ResumeEntry {
  readonly deviceId: string;
  /** Whether the camera was publishing when the page went away. */
  readonly sending: boolean;
}

const KEY = 'neat-insight:webcams';

/** The entries of every slot this tab remembers; empty where there is nothing or no storage. */
export function readResume(): ReadonlyMap<number, ResumeEntry> {
  const entries = new Map<number, ResumeEntry>();
  const stored = readAll();
  for (const [name, value] of Object.entries(stored)) {
    const slot = Number(name);
    if (Number.isInteger(slot) && slot >= 0 && isEntry(value)) {
      entries.set(slot, { deviceId: value.deviceId, sending: value.sending });
    }
  }
  return entries;
}

/** Remembers `entry` for the slot, or forgets the slot's with null. Never throws. */
export function writeResume(slot: number, entry: ResumeEntry | null): void {
  const all = readAll();
  if (entry) all[String(slot)] = entry;
  else delete all[String(slot)];
  try {
    if (Object.keys(all).length === 0) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // No storage: this tab does not resume its cameras.
  }
}

function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { ...parsed }
      : {};
  } catch {
    return {};
  }
}

function isEntry(value: unknown): value is ResumeEntry {
  if (typeof value !== 'object' || value === null) return false;
  const { deviceId, sending } = value as Record<string, unknown>;
  return typeof deviceId === 'string' && deviceId !== '' && typeof sending === 'boolean';
}
