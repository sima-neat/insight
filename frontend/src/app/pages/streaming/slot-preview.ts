import {
  HttpClient,
  HttpErrorResponse,
  HttpEventType,
  type HttpHeaderResponse,
  type HttpResponse,
} from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NeatButton, NeatLiveDot } from '@sima/neat-ui';
import { NeatProgress } from '@sima/neat-ui/progress';
import {
  catchError,
  filter,
  map,
  type Observable,
  of,
  type Subscription,
  take,
  timeout,
  timer,
} from 'rxjs';
import type { Slot } from '../../api.generated';
import { EndsStream, filePreview, PreviewFrame } from '../../sources/preview-frame';
import { isLive, previewSrc } from '../../sources/slot-row';

/** How often the live image is checked for its first frame. */
const FRAME_CHECK_MS = 100;
/** How long the check of a failed preview waits for the server before calling it unavailable. */
const PROBE_TIMEOUT_MS = 3000;

/**
 * How many times a preview that failed is retried by itself, and the pause before each. A stream
 * asked for the moment its slot went live often is not ready yet and a second try works; one that
 * is really broken must not be asked for forever, so after the last try the user is offered Retry
 * as for any failure. A restarted stream or the user's Retry starts the count again, and so does
 * an image that has stayed up for `PREVIEW_STABLE_MS`: a stream that shows one frame and drops,
 * over and over, is as broken as one that never shows any, so a frame alone gives nothing back.
 */
export const PREVIEW_RETRIES = 3;
export const PREVIEW_RETRY_MS = 1000;
/** How long an image must stay up after its first frame to count as a stream that works. */
export const PREVIEW_STABLE_MS = 5000;

/** The badge ids of the previews on the page, so each frame's description names its own. */
let badgeIds = 0;

/** Why the live preview failed: the server's cap on previews open at once (429), or anything else. */
export type PreviewFailure = 'busy' | 'failed';

/**
 * Calls `onFrame` once the image shows its first frame, checking every 100 ms; returns the stop.
 * A multipart MJPEG `<img>` fires `load` unreliably (Chrome only once the stream ends), so the
 * frame is noticed by the image gaining a width. The checks are a plain timer: the app has
 * no zone, so they cause no change detection; only `onFrame` changes what is shown.
 */
export function watchFirstFrame(
  image: () => HTMLImageElement | undefined,
  onFrame: () => void,
): () => void {
  const timer = setInterval(() => {
    if ((image()?.naturalWidth ?? 0) > 0) {
      clearInterval(timer);
      onFrame();
    }
  }, FRAME_CHECK_MS);
  return () => clearInterval(timer);
}

/**
 * Why a new preview image failed to load, which the image cannot say: the same URL is asked again
 * and only the status is read. The preview route checks its cap before it starts FFmpeg, so a 429
 * answers at once. With the XHR backend the status of a stream that answers this time arrives with
 * its first bytes, so that request does start a preview session, which ends as soon as the status
 * is read. A server that does not answer within 3 s counts as unavailable.
 */
export function previewFailure(http: HttpClient, url: string): Observable<PreviewFailure> {
  const failureOf = (status: number): PreviewFailure => (status === 429 ? 'busy' : 'failed');
  return http.get(url, { observe: 'events', reportProgress: true, responseType: 'text' }).pipe(
    filter(
      (event): event is HttpHeaderResponse | HttpResponse<string> =>
        event.type === HttpEventType.ResponseHeader || event.type === HttpEventType.Response,
    ),
    take(1),
    map((event) => failureOf(event.status)),
    timeout(PROBE_TIMEOUT_MS),
    catchError((failure: unknown) =>
      of(failureOf(failure instanceof HttpErrorResponse ? failure.status : 0)),
    ),
  );
}

/**
 * What the selected slot shows: the stream for every kind while it is live,
 * through the server's MJPEG preview route; the file itself, labelled so, for a file slot that is
 * not; and the local camera of a webcam this browser publishes until its stream is live. There is
 * no on/off switch: one preview per panel, so at most one per browser tab.
 *
 * The live image is keyed per slot and attempt: another slot, or Retry, makes a new request. A
 * stream that fails, before its first frame or after some, for a reason other than the cap on
 * previews, is asked for again by itself a few times before it is reported (`PREVIEW_RETRIES`),
 * while "Connecting…" stays up.
 *
 * A badge in the frame's top left says what the picture is: "Live" whenever the slot is live,
 * whatever its source and however its preview is doing
 * (connecting, retrying or failed: the slot is live, and the message says the rest), and otherwise
 * what is shown instead: "File preview", "Camera preview", or "Not live" for a pull that waits or
 * fails. A frame that shows nothing else has none. The badge text is the frame's accessible
 * description, and the badge is hidden from readers so that its text is not read twice.
 */
@Component({
  selector: 'app-slot-preview',
  imports: [EndsStream, NeatButton, NeatLiveDot, NeatProgress, PreviewFrame],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './slot-preview.html',
  styleUrl: './slot-preview.css',
})
export class SlotPreview {
  readonly slot = input.required<Slot>();
  /** The camera this browser publishes to the slot, if it does. */
  readonly localStream = input<MediaStream | null>(null);

  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private probe: Subscription | null = null;
  /** The pause before the next automatic retry, while there is one. */
  private pause: Subscription | null = null;

  private readonly n = computed(() => this.slot().n);
  /**
   * A new one for each stream (set in the constructor, where the stream's key is watched) and for
   * each retry, so a restarted stream never asks for the URL of the one before: the browser might
   * show that one's last image in its place, and the image would count as connected already.
   */
  private readonly token = signal(Date.now());
  /** The publisher's session, which a reconnect between two polls changes. */
  private readonly since = computed(() => this.slot().publisher?.since ?? null);
  protected readonly liveSrc = computed(() =>
    isLive(this.slot()) ? previewSrc(this.n(), this.token(), this.since()) : null,
  );
  /**
   * The live image, one or none, keyed by its URL: rendered with `@for` so a new URL is a new
   * image, which ends the old one's stream. (Tracked by the key rather than by identity, which
   * Angular reports as an accidental re-creation of the whole list.)
   */
  protected readonly liveImages = computed((): readonly { readonly src: string }[] => {
    const src = this.liveSrc();
    return src === null || this.failure() !== null ? [] : [{ src }];
  });
  /** Why the current live image failed, once known; reset by a new image. */
  protected readonly failure = linkedSignal<string | null, PreviewFailure | 'checking' | null>({
    source: this.liveSrc,
    computation: () => null,
  });
  /**
   * Which stream the slot is on: another slot, a stop and a start, or a new publisher session
   * (a camera swap, a pull that reconnected) is another stream. A retry's new token is not, so it
   * does not change this.
   */
  private readonly stream = computed(() =>
    isLive(this.slot()) ? `${this.n()}|${this.since()}` : null,
  );
  /**
   * The automatic retries made on this stream, since its image last stayed up or the user asked
   * again. Each stream gets the whole budget, so a restarted one is not reported on its first
   * failure because an earlier one used the retries up (reset in the constructor).
   */
  private readonly autoRetries = signal(0);
  private readonly shownSrc = signal<string | null>(null);
  /**
   * Until the live image shows its first frame. It stays through a failed attempt's check and the
   * pause before the retry, when there is no image, so the indicator and its announcement do not
   * go and come back with each attempt.
   */
  protected readonly connecting = computed(
    () =>
      (this.liveImages().length > 0 && this.shownSrc() !== this.liveSrc()) ||
      (this.liveSrc() !== null && this.failure() === 'checking'),
  );

  /**
   * A file slot that is not live shows its file; a pull or a publisher shows only its stream. The
   * streamer reads MJPEG (and a JPEG) through FFmpeg, which the slot's codec tells.
   */
  protected readonly file = computed(() => {
    const slot = this.slot();
    return slot.kind === 'file' && !isLive(slot) && slot.file
      ? filePreview(slot.file, slot.codec === 'mjpeg')
      : null;
  });
  /** The webcam's own camera, until its stream is live. */
  protected readonly camera = computed(() =>
    isLive(this.slot()) || this.slot().kind !== 'webcam' ? null : this.localStream(),
  );
  /** What to say where there is nothing to show. */
  protected readonly idleText = computed(() => {
    const slot = this.slot();
    const pull = slot.pull;
    if (slot.kind === 'pull' && pull) {
      if (pull.status === 'auth_failed' || pull.status === 'needs_credentials') {
        return pull.error ?? '';
      }
      if (pull.status === 'stopped') return 'Start this source to pull the camera.';
      const reason = pull.status === 'unreachable' && pull.error ? ` (${pull.error})` : '';
      return `Waiting for the camera…${reason}`;
    }
    if (slot.kind === 'webcam') return 'Start this source to preview the live webcam.';
    return slot.file ? '' : 'Assign a media file to preview.';
  });

  /**
   * What the picture is, from the slot and not from the preview: `isLive` is the one rule for
   * "Live" (a stream that is connecting or failing is the slot's problem to show, not a reason
   * to stop calling the slot live), so the badge can never claim it for a slot that is not.
   */
  protected readonly badge = computed(
    (): { readonly label: string; readonly live: boolean } | null => {
      const slot = this.slot();
      if (isLive(slot)) return { label: 'Live', live: true };
      if (this.file()) return { label: 'File preview', live: false };
      if (this.camera()) return { label: 'Camera preview', live: false };
      if (slot.kind === 'pull') return { label: 'Not live', live: false };
      return null;
    },
  );
  /** Whether the frame shows a picture behind the badge, which then reads on a dark pill. */
  protected readonly onPicture = computed(
    () =>
      this.file() !== null ||
      this.camera() !== null ||
      (this.liveImages().length > 0 && !this.connecting()),
  );
  protected readonly badgeId = `slot-preview-badge-${badgeIds++}`;

  private readonly liveImage = viewChild<ElementRef<HTMLImageElement>>('live');
  private readonly cameraVideo = viewChild<ElementRef<HTMLVideoElement>>('camera');

  constructor() {
    // An effect rather than a linkedSignal: that is only recomputed when read, so a stream that
    // stopped and started between two reads would look like the one before.
    effect(() => {
      this.stream();
      untracked(() => {
        this.autoRetries.set(0);
        this.token.set(Date.now());
      });
    });
    // One watch per live image, ended when the image changes (another slot, a retry, an error)
    // or the preview goes. A drop ends the image before the stable time is up, so it spends a
    // retry; one that comes later finds the budget whole.
    effect((onCleanup) => {
      const src = this.liveImages()[0]?.src;
      if (src === undefined) return;
      let stable: Subscription | undefined;
      const stopWatching = watchFirstFrame(
        () => this.liveImage()?.nativeElement,
        () => {
          this.shownSrc.set(src);
          stable = timer(PREVIEW_STABLE_MS).subscribe(() => this.autoRetries.set(0));
        },
      );
      onCleanup(() => {
        stopWatching();
        stable?.unsubscribe();
      });
    });
    // A media stream is a property, not an attribute: it cannot be bound in the template.
    effect(() => {
      const video = this.cameraVideo()?.nativeElement;
      const stream = this.camera();
      if (video && video.srcObject !== stream) video.srcObject = stream;
    });
  }

  /**
   * The live image failed, before its first frame or after showing some (the stream dropped, as
   * on a camera swap of a live slot). Find out whether it is the server's cap on previews (429),
   * which only a new stream can meet: that is reported at once and left to the user, since asking
   * again by itself would only keep it full. Any other failure is retried by itself, quietly,
   * while the stream has retries left.
   */
  protected failed(src: string): void {
    this.failure.set('checking');
    this.probe?.unsubscribe();
    this.probe = previewFailure(this.http, src)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((failure) => {
        // Another slot or a retry has replaced the image meanwhile.
        if (this.liveSrc() !== src) return;
        if (failure === 'failed' && this.autoRetries() < PREVIEW_RETRIES) this.retryLater(src);
        else this.failure.set(failure);
      });
  }

  /** Stays 'checking', which shows nothing, through the pause, then asks for a new stream. */
  private retryLater(src: string): void {
    this.autoRetries.update((count) => count + 1);
    this.pause?.unsubscribe();
    this.pause = timer(PREVIEW_RETRY_MS)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // Another slot has replaced the image meanwhile, and has its own retries.
        if (this.liveSrc() === src) this.token.set(Date.now());
      });
  }

  /** The user's Retry: a fresh count, since they decided this was worth another go. */
  protected retry(): void {
    this.autoRetries.set(0);
    this.token.set(Date.now());
  }
}
