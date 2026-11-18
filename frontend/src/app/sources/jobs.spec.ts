import { TestBed } from '@angular/core/testing';
import type { Job } from '../api.generated';
import { isFinal, JobEvents, JobFailedError, jobProgress } from './jobs';
import { FakeEventSources } from './jobs.testing';
import { job } from './slots.testing';

describe('isFinal', () => {
  it('is true for done, failed and cancelled jobs', () => {
    const states: Job['state'][] = ['queued', 'running', 'done', 'failed', 'cancelled'];
    expect(states.map((state) => isFinal(job({ state })))).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
  });
});

describe('JobFailedError', () => {
  it("says why with the server's sentence, else that the job failed or was cancelled", () => {
    expect(new JobFailedError(job({ state: 'failed', error: 'Disk full.' })).message).toBe(
      'Disk full.',
    );
    expect(new JobFailedError(job({ state: 'failed' })).message).toBe(
      'Encode walk.mp4 at 15 fps failed.',
    );
    expect(new JobFailedError(job({ state: 'cancelled' })).message).toBe(
      'Encode walk.mp4 at 15 fps: cancelled.',
    );
  });
});

describe('jobProgress', () => {
  it("shows the server's detail and whole percents under the caller's title", () => {
    expect(
      jobProgress(
        job({ progress: { phase: 'encode', detail: '00:25 / 01:00', percent: 41.7 } }),
        'T',
      ),
    ).toEqual({ title: 'T', detail: '00:25 / 01:00', percent: 41 });
    expect(jobProgress(job({ progress: { phase: 'encode', detail: 'libx264' } }), 'T')).toEqual({
      title: 'T',
      detail: 'libx264',
      percent: null,
    });
  });

  it('says a queued job waits', () => {
    expect(jobProgress(job({ state: 'queued' }), 'T').detail).toBe('Queued');
  });
});

describe('JobEvents', () => {
  let sources: FakeEventSources;
  let events: JobEvents;

  beforeEach(() => {
    sources = new FakeEventSources();
    TestBed.configureTestingModule({ providers: [sources.provider()] });
    events = TestBed.inject(JobEvents);
  });

  /** Follows a job and records what the follow did. */
  function follow(id: string) {
    const seen: { jobs: Job[]; error: unknown; completed: boolean } = {
      jobs: [],
      error: undefined,
      completed: false,
    };
    const subscription = events.follow(id).subscribe({
      next: (update) => seen.jobs.push(update),
      error: (failure: unknown) => (seen.error = failure),
      complete: () => (seen.completed = true),
    });
    return { seen, subscription };
  }

  it('opens the job’s event stream on subscribe, and emits each state it sends', () => {
    const { seen } = follow('job 1');
    const source = sources.opened[0];
    expect(source.url).toBe('/api/jobs/job%201/events');

    source.send(job({ progress: { phase: 'encode', detail: '00:10 / 01:00', percent: 16 } }));
    source.send(job({ progress: { phase: 'encode', detail: '00:20 / 01:00', percent: 33 } }));

    expect(seen.jobs.map((update) => update.progress.percent)).toEqual([16, 33]);
    expect(seen.completed).toBe(false);
  });

  it('closes the stream and completes on the final state, so the browser does not reconnect', () => {
    const { seen } = follow('job-1');
    const source = sources.opened[0];

    source.send(job({ state: 'done', result: { rendition: '.renditions/a.mp4' } }));

    expect(seen.jobs.map((update) => update.state)).toEqual(['done']);
    expect(seen.completed).toBe(true);
    expect(source.closed).toBe(true);
  });

  it('waits through a drop the browser reconnects after, and fails when it gives up', () => {
    const { seen } = follow('job-1');
    const source = sources.opened[0];

    source.fail({ reconnecting: true });
    expect(seen.error).toBeUndefined();

    source.fail();
    expect(seen.error).toBeInstanceOf(Error);
    expect((seen.error as Error).message).toBe("The job's progress could not be followed.");
  });

  it('closes the stream when unsubscribed', () => {
    const { subscription } = follow('job-1');
    subscription.unsubscribe();
    expect(sources.opened[0].closed).toBe(true);
  });

  it('starts updates with the job an answer carried, and follows it only while it runs', () => {
    const seen: Job[] = [];
    events.updates(job({ state: 'queued' })).subscribe((update) => seen.push(update));
    expect(seen.map((update) => update.state)).toEqual(['queued']);
    sources.of('job-1')!.send(job({ state: 'done' }));
    expect(seen.map((update) => update.state)).toEqual(['queued', 'done']);

    const finished: Job[] = [];
    events
      .updates(job({ id: 'job-2', state: 'done' }))
      .subscribe((update) => finished.push(update));
    expect(finished.map((update) => update.state)).toEqual(['done']);
    expect(sources.of('job-2')).toBeUndefined();
  });
});
