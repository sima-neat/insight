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
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NeatButton } from '@sima/neat-ui';
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
} from 'rxjs';
import type { Slot } from '../../sources/api';
import { EndsStream, filePreview, PreviewFrame } from '../../sources/preview-frame';
import { isLive, previewSrc } from './slot-row';

/** How often the live image is checked for its first frame (#170). */
const FRAME_CHECK_MS = 100;
/** How long the check of a failed preview waits for the server before calling it unavailable. */
const PROBE_TIMEOUT_MS = 3000;

/** Why the live preview failed: the server's cap on previews open at once (429), or anything else. */
export type PreviewFailure = 'busy' | 'failed';

/**
 * Calls `onFrame` once the image shows its first frame, checking every 100 ms; returns the stop.
 * A multipart MJPEG `<img>` fires `load` unreliably (Chrome only once the stream ends), so the
 * frame is noticed by the image gaining a width (#170). The checks are a plain timer: the app has
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
 * What the selected slot shows (spec, "Live preview"): the stream for every kind while it is live,
 * through the server's MJPEG preview route; the file itself, labelled so, for a file slot that is
 * not; and the local camera of a webcam this browser publishes until its stream is live. There is
 * no on/off switch: one preview per panel, so at most one per browser tab.
 *
 * The live image is keyed per slot and attempt: another slot, or Retry, makes a new request.
 */
@Component({
  selector: 'app-slot-preview',
  imports: [EndsStream, NeatButton, NeatProgress, PreviewFrame],
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

  /** A new one for each slot, and for each retry. */
  private readonly token = linkedSignal({
    source: () => this.slot().index,
    computation: () => Date.now(),
  });
  /** The publisher's session, which a reconnect between two polls changes. */
  private readonly since = computed(() => {
    const slot = this.slot();
    return (slot.state === 'external' ? slot.external?.since : slot.pull?.since) ?? null;
  });
  protected readonly liveSrc = computed(() =>
    isLive(this.slot()) ? previewSrc(this.slot().index, this.token(), this.since()) : null,
  );
  /** The live image's sources, one or none: rendered with `@for` so a new URL is a new image. */
  protected readonly liveSources = computed(() => {
    const src = this.liveSrc();
    return src === null || this.failure() !== null ? [] : [src];
  });
  /** Why the current live image failed, once known; reset by a new image. */
  protected readonly failure = linkedSignal<string | null, PreviewFailure | 'checking' | null>({
    source: this.liveSrc,
    computation: () => null,
  });
  private readonly shownSrc = signal<string | null>(null);
  protected readonly connecting = computed(
    () => this.liveSources().length > 0 && this.shownSrc() !== this.liveSrc(),
  );

  /**
   * A file slot that is not live shows its file; a pull or a publisher shows only its stream. The
   * streamer reads MJPEG (and a JPEG) through FFmpeg, which the slot's codec tells.
   */
  protected readonly file = computed(() => {
    const slot = this.slot();
    return slot.state === 'stopped' ? filePreview(slot.file, slot.codec === 'mjpeg') : null;
  });
  /** The webcam's own camera, until its stream is live. */
  protected readonly camera = computed(() =>
    isLive(this.slot()) || this.slot().type !== 'webcam' ? null : this.localStream(),
  );
  /** What to say where there is nothing to show. */
  protected readonly idleText = computed(() => {
    const slot = this.slot();
    if (slot.state === 'pulled') {
      const pull = slot.pull;
      if (pull?.status === 'auth_failed') return pull.error ?? '';
      const reason = pull?.status === 'unreachable' && pull.error ? ` (${pull.error})` : '';
      return `Waiting for the camera…${reason}`;
    }
    if (slot.type === 'webcam') return 'Start this source to preview the live webcam.';
    return slot.file ? '' : 'Assign a media file to preview.';
  });

  private readonly liveImage = viewChild<ElementRef<HTMLImageElement>>('live');
  private readonly cameraVideo = viewChild<ElementRef<HTMLVideoElement>>('camera');

  constructor() {
    // One watch per live image, ended when the image changes (another slot, a retry, an error)
    // or the preview goes.
    effect((onCleanup) => {
      const src = this.liveSources()[0];
      if (src === undefined) return;
      onCleanup(
        watchFirstFrame(
          () => this.liveImage()?.nativeElement,
          () => this.shownSrc.set(src),
        ),
      );
    });
    // A media stream is a property, not an attribute: it cannot be bound in the template.
    effect(() => {
      const video = this.cameraVideo()?.nativeElement;
      const stream = this.camera();
      if (video && video.srcObject !== stream) video.srcObject = stream;
    });
  }

  /**
   * The live image failed. Only a new stream can meet the server's cap on previews (429), so one
   * that has shown frames is simply unavailable; for one that has not, find out which it is.
   */
  protected failed(src: string): void {
    if (this.shownSrc() === src) {
      this.failure.set('failed');
      return;
    }
    this.failure.set('checking');
    this.probe?.unsubscribe();
    this.probe = previewFailure(this.http, src)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((failure) => {
        // Another slot or a retry has replaced the image meanwhile.
        if (this.liveSrc() === src) this.failure.set(failure);
      });
  }

  protected retry(): void {
    this.token.set(Date.now());
  }
}
