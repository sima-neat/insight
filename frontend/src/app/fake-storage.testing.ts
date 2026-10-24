/** The prefix every viewer key carries in `localStorage`. */
export const VIEWER_PREFIX = 'neat-insight:viewer:';

/**
 * A Map-backed stand-in for `localStorage` that can be told to fail, so specs can drive the
 * storage facade into every failure the browser can produce (quota, disabled storage, sandboxed
 * frames). Install it with `vi.stubGlobal('localStorage', fake)`.
 */
export class FakeLocalStorage {
  readonly values = new Map<string, string>();
  /** Every setItem and removeItem call, in order, including those that threw. */
  readonly writes: { op: 'set' | 'remove'; key: string }[] = [];
  /** Every getItem call, to prove what was (not) read. */
  readonly reads: string[] = [];
  /** Every write throws, as with a full quota. */
  failWrites = false;
  /** Writes to these viewer names (keys without the prefix) throw while all others succeed. */
  failWritesFor: string[] = [];
  /** Every access throws, as with storage disabled. */
  unavailable = false;

  get length(): number {
    this.guard();
    return this.values.size;
  }

  key(index: number): string | null {
    this.guard();
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    this.guard();
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes.push({ op: 'set', key });
    this.guardWrite(key);
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.writes.push({ op: 'remove', key });
    this.guardWrite(key);
    this.values.delete(key);
  }

  /** Stores each entry under the viewer prefix, objects as JSON and strings as they are. */
  seed(entries: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(entries)) {
      this.values.set(
        VIEWER_PREFIX + name,
        typeof value === 'string' ? value : JSON.stringify(value),
      );
    }
  }

  /** The parsed value stored under the viewer prefix, or null when there is none. */
  readStored(name: string): unknown {
    const raw = this.values.get(VIEWER_PREFIX + name);
    return raw === undefined ? null : JSON.parse(raw);
  }

  /** The exact string stored under the viewer prefix. */
  readRaw(name: string): string | null {
    return this.values.get(VIEWER_PREFIX + name) ?? null;
  }

  private guard(): void {
    if (this.unavailable) throw new DOMException('The operation is insecure.', 'SecurityError');
  }

  private guardWrite(key: string): void {
    this.guard();
    if (this.failWrites || this.failWritesFor.some((name) => VIEWER_PREFIX + name === key)) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
  }
}
