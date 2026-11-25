import { inject, Injectable, InjectionToken } from '@angular/core';
import { concat, Observable, of } from 'rxjs';
import type { Job } from '../api.generated';

/**
 * The server's jobs (`/api/jobs`): long work with progress, such as a rendition's encode, an
 * upload's re-encode or a catalog import. A route that starts one answers with the job; its
 * changes then come as Server-Sent Events, one `data:` line of the job's JSON at once and after
 * each change, the last one its final state.
 */

/**
 * The part of a browser `EventSource` a job's events need, so a test can stand in for it. Its
 * `readyState` is `EventSource.CLOSED` (2) once the browser has given up on the stream.
 */
export type JobEventSource = Pick<EventSource, 'onmessage' | 'onerror' | 'readyState' | 'close'>;

/** Opens an event stream; the browser's `EventSource` unless a test provides another. */
export const EVENT_SOURCE = new InjectionToken<(url: string) => JobEventSource>('EVENT_SOURCE', {
  providedIn: 'root',
  factory: () => (url) => new EventSource(url),
});

/** `EventSource.CLOSED`, named here because a test's stand-in has no such constant. */
const CLOSED = 2;

/** What a follow fails with when the browser gives up on the stream before the job ended. */
const LOST = "The job's progress could not be followed.";

/** Whether the job is over: done, failed or cancelled. Its events end there. */
export function isFinal(job: Job): boolean {
  return job.state === 'done' || job.state === 'failed' || job.state === 'cancelled';
}

/** A job that ended without its result: failed (with the server's sentence) or cancelled. */
export class JobFailedError extends Error {
  constructor(readonly job: Job) {
    super(
      job.error ||
        (job.state === 'cancelled' ? `${job.title}: cancelled.` : `${job.title} failed.`),
    );
    this.name = 'JobFailedError';
  }
}

/** How far a piece of work is, as the app shows it: a job (`jobProgress`), an upload's bytes. */
export interface Progress {
  title: string;
  detail: string;
  /** 0..100, or null while the length of the work is unknown. */
  percent: number | null;
}

/**
 * The job's progress as the app shows it: the detail the server gives (an encode's time reached,
 * "00:25 / 01:00", or a download's megabytes) under `title`, and its percent in whole numbers.
 * A queued job waits for another of its kind to finish.
 */
export function jobProgress(job: Job, title: string): Progress {
  const percent = job.progress.percent;
  return {
    title,
    detail: job.state === 'queued' ? 'Queued' : job.progress.detail,
    percent: percent === undefined ? null : Math.floor(percent),
  };
}

/**
 * Follows jobs over their event streams. The browser's `EventSource` reconnects by itself when a
 * stream drops, and would be sent the final state again after a stream that ended, so a follow
 * closes its stream on the final state, and when it is unsubscribed.
 */
@Injectable({ providedIn: 'root' })
export class JobEvents {
  private readonly open = inject(EVENT_SOURCE);

  /**
   * The job as it changes, from the stream's first event; completes after its final state. Errors
   * when the browser gives up on the stream (the job is unknown, or no longer kept), not while it
   * reconnects after a drop. Cold: each subscription opens its own stream.
   */
  follow(id: string): Observable<Job> {
    return new Observable<Job>((subscriber) => {
      const source = this.open(`/api/jobs/${encodeURIComponent(id)}/events`);
      source.onmessage = (event) => {
        let job: Job;
        try {
          job = JSON.parse(event.data) as Job;
        } catch {
          source.close();
          subscriber.error(new Error(LOST));
          return;
        }
        subscriber.next(job);
        if (isFinal(job)) {
          source.close();
          subscriber.complete();
        }
      };
      source.onerror = () => {
        if (source.readyState === CLOSED) subscriber.error(new Error(LOST));
      };
      return () => source.close();
    });
  }

  /** A job as an answer carried it, then its changes while it is not over. */
  updates(job: Job): Observable<Job> {
    return isFinal(job) ? of(job) : concat(of(job), this.follow(job.id));
  }
}
