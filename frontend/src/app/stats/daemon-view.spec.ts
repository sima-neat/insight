import installFailures from '../../../../tests/fixtures/sentinel/install-failures.json';
import type { SentinelDaemon, SentinelHealth, SentinelState } from './api';
import { daemonView, healthProblems } from './daemon-view';
import { failureOf } from './sentinel-failure';
import { sentinelState } from './stats.testing';

/**
 * A state Sentinel answered, from #170's captured `install-failures.json`. The capture predates
 * the daemon's `instance_id` and `started_at`, which these specs do not read.
 */
const captured = (name: string) =>
  (installFailures as Record<string, { body: unknown }>)[name].body as SentinelState;

const daemon = (extra: Partial<SentinelDaemon> = {}): SentinelDaemon => ({
  ...sentinelState().daemon,
  ...extra,
});

const missingError = {
  error: 'Sentinel is not installed on this board.',
  code: 'sentinel_missing',
  hint: 'Install it from this page.',
};

describe('daemonView', () => {
  it('the daemon state says what is wrong and whether this page can install it', () => {
    const ready = daemonView(sentinelState({ version: 'main:80ab' }));
    expect([ready.label, ready.canInstall]).toEqual(['Running', false]);
    expect(ready.installBlocked).toMatch(/already running/);
    expect([ready.state, ready.available, ready.version, ready.error]).toEqual([
      'ready',
      true,
      'main:80ab',
      null,
    ]);

    const missing = daemonView(
      sentinelState({
        available: false,
        daemon: daemon({ installed: false, healthy: false, service: 'inactive', socket: false }),
        status: { state: 'missing', error: { ...missingError } },
      }),
    );
    expect([missing.label, missing.canInstall, missing.error?.code]).toEqual([
      'Not installed',
      true,
      'sentinel_missing',
    ]);

    const noCli = daemonView(
      sentinelState({
        daemon: daemon({ healthy: false, sima_cli: null }),
        status: { state: 'missing', error: null },
      }),
    );
    expect(noCli.canInstall).toBe(false);
    expect(noCli.installBlocked).toMatch(/sima-cli was not found/);

    const unknown = daemonView(null);
    expect([unknown.state, unknown.label, unknown.canInstall]).toEqual([
      'unknown',
      'Unknown',
      false,
    ]);
  });

  it('the daemon reports when it started and where its installer is', () => {
    const view = daemonView(sentinelState());
    expect([view.startedAt, view.simaCli]).toEqual([
      '2026-10-24T09:30:00+00:00',
      '/usr/bin/sima-cli',
    ]);
    const stopped = daemonView(
      sentinelState({ daemon: daemon({ started_at: null, sima_cli: null }) }),
    );
    expect([stopped.startedAt, stopped.simaCli]).toEqual([null, null]);
  });

  it('a daemon that is not there offers the one install that fixes it, and an install this page cannot run says why', () => {
    const absent = installFailures.daemon_absent;
    expect(absent.status, 'a board without Sentinel is not itself a failure').toBe(200);
    const view = daemonView(captured('daemon_absent'));
    expect([view.state, view.label, view.available, view.canInstall, view.installBlocked]).toEqual([
      'missing',
      'Not installed',
      false,
      true,
      '',
    ]);
    const failure = failureOf(view.error, null);
    expect(failure.title).toBe('Sentinel is not running on this board');
    expect(failure.hint).toMatch(/sima-cli neat install sentinel/);

    const stopped = daemonView(captured('daemon_stopped'));
    expect([stopped.state, stopped.label, failureOf(stopped.error, null).title]).toEqual([
      'stopped',
      'Installed but stopped',
      'The Sentinel service is stopped',
    ]);

    const noCli = daemonView(captured('sima_cli_missing_state'));
    expect([noCli.simaCli, noCli.canInstall]).toEqual([null, false]);
    expect(noCli.installBlocked).toMatch(/sima-cli was not found on the board/);

    const healthy = daemonView(sentinelState());
    expect(healthy.canInstall).toBe(false);
    expect(healthy.installBlocked).toMatch(/would restart it and end a trace in flight/);

    expect(daemonView(null).canInstall).toBe(false);
    expect(daemonView(null).installBlocked).toMatch(/state is unknown/);
  });

  it('only a missing daemon is installed from here: a stopped or failing one is a hint', () => {
    const view = (state: SentinelState['status']['state'], extra: Partial<SentinelDaemon>) =>
      daemonView(
        sentinelState({
          available: false,
          daemon: daemon({ healthy: false, ...extra }),
          status: { state, error: null },
        }),
      );
    // #170 offered Install here too (anything not healthy with a sima-cli); the spec does not.
    expect(view('stopped', { installed: true, service: 'inactive' }).canInstall).toBe(false);
    expect(view('error', { installed: true, service: 'active', socket: false }).canInstall).toBe(
      false,
    );
    expect(view('missing', { installed: false, service: 'inactive' }).canInstall).toBe(true);
    expect(view('error', { installed: true }).label).toBe('Not answering');
  });

  it('the empty and refused states Sentinel actually returns are read as such', () => {
    const absent = daemonView(null);
    expect([absent.state, absent.available]).toEqual(['unknown', false]);
    const missing = daemonView(
      sentinelState({
        available: false,
        daemon: daemon({ installed: false, healthy: false, service: 'inactive', socket: false }),
        status: { state: 'missing', error: { ...missingError } },
      }),
    );
    expect([missing.available, missing.canInstall, failureOf(missing.error, null).daemon]).toEqual([
      false,
      true,
      true,
    ]);
  });
});

describe('healthProblems', () => {
  it('health stays readable: collector errors are strings or objects, and nothing else counts', () => {
    const health = (errors: SentinelHealth['errors']): SentinelHealth => ({
      ...(sentinelState().health as SentinelHealth),
      errors,
    });
    expect(
      healthProblems(
        health(['pmbus read failed', { error: 'ev74 busy' }, { message: 'late' }, null, {}]),
      ),
    ).toEqual(['pmbus read failed', 'ev74 busy', 'late']);
    expect(healthProblems(health([]))).toEqual([]);
    expect(healthProblems(null)).toEqual([]);
  });
});
