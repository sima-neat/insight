import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { Component, Injector } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { SystemInfo } from './api';
import { openSystemInfoDialog } from './system-info-dialog';

/** Something to render, so that change detection runs for the dialog in the overlay. */
@Component({ template: '' })
class Host {}

/** What `neat --json` answers on an SDK with a DevKit paired, trimmed to what the dialog shows. */
function sysinfo(overrides: Partial<SystemInfo> = {}): SystemInfo {
  return {
    environment: {
      schema: 'sima.neat.status.v1',
      label: 'SDK 2.1 on a DevKit',
      mode: 'sdk',
      sdkVersion: '2.1.0',
      sysroot: null,
      offline: false,
    },
    insight: { serviceState: 'Running', venv: '/opt/insight', webUiUrl: 'https://10.1.1.5:9900' },
    components: {
      neatCore: { name: 'Neat core', version: '1.4.0', tag: 'v1.4.0', channel: 'stable' },
      insight: { version: '0.9.1', latestVersion: '0.10.0', updateAvailable: true },
      sdkTools: { version: '2.1.0', updateAvailable: false, venv: '/opt/sdk' },
      webssh: { installed: false, updateAvailable: false, detail: 'Not installed' },
    },
    exposedPorts: [
      { name: 'mainUI', protocol: 'tcp', hostPortStart: 9900, hostPortEnd: 9900 },
      { name: 'rtp.udp', protocol: 'udp', hostPortStart: 9000, hostPortEnd: 9079 },
    ],
    updateCheck: { schema: 'sima.neat.status.v1', offline: true, status: 'Update available' },
    ...overrides,
  };
}

/** What Insight answers without the `neat` command (`_missing_neat_sysinfo_payload`, enriched). */
function withoutNeat(): SystemInfo {
  return {
    environment: { label: null, mode: null, sdkVersion: null, sysroot: null },
    insight: { serviceState: null, venv: null, webUiUrl: 'https://127.0.0.1:9900' },
    components: {},
    exposedPorts: [{ name: 'mainUI', protocol: 'tcp', hostPortStart: 9900, hostPortEnd: 9900 }],
    updateCheck: { offline: null, status: null },
    missing: ['neat'],
  };
}

describe('SystemInfoDialog', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<Host>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Host);
  });

  afterEach(() => {
    http.verify();
    document.querySelectorAll('.cdk-overlay-container').forEach((container) => container.remove());
  });

  /** Lets the promise chains run, then change detection. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  /** Opens the dialog and answers its first request with `answer` (a payload or a failure). */
  async function open(answer: SystemInfo | { status: number; error: string }): Promise<void> {
    openSystemInfoDialog(TestBed.inject(Injector));
    await settle();
    reply(answer);
    await settle();
  }

  function reply(answer: SystemInfo | { status: number; error: string }): void {
    const request = http.expectOne('/api/sysinfo');
    if ('status' in answer) {
      request.flush({ error: answer.error }, { status: answer.status, statusText: 'Error' });
    } else {
      request.flush(answer);
    }
  }

  const dialog = (): HTMLElement => document.querySelector('[role="dialog"]')!;
  const text = (element: Element | null = dialog()) =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const button = (name: string) =>
    [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((one) => text(one) === name)!;
  /** The collapsible section whose trigger starts with `label`. */
  const section = (label: string) =>
    [...dialog().querySelectorAll('neat-collapsible')].find((one) =>
      text(one.querySelector('button')).startsWith(label),
    ) ?? null;
  const expanded = (label: string) =>
    section(label)?.querySelector('button')?.getAttribute('aria-expanded');
  /** The terms and values of a section's list, as `term: value` lines. */
  const rows = (label: string) =>
    [...section(label)!.querySelectorAll('dt')].map(
      (term) => `${text(term)}: ${text(term.nextElementSibling)}`,
    );
  /** An element's words as they read: its text pieces joined by spaces, as a chip and its neighbours do. */
  const words = (element: Element | null) => {
    if (!element) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const pieces: string[] = [];
    while (walker.nextNode()) pieces.push(walker.currentNode.textContent ?? '');
    return pieces
      .map((piece) => piece.trim())
      .filter(Boolean)
      .join(' ');
  };
  const errorNote = () => dialog().querySelector('neat-error-note');

  it('opens with Environment, Insight and Update check open and Components and Exposed ports collapsed', async () => {
    await open(sysinfo());

    expect(text(dialog().querySelector('h2'))).toBe('System information');
    expect(
      [...dialog().querySelectorAll('neat-collapsible')].map(
        (one) =>
          `${text(one.querySelector('button'))}: ${one.querySelector('button')!.getAttribute('aria-expanded')}`,
      ),
    ).toEqual([
      'Environment: true',
      'Insight: true',
      'Components: false',
      'Exposed ports: false',
      'Update check: true',
    ]);
    // Each is a heading of the outline, under the dialog's title.
    expect(
      [...dialog().querySelectorAll('[role="heading"]')].map(
        (heading) => `${heading.getAttribute('aria-level')} ${text(heading)}`,
      ),
    ).toEqual(['3 Environment', '3 Insight', '3 Components', '3 Exposed ports', '3 Update check']);
  });

  it('names the environment and the web address under the title', async () => {
    await open(sysinfo());
    expect(text(dialog().querySelector('p'))).toBe('SDK 2.1 on a DevKit · https://10.1.1.5:9900');
  });

  it('falls back to "Neat Environment" and the mode', async () => {
    await open(sysinfo({ environment: { mode: 'devkit' }, insight: { serviceState: 'Running' } }));
    expect(text(dialog().querySelector('p'))).toBe('Neat Environment · devkit');
  });

  it('lists Environment, Insight and Update check as words, skipping the schema', async () => {
    await open(sysinfo());
    expect(rows('Environment')).toEqual([
      'Label: SDK 2.1 on a DevKit',
      'Mode: sdk',
      'SDK version: 2.1.0',
      'Sysroot: -',
      'Offline: No',
    ]);
    expect(rows('Insight')).toEqual([
      'Service state: Running',
      'Venv: /opt/insight',
      'Web UI URL: https://10.1.1.5:9900',
    ]);
    // A boolean is words, not a chip (Inv-PB §6.5).
    expect(rows('Update check')).toEqual(['Offline: Yes', 'Status: Update available']);
    expect(section('Update check')!.querySelector('neat-status-chip')).toBeNull();
  });

  it('lists the components with their version, status and detail', async () => {
    await open(sysinfo());
    const components = section('Components')!;
    const line = (term: string) =>
      words(
        [...components.querySelectorAll('dt')].find((one) => text(one) === term)!
          .nextElementSibling,
      );
    expect(line('Neat core')).toBe('1.4.0 / tag v1.4.0 / channel stable');
    // No name: the key, as words. The latest version is the muted line.
    expect(line('Insight')).toBe('0.9.1 Update available 0.10.0');
    expect(line('SDK tools')).toBe('2.1.0 Current /opt/sdk');
    // Not installed: no update status, #170 showed "-" (Inv-PB §1.6).
    expect(line('Webssh')).toBe('- Not installed');
    expect(components.querySelectorAll('neat-status-chip')).toHaveLength(2);
  });

  it('lists the exposed ports with their protocol and range', async () => {
    await open(sysinfo());
    expect(rows('Exposed ports')).toEqual(['Main UI: TCP 9900', 'RTP UDP: UDP 9000–9079']);
  });

  it('says "No details reported." for a section with nothing in it', async () => {
    await open(sysinfo({ components: {}, exposedPorts: [], updateCheck: { schema: 'x' } }));
    expect(text(section('Components'))).toContain('No details reported.');
    expect(text(section('Exposed ports'))).toContain('No details reported.');
    expect(text(section('Update check'))).toContain('No details reported.');
  });

  it('a missing neat replaces Environment, Components and Update check with the note, keeping Insight and ports', async () => {
    await open(withoutNeat());

    expect(
      [...dialog().querySelectorAll('neat-collapsible')].map((one) =>
        text(one.querySelector('button')),
      ),
    ).toEqual(['Insight', 'Exposed ports']);
    expect(text(dialog().querySelector('neat-callout'))).toContain(
      'The neat command is not installed here, so the environment, component versions and update check are unknown.',
    );
    expect(rows('Insight')).toContain('Web UI URL: https://127.0.0.1:9900');
    expect(rows('Exposed ports')).toEqual(['Main UI: TCP 9900']);
    expect(text(dialog().querySelector('p'))).toBe('Neat Environment · https://127.0.0.1:9900');
  });

  it('says that it is loading until the first answer', async () => {
    openSystemInfoDialog(TestBed.inject(Injector));
    await settle();
    expect(text(dialog())).toContain('Loading system information…');
    expect(dialog().querySelector('neat-collapsible')).toBeNull();
    expect(button('Refreshing…').getAttribute('aria-disabled')).toBe('true');
    reply(sysinfo());
    await settle();
    expect(text(dialog())).not.toContain('Loading system information…');
    expect(button('Refresh').getAttribute('aria-disabled')).toBeNull();
  });

  it('a failure with no data shows the message alone, and Refresh tries again', async () => {
    await open({ status: 502, error: 'neat exited with status 3' });
    expect(text(errorNote())).toBe('neat exited with status 3');
    expect(dialog().querySelector('neat-collapsible')).toBeNull();

    button('Refresh').click();
    await settle();
    reply(sysinfo());
    await settle();
    expect(errorNote()).toBeNull();
    expect(rows('Insight')).toHaveLength(3);
  });

  it('every Refresh asks again, and says Refreshing… while it waits', async () => {
    await open(sysinfo());

    button('Refresh').click();
    await settle();
    expect(button('Refreshing…').getAttribute('aria-disabled')).toBe('true');
    // One request at a time: another click while one is out sends nothing.
    button('Refreshing…').click();
    const request = http.expectOne('/api/sysinfo');
    request.flush(
      sysinfo({ insight: { serviceState: 'Stopped', webUiUrl: 'https://10.1.1.5:9900' } }),
    );
    await settle();
    expect(rows('Insight')).toContain('Service state: Stopped');
    expect(button('Refresh').getAttribute('aria-disabled')).toBeNull();
  });

  it('a failed Refresh keeps the shown data and says it could not refresh', async () => {
    await open(sysinfo());
    section('Components')!.querySelector('button')!.click();
    await settle();

    button('Refresh').click();
    await settle();
    reply({
      status: 504,
      error: 'The neat command timed out while collecting system information.',
    });
    await settle();

    expect(text(errorNote())).toBe(
      'Could not refresh: The neat command timed out while collecting system information.',
    );
    expect(rows('Insight')).toContain('Service state: Running');
    // The sections stay as they were, including the one the user opened.
    expect(expanded('Components')).toBe('true');

    // The next good answer clears it.
    button('Refresh').click();
    await settle();
    reply(sysinfo());
    await settle();
    expect(errorNote()).toBeNull();
  });

  it('Close closes the dialog', async () => {
    await open(sysinfo());
    button('Close').click();
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Escape closes it', async () => {
    await open(sysinfo());
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
