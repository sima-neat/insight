import type { Job } from '../src/app/api.generated';
import { job } from '../src/app/sources/slots.testing';

/** A job as the server reports it: `id`, of `kind`, with the rest from `fields`. */
export const jobOf = (id: string, kind: string, fields: Partial<Job> = {}): Job =>
  job({ id, kind, ...fields });

/**
 * `GET /api/jobs/{id}/events` as the server streams it: one `data:` line of the job per change, the
 * last one its final state (the app closes the stream there). `retry` is how soon, in ms, the
 * browser reconnects when the stream ends before a final state, as a test that finishes the job
 * later needs.
 */
export function jobEvents(jobs: readonly Job[], retry?: number) {
  const lines = jobs.map((state) => `data: ${JSON.stringify(state)}\n\n`).join('');
  return {
    contentType: 'text/event-stream',
    body: `${retry === undefined ? '' : `retry: ${retry}\n\n`}${lines}`,
  };
}
