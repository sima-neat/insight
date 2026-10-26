import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import { FakeBoard } from '../board/board.testing';
import { BoardService } from '../board/board.service';
import type { SentinelDaemon } from './api';
import { SentinelInstall } from './sentinel-install';

const daemon: SentinelDaemon = {
  installed: true,
  healthy: true,
  service: 'active',
  socket: true,
  socket_path: '/run/sentinel.sock',
  sima_cli: '/usr/bin/sima-cli',
  instance_id: 'abc',
  started_at: '2026-10-24T10:00:00Z',
};

const installed = (generation: number) => ({
  board: { label: 'sima@192.168.1.20', source: 'sdk-env' },
  generation,
  daemon,
  log: 'installed simaai-sentinel 1.2.3',
});

/** The installer exited non-zero: the backend answers `sentinel_failed` with the output tail. */
const installerFailed = {
  error: 'The installer exited with status 1.',
  code: 'sentinel_failed',
  generation: 3,
  detail: 'E: unable to locate package simaai-sentinel',
};

function installRequest(http: HttpTestingController) {
  return http.expectOne((request) => request.url === '/api/sentinel/install');
}

describe('SentinelInstall', () => {
  let http: HttpTestingController;
  let board: FakeBoard;
  let toasts: { status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let install: SentinelInstall;

  beforeEach(() => {
    board = new FakeBoard();
    toasts = { status: vi.fn(), error: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: BoardService, useValue: board },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    install = TestBed.inject(SentinelInstall);
  });

  afterEach(() => http.verify());

  it('install posts with the generation, toasts "Sentinel installed on <label>."', async () => {
    const done = install.install(3, 'sima@192.168.1.20');
    expect(install.running()).toEqual({ generation: 3, label: 'sima@192.168.1.20' });
    const request = installRequest(http);
    expect(request.request.method).toBe('POST');
    expect(request.request.params.get('generation')).toBe('3');
    expect(request.request.body).toEqual({});
    expect(board.reload).not.toHaveBeenCalled();

    request.flush(installed(3));
    await done;

    expect(toasts.status).toHaveBeenCalledWith('Sentinel installed on sima@192.168.1.20.');
    expect(toasts.error).not.toHaveBeenCalled();
    expect(install.outcome()).toEqual({
      generation: 3,
      ok: true,
      log: 'installed simaai-sentinel 1.2.3',
    });
    expect(install.running()).toBeNull();
    expect(board.reload).toHaveBeenCalledTimes(1);
  });

  it('a second install while one runs sends nothing', async () => {
    const first = install.install(3, 'sima@192.168.1.20');
    // Another board's install is refused too: the backend runs one at a time.
    await install.install(4, 'sima@192.168.1.21');
    await install.install(3, 'sima@192.168.1.20');
    expect(install.running()).toEqual({ generation: 3, label: 'sima@192.168.1.20' });

    installRequest(http).flush(installed(3));
    await first;
    expect(board.reload).toHaveBeenCalledTimes(1);

    // Once it ended, the next install goes out.
    const next = install.install(4, 'sima@192.168.1.21');
    installRequest(http).flush(installed(4));
    await next;
  });

  it('a failed install keeps its failure and the installer output for that generation and toasts its message', async () => {
    const done = install.install(3, 'sima@192.168.1.20');
    installRequest(http).flush(installerFailed, { status: 502, statusText: 'Bad Gateway' });
    await done;

    const outcome = install.outcome();
    expect(outcome?.ok).toBe(false);
    if (outcome === null || outcome.ok) throw new Error('expected a failed install');
    expect(outcome.generation).toBe(3);
    expect(outcome.failure).toMatchObject({
      code: 'sentinel_failed',
      generation: 3,
      action: 'install',
      title: 'Sentinel could not be installed',
      detail: 'E: unable to locate package simaai-sentinel',
    });
    expect(toasts.error).toHaveBeenCalledExactlyOnceWith('The installer exited with status 1.');
    expect(toasts.status).not.toHaveBeenCalled();
    expect(install.running()).toBeNull();
    // A failed installer may still have left the service running: the board is read again.
    expect(board.reload).toHaveBeenCalledTimes(1);
  });

  it('a new install clears the last outcome', async () => {
    const failed = install.install(3, 'sima@192.168.1.20');
    installRequest(http).flush(installerFailed, { status: 502, statusText: 'Bad Gateway' });
    await failed;
    expect(install.outcome()?.ok).toBe(false);

    const retry = install.install(3, 'sima@192.168.1.20');
    expect(install.outcome()).toBeNull();
    installRequest(http).flush(installed(3));
    await retry;
    expect(install.outcome()?.ok).toBe(true);
  });

  it('the install outlives a destroyed page injector', async () => {
    // What a page reaches Sentinel's install through: its own injector, destroyed on leaving.
    const page = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    const done = page.get(SentinelInstall).install(3, 'sima@192.168.1.20');
    page.destroy();

    // The request is still out, not cancelled with the page.
    const request = installRequest(http);
    expect(request.cancelled).toBe(false);
    expect(install.running()).toEqual({ generation: 3, label: 'sima@192.168.1.20' });

    request.flush(installed(3));
    await done;
    expect(install.outcome()?.ok).toBe(true);
    expect(toasts.status).toHaveBeenCalledWith('Sentinel installed on sima@192.168.1.20.');
  });
});
