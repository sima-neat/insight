import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { Slot } from '../../api.generated';
import { CamerasService } from '../../sources/cameras.service';
import { SlotsService } from '../../sources/slots.service';
import { fileSlot, webcamSlot } from '../../sources/slots.testing';
import { ApiRequestError } from '../../sources/api-errors';
import { SlotControl } from './slot-control';

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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

class FakeSlots {
  readonly slots = signal<readonly Slot[] | null>([fileSlot(2, 'a.mp4')]);
  readonly assignFile = vi.fn<(n: number, file: string, fps?: number | null) => Promise<Slot>>(
    async (n, file) => fileSlot(n, file),
  );
  readonly start = vi.fn<(n: number) => Promise<Slot>>(async (n) =>
    fileSlot(n, 'a.mp4', { run: true, state: 'starting' }),
  );
  readonly stop = vi.fn<(n: number) => Promise<Slot>>(async (n) => fileSlot(n, 'a.mp4'));
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

  it('commits a frame rate with the file the slot has; none is the file’s own', async () => {
    await expect(control.commitFps(fileSlot(2, 'a.mp4'), 15)).resolves.toEqual({ ok: true });
    expect(slots.assignFile).toHaveBeenCalledWith(2, 'a.mp4', 15);
    await control.commitFps(fileSlot(2, 'a.mp4', { fps: 15 }), null);
    expect(slots.assignFile).toHaveBeenLastCalledWith(2, 'a.mp4', null);
  });

  it('a file slot is started by the server, which encodes a rendition first when it needs one', async () => {
    await expect(control.start(2)).resolves.toBe('started');
    expect(slots.start).toHaveBeenCalledWith(2);
    expect(cameras.publish).not.toHaveBeenCalled();
  });

  it('a start waits for the slot’s pending frame-rate commit, so the server starts the committed rate', async () => {
    const assigned = deferred<Slot>();
    slots.assignFile.mockReturnValueOnce(assigned.promise);
    void control.commitFps(fileSlot(2, 'a.mp4'), 15);
    const started = control.start(2);
    await flush();
    // Nothing is sent before the commit has landed: the server would start the old rate.
    expect(slots.start).not.toHaveBeenCalled();
    expect(control.busy().has(2)).toBe(true);

    assigned.resolve(fileSlot(2, 'a.mp4', { fps: 15 }));
    await expect(started).resolves.toBe('started');
    expect(slots.start).toHaveBeenCalledWith(2);
    expect(control.busy().has(2)).toBe(false);
  });

  it('a refused commit is reported once, and the start waiting for it does nothing', async () => {
    slots.assignFile.mockRejectedValueOnce(
      new ApiRequestError(400, 'No codec level covers 900 fps.', null),
    );
    const committed = control.commitFps(fileSlot(2, 'a.mp4'), 900);
    const started = control.start(2);
    await expect(committed).resolves.toEqual({ ok: false });
    await expect(started).resolves.toBe('skipped');
    expect(toasts.error).toHaveBeenCalledExactlyOnceWith('No codec level covers 900 fps.');
    expect(slots.start).not.toHaveBeenCalled();
  });

  it('a refused start rejects with the server message', async () => {
    slots.start.mockRejectedValueOnce(new ApiRequestError(409, 'src2 has nothing assigned.', null));
    await expect(control.start(2)).rejects.toThrow('src2 has nothing assigned.');
    expect(control.busy().has(2)).toBe(false);
  });

  it('Cancel encoding stops the slot, which cancels its encode, with the slot busy meanwhile', async () => {
    const stopped = deferred<Slot>();
    slots.stop.mockReturnValueOnce(stopped.promise);
    const cancelling = control.cancelEncoding(2);
    await flush();
    expect(slots.stop).toHaveBeenCalledWith(2);
    expect(control.busy().has(2)).toBe(true);

    stopped.resolve(fileSlot(2, 'a.mp4'));
    await cancelling;
    expect(control.busy().has(2)).toBe(false);
  });

  it('a webcam slot is started by publishing its camera', async () => {
    slots.slots.set([webcamSlot(3)]);
    await expect(control.start(3)).resolves.toBe('started');
    expect(cameras.publish).toHaveBeenCalledWith(3);
    expect(slots.start).not.toHaveBeenCalled();
  });

  it('starting marks the slot from the click until its start settles, whatever the outcome', async () => {
    expect(control.starting().has(2)).toBe(false);

    const accepted = deferred<Slot>();
    slots.start.mockReturnValueOnce(accepted.promise);
    const started = control.start(2);
    await flush();
    expect(control.starting().has(2)).toBe(true);
    // Only the slot being started.
    expect(control.starting().has(7)).toBe(false);
    accepted.resolve(fileSlot(2, 'a.mp4', { run: true, state: 'starting' }));
    await expect(started).resolves.toBe('started');
    expect(control.starting().has(2)).toBe(false);

    const refused = deferred<Slot>();
    slots.start.mockReturnValueOnce(refused.promise);
    const failed = control.start(2);
    await flush();
    expect(control.starting().has(2)).toBe(true);
    refused.reject(new ApiRequestError(409, 'src2 changed.', null));
    await expect(failed).rejects.toThrow('src2 changed.');
    expect(control.starting().has(2)).toBe(false);
  });

  it('a start is starting while it waits for a rate commit, and while a webcam publishes', async () => {
    const assigned = deferred<Slot>();
    slots.assignFile.mockReturnValueOnce(assigned.promise);
    void control.commitFps(fileSlot(2, 'a.mp4'), 30);
    const started = control.start(2);
    await flush();
    expect(control.starting().has(2)).toBe(true);
    assigned.resolve(fileSlot(2, 'a.mp4'));
    await started;
    expect(control.starting().has(2)).toBe(false);

    slots.slots.set([webcamSlot(3)]);
    const publishing = deferred<undefined>();
    cameras.publish.mockReturnValueOnce(publishing.promise);
    const published = control.start(3);
    await flush();
    expect(control.starting().has(3)).toBe(true);
    publishing.resolve(undefined);
    await published;
    expect(control.starting().has(3)).toBe(false);
  });

  it('commitsSettled waits for every pending commit, and says whether all of them landed', async () => {
    await expect(control.commitsSettled()).resolves.toBe(true);

    const first = deferred<Slot>();
    const second = deferred<Slot>();
    slots.assignFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    void control.commitFps(fileSlot(2, 'a.mp4'), 15);
    void control.commitFps(fileSlot(7, 'b.mp4'), 20);
    let settled: boolean | undefined;
    void control.commitsSettled().then((result) => (settled = result));
    first.resolve(fileSlot(2, 'a.mp4', { fps: 15 }));
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
    const assigned = deferred<Slot>();
    slots.assignFile.mockReturnValueOnce(assigned.promise);
    void control.commitFps(fileSlot(2, 'a.mp4'), 15);
    const work = vi.fn(async () => 'done');
    const running = control.run(2, work);
    await flush();
    expect(work).not.toHaveBeenCalled();
    expect(control.busy().has(2)).toBe(true);
    assigned.resolve(fileSlot(2, 'a.mp4', { fps: 15 }));
    await expect(running).resolves.toBe('done');
    // Another slot's work does not wait for it.
    void control.commitFps(fileSlot(2, 'a.mp4'), 20);
    await expect(control.run(7, async () => 'other')).resolves.toBe('other');
  });
});
