import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { Component, Injector } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { HostMetrics, SystemInfo } from './api';
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
      sdkTools: {
        version: '2.1.0',
        latestVersion: '2.1.0',
        updateAvailable: false,
        venv: '/opt/sdk',
      },
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

/** What `GET /api/metrics` answers on a local machine, with the temperature Insight has none of. */
function hostMetrics(overrides: Partial<HostMetrics> = {}): HostMetrics {
  return {
    cpu_load: 34,
    memory: { total: 16 * 1024 ** 3, used: 8 * 1024 ** 3, percent: 52 },
    disk: { mount: '/home/sima', total: 200 * 1024 ** 3, used: 120 * 1024 ** 3, percent: 61 },
    temperature_celsius_avg: null,
    REMOTE: false,
    ...overrides,
  };
}

interface Failure {
  status: number;
  error: string;
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

  /**
   * Opens the dialog and answers its first requests: `answer` for `/api/sysinfo` and `metrics` for
   * `/api/metrics` (each a payload or a failure).
   */
  async function open(
    answer: SystemInfo | Failure,
    metrics: HostMetrics | Failure = hostMetrics(),
  ): Promise<void> {
    openSystemInfoDialog(TestBed.inject(Injector));
    await settle();
    reply(answer, metrics);
    await settle();
  }

  /** Answers the pending requests, `/api/sysinfo` and `/api/metrics`, as Open and Refresh send them. */
  function reply(
    answer: SystemInfo | Failure,
    metrics: HostMetrics | Failure = hostMetrics(),
  ): void {
    flush('/api/sysinfo', answer);
    flush('/api/metrics', metrics);
  }

  function flush(url: string, answer: SystemInfo | HostMetrics | Failure): void {
    const request = http.expectOne(url);
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
      'This computer: true',
      'Components: false',
      'Exposed ports: false',
      'Update check: true',
    ]);
    // Each is a heading of the outline, under the dialog's title.
    expect(
      [...dialog().querySelectorAll('[role="heading"]')].map(
        (heading) => `${heading.getAttribute('aria-level')} ${text(heading)}`,
      ),
    ).toEqual([
      '3 Environment',
      '3 Insight',
      '3 This computer',
      '3 Components',
      '3 Exposed ports',
      '3 Update check',
    ]);
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
    // No name: the key, as words. The latest version is the muted line, when it is news.
    expect(line('Insight')).toBe('0.9.1 Update available Latest 0.10.0');
    // The latest version equal to the installed one repeats it: the line is the venv instead.
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
    ).toEqual(['Insight', 'This computer', 'Exposed ports']);
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
    // Only "This computer" has anything to show before neat answers (it says it is reading).
    expect(
      [...dialog().querySelectorAll('neat-collapsible')].map((one) =>
        text(one.querySelector('button')),
      ),
    ).toEqual(['This computer']);
    expect(button('Refreshing…').getAttribute('aria-disabled')).toBe('true');
    reply(sysinfo());
    await settle();
    expect(text(dialog())).not.toContain('Loading system information…');
    expect(button('Refresh').getAttribute('aria-disabled')).toBeNull();
  });

  it('a failure with no data shows the message alone, and Refresh tries again', async () => {
    await open({ status: 502, error: 'neat exited with status 3' });
    expect(text(errorNote())).toBe('neat exited with status 3');
    expect(
      [...dialog().querySelectorAll('neat-collapsible')].map((one) =>
        text(one.querySelector('button')),
      ),
    ).toEqual(['This computer']);

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
    http.expectOne('/api/metrics').flush(hostMetrics());
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
    section('Environment')!.querySelector('button')!.click();
    await settle();
    expect(expanded('Components')).toBe('true');
    expect(expanded('Environment')).toBe('false');

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
    // The sections stay as they were: the one the user opened and the one they closed.
    expect(expanded('Components')).toBe('true');
    expect(expanded('Environment')).toBe('false');

    // The next good answer clears it.
    button('Refresh').click();
    await settle();
    reply(sysinfo());
    await settle();
    expect(errorNote()).toBeNull();
  });

  it('closing the dialog ends the request, and opening it again asks anew', async () => {
    openSystemInfoDialog(TestBed.inject(Injector));
    await settle();
    const first = http.expectOne('/api/sysinfo');
    const firstMetrics = http.expectOne('/api/metrics');
    button('Close').click();
    await settle();
    // neat runs for seconds: nobody is waiting for this answer any more.
    expect(first.cancelled).toBe(true);
    expect(firstMetrics.cancelled).toBe(true);

    await open(sysinfo());
    expect(rows('Insight')).toHaveLength(3);
  });

  describe('This computer', () => {
    const computerNote = () => text(section('This computer')!.querySelector('p'));
    /** What the section reports about a failed read, apart from the System Info's own failure. */
    const computerError = () => section('This computer')!.querySelector('neat-error-note');

    it('This computer lists CPU, memory used of total and disk used of total with its mount', async () => {
      await open(sysinfo());
      expect(computerNote()).toBe('The machine Insight runs on, not the board.');
      expect(section('This computer')!.querySelector('p')!.hasAttribute('neatNote')).toBe(true);
      expect(rows('This computer')).toEqual([
        'CPU: 34%',
        'Memory: 52% · 8.00 GB of 16.00 GB',
        'Disk: 61% · 120.00 GB of 200.00 GB · /home/sima',
      ]);
      expect(section('This computer')!.querySelector('dl')!.hasAttribute('neatDetails')).toBe(true);
    });

    it('shows the temperature only when Insight reports one, never a remote 0', async () => {
      await open(sysinfo(), hostMetrics({ temperature_celsius_avg: 48.5 }));
      expect(rows('This computer')).toContain('Temperature: 48.5 °C');
      button('Refresh').click();
      await settle();
      reply(sysinfo(), hostMetrics({ REMOTE: true, temperature_celsius_avg: 0 }));
      await settle();
      expect(rows('This computer').filter((row) => row.startsWith('Temperature'))).toEqual([]);
    });

    it('a remote DevKit says so, and one that is not connected says it reports nothing', async () => {
      await open(sysinfo(), hostMetrics({ REMOTE: true }));
      expect(computerNote()).toBe(
        'Remote DevKit from the legacy REMOTE_DEVKIT configuration, not the board.',
      );
      expect(rows('This computer')).toHaveLength(3);

      button('Refresh').click();
      await settle();
      reply(sysinfo(), {
        cpu_load: '',
        memory: {},
        disk: {},
        temperature_celsius_avg: 0,
        REMOTE: true,
      });
      await settle();
      expect(section('This computer')!.querySelector('dl')).toBeNull();
      expect(text(section('This computer'))).toContain(
        'A remote DevKit is configured for this endpoint but is not connected, so it reports nothing.',
      );
    });

    it('says so when Insight answers with no reading, instead of listing nothing', async () => {
      await open(
        sysinfo(),
        hostMetrics({ cpu_load: null, memory: {}, disk: null, temperature_celsius_avg: null }),
      );
      expect(section('This computer')!.querySelector('dl')).toBeNull();
      expect(text(section('This computer'))).toContain(
        'Insight answered with no CPU, memory or disk reading for this computer, so none is shown rather than zeros.',
      );
    });

    it('reads /api/metrics when the dialog opens and on Refresh; a failed read keeps the readings and says so', async () => {
      await open(sysinfo());
      expect(rows('This computer')[0]).toBe('CPU: 34%');
      expect(computerError()).toBeNull();

      button('Refresh').click();
      await settle();
      reply(sysinfo(), { status: 500, error: 'psutil failed' });
      await settle();
      expect(text(computerError())).toBe('Could not read this computer: psutil failed');
      // The last readings stay, and the rest of the dialog is not told of it.
      expect(rows('This computer')[0]).toBe('CPU: 34%');
      expect(text(errorNote())).toBe('Could not read this computer: psutil failed');
      expect(rows('Insight')).toHaveLength(3);

      // A good answer replaces the readings and clears the failure.
      button('Refresh').click();
      await settle();
      reply(sysinfo(), hostMetrics({ cpu_load: 71 }));
      await settle();
      expect(computerError()).toBeNull();
      expect(rows('This computer')[0]).toBe('CPU: 71%');
    });

    it('says Reading this computer… only until the first answer', async () => {
      openSystemInfoDialog(TestBed.inject(Injector));
      await settle();
      expect(text(section('This computer'))).toContain('Reading this computer…');
      expect(section('This computer')!.querySelector('dl')).toBeNull();

      flush('/api/metrics', hostMetrics());
      await settle();
      expect(text(section('This computer'))).not.toContain('Reading this computer…');
      expect(rows('This computer')).toHaveLength(3);

      // A Refresh keeps the readings and does not say it is reading again.
      flush('/api/sysinfo', sysinfo());
      await settle();
      button('Refresh').click();
      await settle();
      expect(text(section('This computer'))).not.toContain('Reading this computer…');
      expect(rows('This computer')).toHaveLength(3);
      reply(sysinfo());
    });

    it('a failed first read shows the failure instead of the notice', async () => {
      await open(sysinfo(), { status: 500, error: 'psutil failed' });
      expect(words(section('This computer'))).toBe(
        'This computer Could not read this computer: psutil failed',
      );
    });

    it('stays when /api/sysinfo fails, and the failure with no data stays too', async () => {
      await open({ status: 502, error: 'neat exited with status 3' });
      expect(rows('This computer')[0]).toBe('CPU: 34%');
      expect(text(errorNote())).toBe('neat exited with status 3');
    });

    it('only the newest answer counts: a Refresh drops the read still out', async () => {
      openSystemInfoDialog(TestBed.inject(Injector));
      await settle();
      const first = http.expectOne('/api/metrics');
      http.expectOne('/api/sysinfo').flush(sysinfo());
      await settle();

      button('Refresh').click();
      await settle();
      expect(first.cancelled).toBe(true);
      http.expectOne('/api/sysinfo').flush(sysinfo());
      http.expectOne('/api/metrics').flush(hostMetrics({ cpu_load: 9 }));
      await settle();
      expect(rows('This computer')[0]).toBe('CPU: 9%');
    });
  });

  it('tells a screen reader when a Refresh has replaced the data, not for the first answer', async () => {
    await open(sysinfo());
    const announcement = () => text(dialog().querySelector('[role="status"]'));
    expect(announcement()).toBe('');

    button('Refresh').click();
    await settle();
    expect(announcement()).toBe('');
    reply(sysinfo());
    await settle();
    expect(announcement()).toBe('System information refreshed.');

    // Cleared when the next Refresh starts, so that the same words are said again.
    button('Refresh').click();
    await settle();
    expect(announcement()).toBe('');
    reply(sysinfo());
    await settle();
    expect(announcement()).toBe('System information refreshed.');
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
