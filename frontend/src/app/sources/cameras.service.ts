import { computed, DestroyRef, DOCUMENT, inject, Injectable, signal } from '@angular/core';
import { NeatToasts } from '@sima/neat-ui/toast';
import { LatestOnly } from '../polling';
import type { AssignRequest, PublisherRelease, ReleasedWebcam, SuccessResponse } from './api';
import { CAMERA_MEDIA, type PublishPeer } from './camera-media';
import { SlotsService } from './slots.service';
import { ApiRequestError, messageOf } from './stream-lines';
import {
  camerasFromDevices,
  closeAllWebcamSessions,
  closeWebcamSession,
  confirmWebcamPublishing,
  createDisconnectWatcher,
  describeWebcamError,
  isPermissionDenied,
  pinH264,
  publishWebcamOffer,
  recordWebcamStopsOnExit,
  type Camera,
  type DisconnectWatcher,
} from './webcam-publishing';

/**
 * Where the browser's permission to use cameras stands, as far as this tab has found out.
 * `unknown` until `requestAccess()` answers (the camera list can already show cameras by then, as
 * the browser may have remembered a grant), `unsupported` where there is no camera capture at all.
 */
export type CameraAccessState = 'unknown' | 'requesting' | 'granted' | 'denied' | 'unsupported';

const UNSUPPORTED_TEXT = 'This browser cannot access cameras.';
const NO_CAMERA_TEXT = 'Select a webcam for this source before starting it.';
const NO_PUBLISH_URL_TEXT = 'No publish URL for this source; reassign the webcam and try again.';
/** What a slot's camera is called when the camera is gone from the list by the time it is assigned. */
const UNKNOWN_CAMERA_LABEL = 'Webcam';

/** A webcam this tab publishes to a slot: everything that has to be closed to end it. */
interface WebcamSession {
  readonly pc: PublishPeer;
  readonly stream: MediaStream;
  /** MediaMTX's WHIP resource, to delete when the session ends; null if it named none. */
  readonly deleteUrl: string | null;
  /** The `Id` header of the WHIP POST: the session a stop or a release claim names. Null if absent. */
  readonly sessionId: string | null;
  readonly watcher: DisconnectWatcher;
}

/** Thrown inside a start that something else has replaced; the start ends quietly. */
class StartSuperseded extends Error {
  constructor() {
    super('The webcam start was superseded.');
  }
}

/** The claim a stop or a conversion makes that this tab closed the webcam: only for a session it can name. */
function releaseClaim(session: WebcamSession | null | undefined): PublisherRelease {
  return session?.sessionId
    ? { publisher_released: true, publisher_session: session.sessionId }
    : {};
}

/**
 * The cameras this browser has, and the webcams it publishes to streaming slots over WHIP. A root
 * service because a publish lives as long as the app does: leaving the Streaming page must not
 * end a camera that is on air. Sessions end by `release`, `releaseAll`, a lost connection, a
 * removed camera, or the page going away (`pagehide`).
 *
 * **How this tab and Insight agree about a webcam it publishes** (from #170):
 * - Insight never owns the publisher; only this tab can end it. So every path that ends a session
 *   here also records the stop with the server, naming the WHIP session it ended.
 * - A "released" claim is made only for a session this tab held and can name. The server honours
 *   it only for that session, so a stale claim can never mark another browser's camera stopped.
 * - A start spans several awaits (the camera, the offer, the server's confirmation). Each slot has
 *   a generation that everything which changes the slot moves on, and a start checks it after
 *   each await and abandons itself rather than publish a camera the user already replaced.
 * - While a request that changes a slot's webcam is in flight the slot is `changingSlots`: a
 *   second action then would race it. In particular a second stop would find no session left and
 *   send an unbound stop, which the server carries out by kicking whichever publisher holds the
 *   slot, perhaps a replacement another tab just started.
 *
 * **Errors.** An action the user takes rejects with a message to show. A session that ends on its
 * own (a lost connection, a removed camera) has no action to reject, so its failures are an error
 * toast. The slots are fetched again after each change, as `SlotsService` does for its own.
 *
 * The WebRTC and media capture run on the browser's callbacks outside Angular change detection,
 * behind `CAMERA_MEDIA`; the signals below change on those events only.
 */
@Injectable({ providedIn: 'root' })
export class CamerasService {
  private readonly media = inject(CAMERA_MEDIA);
  private readonly slots = inject(SlotsService);
  private readonly toasts = inject(NeatToasts);

  private readonly camerasState = signal<readonly Camera[]>([]);
  /** The cameras the browser lists, each once. Without permission the browser hides their ids, and the list is empty. */
  readonly cameras = this.camerasState.asReadonly();

  private readonly accessState = signal<CameraAccessState>(
    this.media.canCapture ? 'unknown' : 'unsupported',
  );
  readonly state = this.accessState.asReadonly();

  private readonly errorState = signal<string | null>(null);
  /** Why the last `requestAccess()` failed, as a sentence to show; null after a success. */
  readonly error = this.errorState.asReadonly();

  private readonly assignmentsState = signal<ReadonlyMap<number, Camera>>(new Map());
  /**
   * The camera each slot is set to publish (picked with `assign`). Only this tab knows it: after a
   * reload a webcam slot has no camera until one is picked again.
   */
  readonly assignments = this.assignmentsState.asReadonly();

  private readonly streamsState = signal<ReadonlyMap<number, MediaStream>>(new Map());
  /** The local camera stream of each slot this tab publishes, for the slot's preview until it is live. */
  readonly localStreams = this.streamsState.asReadonly();

  /** How many requests that change a slot's webcam are in flight, per slot. */
  private readonly changeCounts = signal<ReadonlyMap<number, number>>(new Map());
  /** Slots with such a request in flight: their controls wait, so a second action cannot race it. */
  readonly changingSlots = computed<ReadonlySet<number>>(() => new Set(this.changeCounts().keys()));
  /**
   * Whether any slot is changing. The bulk actions wait for it: a webcam being assigned or started
   * answers after the bulk action cleared its slot and would register the slot as a webcam again.
   */
  readonly anyChanging = computed(() => this.changeCounts().size > 0);

  private readonly sessions = new Map<number, WebcamSession>();
  private readonly generations = new Map<number, number>();
  private readonly latestListing = new LatestOnly();

  constructor() {
    if (!this.media.canCapture) return;
    const destroyRef = inject(DestroyRef);

    void this.refreshCameras();
    destroyRef.onDestroy(this.media.onDeviceChange(() => void this.refreshCameras()));

    // A reload or close does not run any teardown, and MediaMTX would hold the path another 15-20 s,
    // so record a stop for each owned webcam now. `pagehide` (not `beforeunload`) also fires when
    // the page enters the back-forward cache; skip that, since the page and its sessions may come back.
    const window = inject(DOCUMENT).defaultView;
    if (window) {
      const onPageHide = (event: PageTransitionEvent) => {
        if (event.persisted) return;
        recordWebcamStopsOnExit(this.sessions);
        this.closeAllSessions();
      };
      window.addEventListener('pagehide', onPageHide);
      destroyRef.onDestroy(() => window.removeEventListener('pagehide', onPageHide));
    }
    destroyRef.onDestroy(() => this.closeAllSessions());
  }

  /**
   * Asks the browser for camera access, then lists what it revealed. Call it from a click: a real
   * user gesture is what makes Chrome reveal Continuity Camera (an iPhone), which a background
   * probe does not. Doubles as a re-scan when a camera was plugged in later. Does not reject: the
   * outcome is `state` and `error`.
   */
  async requestAccess(): Promise<void> {
    if (!this.media.canCapture) {
      this.errorState.set(UNSUPPORTED_TEXT);
      return;
    }
    const before = this.accessState();
    if (before === 'requesting') return;

    this.errorState.set(null);
    this.accessState.set('requesting');
    try {
      const probe = await this.media.getUserMedia({ video: true });
      probe.getTracks().forEach((track) => track.stop());
      this.accessState.set('granted');
    } catch (failure) {
      this.errorState.set(describeWebcamError(failure));
      // A refusal is `denied`. Any other failure (no camera, one in use) says nothing new about
      // the permission, so what was known stays, except that a refusal is no longer known to hold.
      this.accessState.set(
        isPermissionDenied(failure) ? 'denied' : before === 'denied' ? 'unknown' : before,
      );
      return;
    }
    // Access is granted whether or not the list can be read; say so when it cannot, as the user
    // has just asked for it and would otherwise see no cameras and no reason.
    try {
      await this.listCameras();
    } catch (failure) {
      this.errorState.set(describeWebcamError(failure));
    }
  }

  /**
   * Registers the slot as a webcam on the server and remembers `deviceId` as its camera; nothing is
   * published until `publish`. With no `deviceId` the slot is a webcam with no camera yet (the
   * source switch's Camera), and any camera it had is forgotten. A session the slot has is ended
   * first (the old track would keep publishing to the same MediaMTX path, and the new one would be
   * refused), and the server is told by the release claim. Rejects with the server's message,
   * leaving the slot with no camera.
   */
  assign(slot: number, deviceId: string | null): Promise<void> {
    const camera: Camera | null =
      deviceId === null
        ? null
        : {
            deviceId,
            label:
              this.cameras().find((c) => c.deviceId === deviceId)?.label ?? UNKNOWN_CAMERA_LABEL,
          };
    const claim = releaseClaim(this.sessions.get(slot));
    return this.whileChanging(slot, async () => {
      // The slot is invalidated by this, so the generation is the one this assignment belongs to;
      // if it has moved by the time the server answers, a stop or bulk action got there first.
      this.teardown(slot);
      const generation = this.generations.get(slot);
      try {
        await this.slots.assignWebcam({ index: slot, ...claim });
        if (this.generations.get(slot) === generation) this.setCamera(slot, camera);
      } catch (failure) {
        // The camera we closed above is not coming back, and the server's slot may or may not
        // have changed (a 409 from another tab, a 502 from MediaMTX): show no camera rather than
        // one that was never confirmed; the slots' refetch shows what the server holds.
        if (this.generations.get(slot) === generation) this.setCamera(slot, null);
        throw failure;
      }
    });
  }

  /**
   * Assigns a file (or `file: ''` to clear) to a slot that may be one of this tab's webcams. Use
   * this rather than `SlotsService.assign` for any slot that can be a webcam: it ends the slot's
   * session and forgets its camera first, and passes the release claim that lets the server
   * convert the slot without waiting for MediaMTX to confirm the publisher gone.
   */
  assignFile(request: Omit<AssignRequest, keyof PublisherRelease>): Promise<SuccessResponse> {
    const slot = request.index;
    const claim = releaseClaim(this.sessions.get(slot));
    return this.whileChanging(slot, () => {
      this.teardown(slot);
      this.setCamera(slot, null);
      return this.slots.assign({ ...request, ...claim });
    });
  }

  /**
   * Publishes the slot's camera (picked with `assign`) over WHIP and resolves once the server
   * reports the slot live. Resolves quietly when something else took the slot meanwhile (a stop, a
   * new assignment, a bulk action): that is the user changing their mind. Otherwise rejects with a
   * message to show, after releasing the camera and the MediaMTX path it had opened.
   */
  async publish(slot: number): Promise<void> {
    const camera = this.assignments().get(slot);
    if (!camera) throw new Error(NO_CAMERA_TEXT);
    const whipUrl = this.slots.slots()?.find((s) => s.index === slot)?.urls.whip;
    if (!whipUrl) throw new Error(NO_PUBLISH_URL_TEXT);

    await this.whileChanging(slot, () => this.start(slot, camera, whipUrl));
  }

  /**
   * Ends the slot's session and stops the slot on the server, naming the session so a slot another
   * browser has taken is left alone. A slot this tab has no session for gets a plain stop, which
   * the server carries out by kicking the publisher once MediaMTX confirms it. The camera is
   * assigned still. Rejects with the server's message; this tab's session is over either way.
   */
  async release(slot: number): Promise<void> {
    await this.stopBound(slot, this.sessions.get(slot) ?? null);
  }

  /**
   * Ends every session at once, ahead of a bulk action that stops or rewrites the slots: only this
   * browser can end a webcam publish, so a bulk action that skipped this would leave cameras
   * publishing while the UI said everything stopped. Returns the sessions it closed, to pass as the
   * bulk request's `released_webcams` so the server verifies them instead of kicking.
   *
   * `clearAssignments` also forgets every slot's camera: for an action (reset, auto assign) that
   * turns the slots back into file slots. Stop all keeps them.
   */
  releaseAll({
    clearAssignments = false,
  }: { clearAssignments?: boolean } = {}): readonly ReleasedWebcam[] {
    const claims = [...this.sessions].flatMap(([index, session]) =>
      session.sessionId ? [{ index, session: session.sessionId }] : [],
    );
    // A start that has not finished owns no session yet, so closing the registry alone would let
    // it complete after the bulk action and publish a camera the user just stopped. Invalidate
    // every slot that has ever started one: a stale generation is harmless, a missed one is not.
    for (const slot of this.generations.keys()) this.invalidate(slot);
    this.closeAllSessions();
    if (clearAssignments) this.assignmentsState.set(new Map());
    return claims;
  }

  private async start(slot: number, camera: Camera, whipUrl: string): Promise<void> {
    // A session the slot still has is replaced, not leaked, and anything still starting is
    // abandoned: this start is the slot's from here on.
    this.teardown(slot);
    const generation = this.generations.get(slot);
    const superseded = () => this.generations.get(slot) !== generation;
    /** What the start has built so far, for the catch to release. */
    const built: {
      stream?: MediaStream;
      peer?: PublishPeer;
      watcher?: DisconnectWatcher;
      session?: WebcamSession;
      /** Whether `session` is in the registry: only a start that is still current registers. */
      registered?: boolean;
    } = {};

    try {
      // Video only: the ticket's initial scope.
      const stream = await this.media.getUserMedia({
        video: { deviceId: { exact: camera.deviceId } },
      });
      built.stream = stream;
      if (superseded()) throw new StartSuperseded();

      const peer = this.media.createPeer();
      built.peer = peer;
      const sender = peer.addTrack(stream.getVideoTracks()[0], stream);
      // Refuse rather than silently publish VP8 while the slot advertises H.264.
      pinH264(
        peer.getTransceivers().find((transceiver) => transceiver.sender === sender),
        this.media.videoCapabilities(),
      );
      const watcher = createDisconnectWatcher({
        onLost: () => {
          // A slot this tab no longer holds is not ours to stop. Otherwise stop it the same
          // session-bound, held way a click does, naming the session that was lost.
          const lost = this.sessions.get(slot);
          if (lost) this.inBackground(this.stopBound(slot, lost));
        },
      });
      built.watcher = watcher;
      peer.addEventListener('connectionstatechange', () => watcher.update(peer.connectionState));

      const { answerSdp, deleteUrl, sessionId } = await publishWebcamOffer(peer, whipUrl);
      // MediaMTX holds a session for this path from the POST onward, so the session is built the
      // moment the POST returns, before the supersession check and before the answer is applied.
      // Either failure then reaches the catch with the delete URL in hand and releases the path,
      // instead of leaving the resource occupying it until MediaMTX times it out. It enters the
      // registry only while this start is current: a superseded start that wrote its session
      // would replace the newer start's, which would then be in no registry and could not be
      // closed.
      const session: WebcamSession = { pc: peer, stream, deleteUrl, sessionId, watcher };
      built.session = session;
      if (superseded()) throw new StartSuperseded();
      this.sessions.set(slot, session);
      built.registered = true;
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (superseded()) throw new StartSuperseded();
      this.setStream(slot, stream);

      // The server records the slot as playing only once MediaMTX sees the path, which lags the
      // WHIP exchange by the ICE handshake. The slot can still be reassigned during that wait, so
      // check on every attempt: starting a slot that is now a file source would leave that file
      // unexpectedly playing.
      await confirmWebcamPublishing(
        async () => {
          if (superseded()) throw new StartSuperseded();
          // `expect_type`: if another tab turned this slot into a file between polls, the server
          // answers 410 (terminal below) instead of starting that file. `superseded()` only
          // catches changes this tab made; another tab's does not move this generation.
          return this.slots.confirmWebcamStart(slot);
        },
        // Stop retrying on outcomes that will not change within the window:
        // - 410: another tab made the slot a file source; it can never become ours.
        // - 502: MediaMTX's control API is unreachable; every /start blocks about a second on the
        //   dead API, so retrying just hammers a server already known to be down.
        {
          isTerminal: (error) =>
            error instanceof StartSuperseded ||
            (error instanceof ApiRequestError && (error.status === 410 || error.status === 502)),
        },
      );
      // The loop does not settle per attempt (that would delay each 250 ms step by two refetches);
      // the server now says playing, so fetch the slots once.
      await this.slots.settleChange();
    } catch (failure) {
      if (!built.registered) {
        // Failed or abandoned before the session was registered, with the camera open, the
        // connection built or the offer accepted, say: nothing tracks them, so release them here.
        built.watcher?.cancel();
        closeWebcamSession({
          stream: built.stream ?? null,
          pc: built.peer ?? null,
          deleteUrl: built.session?.deleteUrl ?? null,
        });
      } else if (this.sessions.get(slot) === built.session) {
        this.teardown(slot);
      }
      // Otherwise whatever replaced the session closed it already.
      await this.slots.settleChange();
      // A superseded start is the user changing their mind, not a failure.
      if (failure instanceof StartSuperseded) return;
      throw new Error(describeWebcamError(failure), { cause: failure });
    }
  }

  /**
   * The one safe way to stop a webcam this tab owns, shared by a click, a lost connection and a
   * removed camera. The slot stays `changing` for the whole request so that a second stop cannot
   * fire after the session is gone (see the class comment). `session` is captured by the caller
   * before the teardown so the stop names the session it is about; null releases nothing.
   */
  private stopBound(slot: number, session: WebcamSession | null): Promise<SuccessResponse> {
    return this.whileChanging(slot, () => {
      this.teardown(slot);
      return this.slots.stop({ index: slot, ...releaseClaim(session) });
    });
  }

  /** Lists the cameras on a `devicechange` or at start, where a failure leaves the list as it was. */
  private async refreshCameras(): Promise<void> {
    await this.listCameras().catch(() => undefined);
  }

  /**
   * Lists the cameras, and abandons the slots whose camera has gone. Rejects when the browser
   * cannot list devices.
   */
  private async listCameras(): Promise<void> {
    const request = this.latestListing.next();
    const devices = await this.media.enumerateDevices();
    if (!this.latestListing.accept(request)) return;
    const cameras = camerasFromDevices(devices);
    this.camerasState.set(cameras);

    const available = new Set(cameras.map((camera) => camera.deviceId));
    for (const [slot, camera] of this.assignments()) {
      if (available.has(camera.deviceId)) continue;
      // A choice this tab never published is only a local one: there is nothing to stop, and the
      // slot may well be another browser's. A published one is stopped like a lost connection.
      // A start still in flight is abandoned either way: it would publish a camera that is gone.
      const session = this.sessions.get(slot);
      this.invalidate(slot);
      this.setCamera(slot, null);
      if (session) this.inBackground(this.stopBound(slot, session));
    }
  }

  /** Ends the slot's session, if any, and invalidates anything still starting. Sends nothing to the server. */
  private teardown(slot: number): void {
    this.invalidate(slot);
    const session = this.sessions.get(slot);
    if (!session) return;
    this.sessions.delete(slot);
    session.watcher.cancel();
    closeWebcamSession(session);
    this.setStream(slot, null);
  }

  private closeAllSessions(): void {
    for (const session of this.sessions.values()) session.watcher.cancel();
    closeAllWebcamSessions(this.sessions);
    this.streamsState.set(new Map());
  }

  private invalidate(slot: number): number {
    const next = (this.generations.get(slot) ?? 0) + 1;
    this.generations.set(slot, next);
    return next;
  }

  private async whileChanging<T>(slot: number, work: () => Promise<T>): Promise<T> {
    this.adjustChanging(slot, 1);
    try {
      return await work();
    } finally {
      this.adjustChanging(slot, -1);
    }
  }

  private adjustChanging(slot: number, by: 1 | -1): void {
    this.changeCounts.update((counts) => {
      const next = new Map(counts);
      const count = (counts.get(slot) ?? 0) + by;
      if (count > 0) next.set(slot, count);
      else next.delete(slot);
      return next;
    });
  }

  private setCamera(slot: number, camera: Camera | null): void {
    this.assignmentsState.update((all) => {
      if (camera === null && !all.has(slot)) return all;
      const next = new Map(all);
      if (camera) next.set(slot, camera);
      else next.delete(slot);
      return next;
    });
  }

  private setStream(slot: number, stream: MediaStream | null): void {
    this.streamsState.update((all) => {
      if (stream === null && !all.has(slot)) return all;
      const next = new Map(all);
      if (stream) next.set(slot, stream);
      else next.delete(slot);
      return next;
    });
  }

  /** For a failure nobody is waiting on: the user still has to hear of it. */
  private inBackground(work: Promise<unknown>): void {
    work.catch((failure: unknown) => this.toasts.error(messageOf(failure)));
  }
}
