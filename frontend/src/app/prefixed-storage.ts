/**
 * The app's part of `localStorage` below one prefix, addressed by names under it. It never throws:
 * storage can be missing, disabled (a sandboxed frame or private mode throws on access) or full,
 * and the app must then run on what it has. A write the browser refuses is kept in memory for the
 * session instead, and reads see it, so an instance has to live as long as the app (a root
 * service holds it).
 */
export class PrefixedStorage {
  /** Values the browser refused to store this session; null marks a refused removal. */
  private readonly session = new Map<string, string | null>();

  constructor(private readonly prefix: string) {}

  get(name: string): string | null {
    const key = this.prefix + name;
    if (this.session.has(key)) return this.session.get(key) ?? null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  set(name: string, value: string): void {
    const key = this.prefix + name;
    try {
      localStorage.setItem(key, value);
      this.session.delete(key);
    } catch {
      this.session.set(key, value);
    }
  }

  remove(name: string): void {
    const key = this.prefix + name;
    try {
      localStorage.removeItem(key);
      this.session.delete(key);
    } catch {
      this.session.set(key, null);
    }
  }

  /** The names that hold a value, stored or kept for the session. */
  names(): string[] {
    const keys = new Set<string>();
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key !== null) keys.add(key);
      }
    } catch {
      // Storage cannot be listed: the session's values are all there is.
    }
    for (const [key, value] of this.session) {
      if (value === null) keys.delete(key);
      else keys.add(key);
    }
    return [...keys]
      .filter((key) => key.startsWith(this.prefix))
      .map((key) => key.slice(this.prefix.length));
  }
}
