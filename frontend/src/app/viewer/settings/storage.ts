import { Injectable } from '@angular/core';

/** Every viewer key in `localStorage` starts with this, so the viewer leaves other keys alone. */
const PREFIX = 'neat-insight:viewer:';

/**
 * The Viewer's part of `localStorage`, addressed by names below `neat-insight:viewer:`. It never
 * throws: storage can be missing, disabled (a sandboxed frame or private mode throws on access) or
 * full, and the viewer must then run on what it has. A write the browser refuses is kept in memory
 * for the session instead, and reads see it.
 *
 * Provided in root because that session copy has to outlive the Viewer page: the page provides the
 * stores that read through this, and they are created afresh on every visit.
 */
@Injectable({ providedIn: 'root' })
export class ViewerStorage {
  /** Values the browser refused to store this session; null marks a refused removal. */
  private readonly session = new Map<string, string | null>();

  get(name: string): string | null {
    const key = PREFIX + name;
    if (this.session.has(key)) return this.session.get(key) ?? null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  set(name: string, value: string): void {
    const key = PREFIX + name;
    try {
      localStorage.setItem(key, value);
      this.session.delete(key);
    } catch {
      this.session.set(key, value);
    }
  }

  remove(name: string): void {
    const key = PREFIX + name;
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
    return [...keys].filter((key) => key.startsWith(PREFIX)).map((key) => key.slice(PREFIX.length));
  }
}
