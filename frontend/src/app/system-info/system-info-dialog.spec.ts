import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient, type HttpRequest } from '@angular/common/http';
import { Component, Injector } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { HostReadings, SystemInfo, SystemInsight, SystemNeat } from './api';
import { openSystemInfoDialog } from './system-info-dialog';

/** Something to render, so that change detection runs for the dialog in the overlay. */
@Component({ template: '' })
class Host {}

const INSIGHT: SystemInsight = {
  version: '0.12.0',
  build: { go_version: 'go1.26.0', platform: 'linux/arm64' },
  place: 'sdk',
  data_dir: '/home/sima/.local/share/neat-insight',
  port: 9900,
  web_ui_url: 'https://10.1.1.5:9900',
  network: { certificate_host: '10.1.1.5', browser_ice_address_source: 'default' },
  ports: {
    channels: 16,
    channels_source: 'port map',
    webrtc_start: 9200,
    webrtc_end: 9215,
    rtsp: 8554,
    whip: 8889,
    whip_ice: 8189,
  },
};

/** What neat answers on an SDK with a DevKit paired, trimmed to what the dialog shows. */
function neat(overrides: Partial<SystemNeat> = {}): SystemNeat {
  return {
    state: 'ready',
    read_at: '2026-11-19T10:00:00Z',
    environment: {
      label: 'SDK 2.1 on a DevKit',
      mode: 'elxr-sdk',
      sdkVersion: '2.1.0',
      sysroot: null,
    },
    insight: { serviceState: 'Running', venv: '/opt/insight' },
    components: {
      neatCore: { name: 'Neat core', version: '1.4.0', tag: 'v1.4.0', channel: 'stable' },
      insight: { name: null, version: '0.9.1', latestVersion: '0.10.0', updateAvailable: true },
      sdkTools: {
        name: null,
        version: '2.1.0',
        latestVersion: '2.1.0',
        updateAvailable: false,
        venv: '/opt/sdk',
      },
      modelCompiler: {
        name: null,
        version: null,
        installed: false,
        updateAvailable: false,
        detail: 'Not installed',
      },
    },
    update_check: { offline: true, status: 'Update available' },
    exposed_ports: [
      { name: 'mainUI', protocol: 'tcp', hostPortStart: 9900, hostPortEnd: 9900 },
      { name: 'rtp.udp', protocol: 'udp', hostPortStart: 9000, hostPortEnd: 9079 },
    ],
    ...overrides,
  };
}

function system(neatOverrides: Partial<SystemNeat> = {}): SystemInfo {
  return { insight: INSIGHT, neat: neat(neatOverrides) };
}

/** What Insight answers without the `neat` command: its own facts and the port map's ports. */
function withoutNeat(): SystemInfo {
  return {
    insight: { ...INSIGHT, web_ui_url: 'https://127.0.0.1:9900' },
    neat: {
      state: 'missing',
      exposed_ports: [{ name: 'mainUI', protocol: 'tcp', hostPortStart: 9900, hostPortEnd: 9900 }],
    },
  };
}

/** What `GET /api/system/host` answers. */
function host(overrides: Partial<HostReadings> = {}): HostReadings {
  return {
    cpu_percent: 34,
    memory: { total: 16 * 1024 ** 3, used: 8 * 1024 ** 3, percent: 52 },
    disk: { path: '/home/sima', total: 200 * 1024 ** 3, used: 120 * 1024 ** 3, percent: 61 },
    ...overrides,
  };
}

interface Failure {
  status: number;
  message: string;
}

const systemRequest = (request: HttpRequest<unknown>) => request.url === '/api/system';
const hostRequest = (request: HttpRequest<unknown>) => request.url === '/api/system/host';

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
   * Opens the dialog and answers its first requests: `answer` for `/api/system` and `readings`
   * for `/api/system/host` (each a payload or a failure).
   */
  async function open(
    answer: SystemInfo | Failure,
    readings: HostReadings | Failure = host(),
  ): Promise<void> {
    openSystemInfoDialog(TestBed.inject(Injector));
    await settle();
    reply(answer, readings);
    await settle();
  }

  /** Answers the pending requests, `/api/system` and `/api/system/host`, as Open and Refresh send them. */
  function reply(answer: SystemInfo | Failure, readings: HostReadings | Failure = host()): void {
    flush(systemRequest, answer);
    flush(hostRequest, readings);
  }

  /** Answers the one request `match` finds; returns whether it asked to run neat again. */
  function flush(
    match: (request: HttpRequest<unknown>) => boolean,
    answer: SystemInfo | HostReadings | Failure,
  ): boolean {
    const request = http.expectOne(match);
    const refresh = request.request.params.get('refresh') === 'true';
    if ('status' in answer) {
      request.flush(
        { error: { code: 'failed', message: answer.message } },
        { status: answer.status, statusText: 'Error' },
      );
    } else {
      request.flush(answer);
    }
    return refresh;
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
  const sections = () =>
    [...dialog().querySelectorAll('neat-collapsible')].map((one) =>
      text(one.querySelector('button')),
    );
  const expanded = (label: string) =>
    section(label)?.querySelector('button')?.getAttribute('aria-expanded');
  /** The terms and values of a section's list, as `term: value` lines. */
  const rows = (label: string) =>
    [...section(label)!.querySelectorAll('dt')].map(
      (term) => `${text(term)}: ${text(term.nextElementSibling)}`,
    );
  /** An element's words as they read: its text pieces joined by spaces, as a chip and its neighbors do. */
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
    await open(system());

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

  it('names the environment and the web address under the title, else "Neat Environment"', async () => {
    await open(system());
    expect(text(dialog().querySelector('p'))).toBe('SDK 2.1 on a DevKit · https://10.1.1.5:9900');
    button('Refresh').click();
    await settle();
    reply(system({ environment: { mode: 'modalix-board' } }));
    await settle();
    expect(text(dialog().querySelector('p'))).toBe('Neat Environment · https://10.1.1.5:9900');
  });

  it('lists Environment, Insight and Update check as words', async () => {
    await open(system());
    expect(rows('Environment')).toEqual([
      'Label: SDK 2.1 on a DevKit',
      'Mode: elxr-sdk',
      'SDK version: 2.1.0',
      'Sysroot: -',
    ]);
    expect(rows('Insight')).toEqual([
      'Version: 0.12.0',
      'Build: go1.26.0 · linux/arm64',
      'Runs: In the Neat SDK',
      'Web UI URL: https://10.1.1.5:9900',
      'Port: 9900',
      'Data folder: /home/sima/.local/share/neat-insight',
      'Certificate host: 10.1.1.5',
      'Channels: 16 (port map)',
      'WebRTC ports: 9200–9215',
      'RTSP port: 8554',
      'WHIP port: 8889',
      'WHIP ICE port: 8189',
      'Service state: Running',
      'Virtual environment: /opt/insight',
    ]);
    // A boolean is words, not a chip.
    expect(rows('Update check')).toEqual(['Offline: Yes', 'Status: Update available']);
    expect(section('Update check')!.querySelector('neat-status-chip')).toBeNull();
  });

  it('lists the components with their version, status and detail', async () => {
    await open(system());
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
    // Not installed: no update status.
    expect(line('Model compiler')).toBe('- Not installed');
    expect(components.querySelectorAll('neat-status-chip')).toHaveLength(2);
  });

  it('lists the exposed ports with their protocol and range', async () => {
    await open(system());
    expect(rows('Exposed ports')).toEqual(['Main UI: TCP 9900', 'RTP UDP: UDP 9000–9079']);
  });

  it('says "No details reported." for a section with nothing in it', async () => {
    await open(system({ components: {}, exposed_ports: [], update_check: {} }));
    expect(text(section('Components'))).toContain('No details reported.');
    expect(text(section('Exposed ports'))).toContain('No details reported.');
    expect(text(section('Update check'))).toContain('No details reported.');
  });

  it('a missing neat replaces Environment, Components and Update check with the note, keeping Insight and ports', async () => {
    await open(withoutNeat());

    expect(sections()).toEqual(['Insight', 'This computer', 'Exposed ports']);
    expect(text(dialog().querySelector('neat-callout'))).toContain(
      'The neat command is not installed here, so the environment, component versions and update check are unknown.',
    );
    expect(rows('Insight')).toContain('Web UI URL: https://127.0.0.1:9900');
    expect(rows('Exposed ports')).toEqual(['Main UI: TCP 9900']);
    expect(text(dialog().querySelector('p'))).toBe('Neat Environment · https://127.0.0.1:9900');
  });

  it('a failed neat says why in place of its sections', async () => {
    await open(
      system({
        state: 'failed',
        environment: undefined,
        error: { code: 'neat_failed', message: 'neat exited with status 3.', hint: 'Run it.' },
      }),
    );
    expect(sections()).toEqual(['Insight', 'This computer', 'Exposed ports']);
    expect(text(errorNote())).toBe('Could not read neat: neat exited with status 3. Run it.');
  });

  it('while the server is still reading neat, asks again and waits for that run', async () => {
    openSystemInfoDialog(TestBed.inject(Injector));
    await settle();
    expect(flush(systemRequest, system({ state: 'reading' }))).toBe(false);
    flush(hostRequest, host());
    await settle();
    expect(text(dialog())).toContain(
      'Reading the environment, components and update check from neat…',
    );
    expect(button('Refreshing…').getAttribute('aria-disabled')).toBe('true');
    expect(rows('Insight')).toContain('Version: 0.12.0');

    // The second read waits for neat's run; the host is not read again for it.
    expect(flush(systemRequest, system())).toBe(true);
    await settle();
    expect(sections()).toContain('Environment');
    expect(button('Refresh').getAttribute('aria-disabled')).toBeNull();
  });

  it('says that it is loading until the first answer', async () => {
    openSystemInfoDialog(TestBed.inject(Injector));
    await settle();
    expect(text(dialog())).toContain('Loading system information…');
    // Only "This computer" has anything to show before the answer (it says it is reading).
    expect(sections()).toEqual(['This computer']);
    expect(button('Refreshing…').getAttribute('aria-disabled')).toBe('true');
    reply(system());
    await settle();
    expect(text(dialog())).not.toContain('Loading system information…');
    expect(button('Refresh').getAttribute('aria-disabled')).toBeNull();
  });

  it('a failure with no data shows the message alone, and Refresh tries again', async () => {
    await open({ status: 500, message: 'Insight failed.' });
    expect(text(errorNote())).toBe('Insight failed.');
    expect(sections()).toEqual(['This computer']);

    button('Refresh').click();
    await settle();
    reply(system());
    await settle();
    expect(errorNote()).toBeNull();
    expect(rows('Insight')).toContain('Version: 0.12.0');
  });

  it('every Refresh runs neat again, and says Refreshing… while it waits', async () => {
    await open(system());

    button('Refresh').click();
    await settle();
    expect(button('Refreshing…').getAttribute('aria-disabled')).toBe('true');
    // One request at a time: another click while one is out sends nothing.
    button('Refreshing…').click();
    flush(hostRequest, host());
    expect(flush(systemRequest, system({ insight: { serviceState: 'Stopped' } }))).toBe(true);
    await settle();
    expect(rows('Insight')).toContain('Service state: Stopped');
    expect(button('Refresh').getAttribute('aria-disabled')).toBeNull();
  });

  it('a failed Refresh keeps the shown data and says it could not refresh', async () => {
    await open(system());
    section('Components')!.querySelector('button')!.click();
    section('Environment')!.querySelector('button')!.click();
    await settle();
    expect(expanded('Components')).toBe('true');
    expect(expanded('Environment')).toBe('false');

    button('Refresh').click();
    await settle();
    reply({ status: 500, message: 'Insight failed.' });
    await settle();

    expect(text(errorNote())).toBe('Could not refresh: Insight failed.');
    expect(rows('Insight')).toContain('Service state: Running');
    // The sections stay as they were: the one the user opened and the one they closed.
    expect(expanded('Components')).toBe('true');
    expect(expanded('Environment')).toBe('false');

    // The next good answer clears it.
    button('Refresh').click();
    await settle();
    reply(system());
    await settle();
    expect(errorNote()).toBeNull();
  });

  it('closing the dialog ends the request, and opening it again asks anew', async () => {
    openSystemInfoDialog(TestBed.inject(Injector));
    await settle();
    const first = http.expectOne(systemRequest);
    const firstHost = http.expectOne(hostRequest);
    button('Close').click();
    await settle();
    // neat runs for seconds: nobody is waiting for this answer any more.
    expect(first.cancelled).toBe(true);
    expect(firstHost.cancelled).toBe(true);

    await open(system());
    expect(rows('Insight')).toContain('Version: 0.12.0');
  });

  describe('This computer', () => {
    const computerNote = () => text(section('This computer')!.querySelector('p'));
    /** What the section reports about a failed read, apart from System Info's own failure. */
    const computerError = () => section('This computer')!.querySelector('neat-error-note');

    it('lists CPU, memory used of total and disk used of total with its folder', async () => {
      await open(system());
      expect(computerNote()).toBe('The machine Insight runs on, not the board.');
      expect(section('This computer')!.querySelector('p')!.hasAttribute('neatNote')).toBe(true);
      expect(rows('This computer')).toEqual([
        'CPU: 34%',
        'Memory: 52% · 8.00 GB of 16.00 GB',
        'Disk: 61% · 120.00 GB of 200.00 GB · /home/sima',
      ]);
      expect(section('This computer')!.querySelector('dl')!.hasAttribute('neatDetails')).toBe(true);
    });

    it('says so when Insight answers with no reading, instead of listing nothing', async () => {
      await open(system(), host({ cpu_percent: null, memory: null, disk: null }));
      expect(section('This computer')!.querySelector('dl')).toBeNull();
      expect(text(section('This computer'))).toContain(
        'Insight answered with no CPU, memory or disk reading for this computer, so none is shown rather than zeros.',
      );
    });

    it('reads the host when the dialog opens and on Refresh; a failed read keeps the readings and says so', async () => {
      await open(system());
      expect(rows('This computer')[0]).toBe('CPU: 34%');
      expect(computerError()).toBeNull();

      button('Refresh').click();
      await settle();
      reply(system(), { status: 500, message: '/proc/meminfo could not be read.' });
      await settle();
      expect(text(computerError())).toBe(
        'Could not read this computer: /proc/meminfo could not be read.',
      );
      // The last readings stay, and the rest of the dialog is not told of it.
      expect(rows('This computer')[0]).toBe('CPU: 34%');
      expect(text(errorNote())).toBe(
        'Could not read this computer: /proc/meminfo could not be read.',
      );
      expect(rows('Insight')).toContain('Version: 0.12.0');

      // A good answer replaces the readings and clears the failure.
      button('Refresh').click();
      await settle();
      reply(system(), host({ cpu_percent: 71 }));
      await settle();
      expect(computerError()).toBeNull();
      expect(rows('This computer')[0]).toBe('CPU: 71%');
    });

    it('says Reading this computer… only until the first answer', async () => {
      openSystemInfoDialog(TestBed.inject(Injector));
      await settle();
      expect(text(section('This computer'))).toContain('Reading this computer…');
      expect(section('This computer')!.querySelector('dl')).toBeNull();

      flush(hostRequest, host());
      await settle();
      expect(text(section('This computer'))).not.toContain('Reading this computer…');
      expect(rows('This computer')).toHaveLength(3);

      // A Refresh keeps the readings and does not say it is reading again.
      flush(systemRequest, system());
      await settle();
      button('Refresh').click();
      await settle();
      expect(text(section('This computer'))).not.toContain('Reading this computer…');
      expect(rows('This computer')).toHaveLength(3);
      reply(system());
    });

    it('a failed first read shows the failure instead of the notice', async () => {
      await open(system(), { status: 500, message: 'No /proc.' });
      expect(words(section('This computer'))).toBe(
        'This computer Could not read this computer: No /proc.',
      );
    });

    it('stays when /api/system fails, and the failure with no data stays too', async () => {
      await open({ status: 500, message: 'Insight failed.' });
      expect(rows('This computer')[0]).toBe('CPU: 34%');
      expect(text(errorNote())).toBe('Insight failed.');
    });

    it('only the newest answer counts: a Refresh drops the read still out', async () => {
      openSystemInfoDialog(TestBed.inject(Injector));
      await settle();
      const first = http.expectOne(hostRequest);
      http.expectOne(systemRequest).flush(system());
      await settle();

      button('Refresh').click();
      await settle();
      expect(first.cancelled).toBe(true);
      http.expectOne(systemRequest).flush(system());
      http.expectOne(hostRequest).flush(host({ cpu_percent: 9 }));
      await settle();
      expect(rows('This computer')[0]).toBe('CPU: 9%');
    });
  });

  it('tells a screen reader when a Refresh has replaced the data, not for the first answer', async () => {
    await open(system());
    const announcement = () => text(dialog().querySelector('app-announcement'));
    expect(announcement()).toBe('');

    button('Refresh').click();
    await settle();
    expect(announcement()).toBe('');
    reply(system());
    await settle();
    expect(announcement()).toBe('System information refreshed.');

    // Cleared when the next Refresh starts, so that the same words are said again.
    button('Refresh').click();
    await settle();
    expect(announcement()).toBe('');
    reply(system());
    await settle();
    expect(announcement()).toBe('System information refreshed.');
  });

  it('Close closes the dialog', async () => {
    await open(system());
    button('Close').click();
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Escape closes it', async () => {
    await open(system());
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
