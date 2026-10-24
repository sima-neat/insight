import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import { Observable, Subject } from 'rxjs';
import type { AssignRequest, Slot, StartRequest, SuccessResponse } from '../../sources/api';
import { CamerasService } from '../../sources/cameras.service';
import { SlotsService } from '../../sources/slots.service';
import { ApiRequestError, type StreamEvent } from '../../sources/stream-lines';
import { SlotControl } from './slot-control';

function slot(index: number, overrides: Partial<Slot> = {}): Slot {
  return {
    index,
    file: 'a.mp4',
    state: 'stopped',
    transport: 'rtsp',
    codec: 'h264',
    type: 'file',
    allowed_transports: ['rtsp'],
    urls: {},
    fps: null,
    native_fps: 30,
    ...overrides,
  };
}

/** Resolves or rejects when the test says. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (failure: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (failure: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const OK: SuccessResponse = { success: true };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

class FakeSlots {
  readonly slots = signal<readonly Slot[] | null>([slot(2)]);
  /** The prepare runs the test drives: one subject per subscribe, and whether it was cancelled. */
  readonly prepares: { lines: Subject<StreamEvent>; cancelled: boolean }[] = [];
  readonly assign = vi.fn<(request: AssignRequest) => Promise<SuccessResponse>>(async () => OK);
  readonly start = vi.fn<(request: StartRequest) => Promise<SuccessResponse>>(async () => OK);
  readonly startAfterPrepare = vi.fn<(index: number) => Promise<SuccessResponse>>(async () => OK);
  readonly prepare = vi.fn(
    (index: number) =>
      new Observable<StreamEvent>((subscriber) => {
        void index;
        const run = { lines: new Subject<StreamEvent>(), cancelled: false };
        this.prepares.push(run);
        let ended = false;
        const subscription = run.lines.subscribe({
          next: (event) => subscriber.next(event),
          error: (failure: unknown) => {
            ended = true;
            subscriber.error(failure);
          },
          complete: () => {
            ended = true;
            subscriber.complete();
          },
        });
        return () => {
          if (!ended) run.cancelled = true;
          subscription.unsubscribe();
        };
      }),
  );
}

describe('SlotControl', () => {
  let slots: FakeSlots;
  let cameras: { publish: ReturnType<typeof vi.fn> };
  let toasts: { error: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
  let control: SlotControl;

  beforeEach(() => {
    slots = new FakeSlots();
    cameras = { publish: vi.fn(async () => undefined) };
    toasts = { error: vi.fn(), status: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: SlotsService, useValue: slots },
        { provide: CamerasService, useValue: cameras },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
    control = TestBed.inject(SlotControl);
  });

  /** The encode the slot's start began, with the server's lines fed in and the stream ended. */
  function finishPrepare(...lines: string[]): void {
    const run = slots.prepares.at(-1)!;
    for (const text of lines) run.lines.next({ kind: 'line', text });
    run.lines.next({ kind: 'done' });
    run.lines.complete();
  }

  it('commits a frame rate with the file and transport the slot has (#170)', async () => {
    await expect(control.commitFps(slot(2), 15)).resolves.toEqual({ ok: true, fps: 15 });
    expect(slots.assign).toHaveBeenCalledWith({
      index: 2,
      file: 'a.mp4',
      transport: 'rtsp',
      fps: 15,
    });
    await control.commitFps(slot(2, { transport: '' }), null);
    expect(slots.assign).toHaveBeenLastCalledWith({
      index: 2,
      file: 'a.mp4',
      transport: 'rtsp',
      fps: null,
    });
  });

  it('a start at the native rate starts the slot without preparing a rendition', async () => {
    await expect(control.start(2)).resolves.toBe('started');
    expect(slots.start).toHaveBeenCalledWith({ index: 2 });
    expect(slots.prepare).not.toHaveBeenCalled();
  });

  it('a start waits for the slot’s pending frame-rate commit, then prepares the committed rate before starting', async () => {
    const assigned = deferred<SuccessResponse>();
    slots.assign.mockReturnValueOnce(assigned.promise);
    void control.commitFps(slot(2), 15);
    const started = control.start(2);
    await flush();
    // Nothing is sent before the commit has landed: the server would start the old rate.
    expect(slots.prepare).not.toHaveBeenCalled();
    expect(slots.start).not.toHaveBeenCalled();
    expect(control.busy().has(2)).toBe(true);

    assigned.resolve(OK);
    await flush();
    expect(slots.prepare).toHaveBeenCalledWith(2);
    expect(control.preparing().has(2)).toBe(true);
    finishPrepare('Encoding a.mp4 at 15 fps (libx264)...', 'Rendition ready: .renditions/a.mp4');
    await expect(started).resolves.toBe('started');
    // The start that follows an encode holds the Encoding state until its own refetch.
    expect(slots.startAfterPrepare).toHaveBeenCalledWith(2);
    expect(slots.start).not.toHaveBeenCalled();
    expect(control.preparing().has(2)).toBe(false);
    expect(control.busy().has(2)).toBe(false);
  });

  it('a refused commit is reported once, and the start waiting for it does nothing', async () => {
    slots.assign.mockRejectedValueOnce(
      new ApiRequestError(400, 'No codec level covers 900 fps.', null),
    );
    const committed = control.commitFps(slot(2), 900);
    const started = control.start(2);
    await expect(committed).resolves.toEqual({ ok: false });
    await expect(started).resolves.toBe('skipped');
    expect(toasts.error).toHaveBeenCalledExactlyOnceWith('No codec level covers 900 fps.');
    expect(slots.start).not.toHaveBeenCalled();
    expect(slots.prepare).not.toHaveBeenCalled();
  });

  it('an encode that fails rejects with #170’s message, and the slot is not started', async () => {
    slots.slots.set([slot(2, { fps: 15 })]);
    const started = control.start(2);
    await flush();
    finishPrepare('Encoding a.mp4 at 15 fps (libx264)...', 'Error: disk full');
    await expect(started).rejects.toThrow(
      'Encoding src2 at 15 fps failed. Partial output was removed; the source file is unchanged. disk full',
    );
    expect(slots.startAfterPrepare).not.toHaveBeenCalled();
    expect(control.busy().has(2)).toBe(false);
  });

  it('a refused prepare rejects with the server message', async () => {
    slots.slots.set([slot(2, { fps: 15 })]);
    const started = control.start(2);
    await flush();
    slots.prepares[0].lines.error(
      new ApiRequestError(409, 'src2 is pulling a network stream.', null),
    );
    await expect(started).rejects.toThrow('src2 is pulling a network stream.');
    expect(control.preparing().has(2)).toBe(false);
  });

  it('Cancel encoding stops the encode, and the start ends as cancelled without starting', async () => {
    slots.slots.set([slot(2, { fps: 15 })]);
    const started = control.start(2);
    await flush();
    expect(control.preparing().has(2)).toBe(true);

    control.cancelEncoding(2);
    expect(slots.prepares[0].cancelled).toBe(true);
    await expect(started).resolves.toBe('cancelled');
    expect(slots.startAfterPrepare).not.toHaveBeenCalled();
    expect(control.preparing().has(2)).toBe(false);
    expect(control.busy().has(2)).toBe(false);
    // Nothing to cancel any more.
    control.cancelEncoding(2);
  });

  it('a webcam slot is started by publishing its camera', async () => {
    slots.slots.set([slot(3, { type: 'webcam', file: '' })]);
    await expect(control.start(3)).resolves.toBe('started');
    expect(cameras.publish).toHaveBeenCalledWith(3);
    expect(slots.start).not.toHaveBeenCalled();
  });

  it('commitsSettled waits for every pending commit, and says whether all of them landed', async () => {
    await expect(control.commitsSettled()).resolves.toBe(true);

    const first = deferred<SuccessResponse>();
    const second = deferred<SuccessResponse>();
    slots.assign.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    void control.commitFps(slot(2), 15);
    void control.commitFps(slot(7), 20);
    let settled: boolean | undefined;
    void control.commitsSettled().then((result) => (settled = result));
    first.resolve(OK);
    await flush();
    expect(settled).toBeUndefined();
    second.reject(new ApiRequestError(409, 'src7 changed.', null));
    await flush();
    expect(settled).toBe(false);
    // Settled commits are forgotten.
    await expect(control.commitsSettled()).resolves.toBe(true);
  });

  it('run marks the slot busy while the work is in flight, whatever its outcome', async () => {
    const work = deferred<void>();
    const running = control.run(4, () => work.promise);
    expect(control.busy().has(4)).toBe(true);
    work.reject(new Error('refused'));
    await expect(running).rejects.toThrow('refused');
    expect(control.busy().has(4)).toBe(false);
  });

  it('run waits for a frame-rate commit on its way to the slot, so the two never race', async () => {
    const assigned = deferred<SuccessResponse>();
    slots.assign.mockReturnValueOnce(assigned.promise);
    void control.commitFps(slot(2), 15);
    const work = vi.fn(async () => 'done');
    const running = control.run(2, work);
    await flush();
    expect(work).not.toHaveBeenCalled();
    expect(control.busy().has(2)).toBe(true);
    assigned.resolve(OK);
    await expect(running).resolves.toBe('done');
    // Another slot's work does not wait for it.
    void control.commitFps(slot(2), 20);
    await expect(control.run(7, async () => 'other')).resolves.toBe('other');
  });
});
