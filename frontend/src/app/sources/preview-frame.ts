import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);
const MJPEG_EXTENSIONS = new Set(['mjpeg', 'mjpg']);

/** How a media-library file is previewed, and from where. */
export interface FilePreview {
  readonly kind: 'image' | 'video';
  readonly src: string;
  /** The file's library path, which names the picture. */
  readonly path: string;
}

/** A live MJPEG stream the frame plays as an image, and the words that name its picture. */
export interface PreviewStream {
  readonly src: string;
  readonly alt: string;
}

/** Where the server serves a library file, with range requests, for the browser to play or show. */
const mediaUrl = (path: string) => `/api/media/file?path=${encodeURIComponent(path)}`;

/**
 * How a library file is previewed (#170's Selected Media and Source Preview): MJPEG through the
 * server's multipart MJPEG route, since a browser plays it neither as a video nor as an image; a
 * video or an image as itself; and null for any other file. `mjpeg` says the streamer reads the
 * file as MJPEG, which an extension other than `.mjpeg`/`.mjpg` does not tell (an AVI may hold
 * MJPEG, and the streamer reads a JPEG as MJPEG).
 */
export function filePreview(path: string, mjpeg: boolean): FilePreview | null {
  if (!path) return null;
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  if (mjpeg || MJPEG_EXTENSIONS.has(extension)) {
    return {
      kind: 'image',
      src: `/api/media/preview.mjpg?path=${encodeURIComponent(path)}`,
      path,
    };
  }
  if (VIDEO_EXTENSIONS.has(extension)) return { kind: 'video', src: mediaUrl(path), path };
  if (IMAGE_EXTENSIONS.has(extension)) return { kind: 'image', src: mediaUrl(path), path };
  return null;
}

/**
 * Ends the load of the image it sits on when the image leaves the page. A browser keeps loading a
 * multipart MJPEG image after the element is dropped, so a preview removed from the page would go
 * on decoding, and hold one of the server's four preview sessions, until the stream ends (#170
 * cleared the source for this). Removing the source aborts it.
 */
@Directive({ selector: 'img[appEndsStream]' })
export class EndsStream {
  constructor() {
    const image = inject<ElementRef<HTMLImageElement>>(ElementRef).nativeElement;
    inject(DestroyRef).onDestroy(() => image.removeAttribute('src'));
  }
}

/**
 * The box a preview shows in, for Streaming's slot panel, Media's side panel and Peripherals'
 * camera panel alike: 16:9 like most streams, the picture letterboxed inside it, square as the
 * Viewer's tiles are. Given a library `file` (see `filePreview`) it shows that file: a video plays
 * muted and looping, with its controls. Given a live `stream` it shows that instead, and reports a
 * stream it cannot load (`streamError`). Its content shows in the same box, layered over the file,
 * for what a caller shows instead (a live picture of its own, a message); a caller shows one or
 * the other.
 */
@Component({
  selector: 'app-preview-frame',
  imports: [EndsStream],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './preview-frame.html',
  styleUrl: './preview-frame.css',
})
export class PreviewFrame {
  readonly file = input<FilePreview | null>(null);
  readonly stream = input<PreviewStream | null>(null);
  readonly streamError = output<void>();
}
