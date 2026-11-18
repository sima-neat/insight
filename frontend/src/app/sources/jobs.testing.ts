import type { Provider } from '@angular/core';
import type { Job } from '../api.generated';
import { EVENT_SOURCE, type JobEventSource } from './jobs';

/** A job's event stream, driven by the test: it sends the job's states and says when it fails. */
export class FakeEventSource implements JobEventSource {
  onmessage: JobEventSource['onmessage'] = null;
  onerror: JobEventSource['onerror'] = null;
  /** `EventSource.OPEN`; `CLOSED` (2) once closed or given up. */
  readyState = 1;

  constructor(readonly url: string) {}

  get closed(): boolean {
    return this.readyState === 2;
  }

  close(): void {
    this.readyState = 2;
  }

  /** The server sends the job as it stands now. */
  send(job: Job): void {
    this.onmessage?.call(
      this as unknown as EventSource,
      new MessageEvent('message', { data: JSON.stringify(job) }),
    );
  }

  /**
   * The stream fails: a drop the browser reconnects after (`reconnecting`), or one it gives up on,
   * as for a job the server does not know.
   */
  fail({ reconnecting = false }: { reconnecting?: boolean } = {}): void {
    this.readyState = reconnecting ? 0 : 2;
    this.onerror?.call(this as unknown as EventSource, new Event('error'));
  }
}

/** Every event stream the code under test opened, in order. */
export class FakeEventSources {
  readonly opened: FakeEventSource[] = [];

  /** The stream of a job, the last one opened for it. */
  of(id: string): FakeEventSource | undefined {
    return this.opened.filter((source) => source.url === `/api/jobs/${id}/events`).pop();
  }

  provider(): Provider {
    return {
      provide: EVENT_SOURCE,
      useValue: (url: string) => {
        const source = new FakeEventSource(url);
        this.opened.push(source);
        return source;
      },
    };
  }
}
