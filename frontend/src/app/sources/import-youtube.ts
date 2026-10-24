import {
  ChangeDetectionStrategy,
  Component,
  computed,
  Directive,
  effect,
  ElementRef,
  inject,
  Injectable,
  input,
  signal,
} from '@angular/core';
import { NeatButton, NeatNote } from '@sima/neat-ui';
import { NeatErrorNote, NeatField } from '@sima/neat-ui/field';
import { NeatInput } from '@sima/neat-ui/input';
import { NeatSelect, type NeatSelectOption } from '@sima/neat-ui/select';
import type { YoutubePreview, YoutubeTarget } from './api';
import { ImportPreview } from './import-preview';
import { ImportRunner } from './import-runner';
import { ImportSession } from './import-session';
import { ImportSummary } from './import-summary';
import { MediaLibraryService } from './media-library.service';
import { messageOf } from './stream-lines';

const TARGETS: readonly NeatSelectOption<YoutubeTarget>[] = [
  { value: '1080p30', label: '1080p30' },
  { value: '720p30', label: '720p30' },
  { value: '480p30', label: '480p30' },
];

/** Seconds; the server caps a clip at five minutes. */
const LENGTHS: readonly NeatSelectOption<number>[] = [
  { value: 60, label: '1 minute' },
  { value: 180, label: '3 minutes' },
  { value: 300, label: '5 minutes' },
];

/** The only page the preview frames: the embed URL the server builds from the video's id. */
const EMBED_PREFIX = 'https://www.youtube.com/embed/';

/**
 * Shows a YouTube embed in the iframe it sits on: `<iframe [appYoutubeEmbed]="url">`. Angular
 * refuses a frame's URL from a template unless `DomSanitizer` vouches for it, and injecting that
 * puts Angular's HTML sanitizer into the initial bundle (6.7 kB); the URL is checked here instead,
 * against the one page a preview may frame. Anything else leaves the frame blank.
 */
@Directive({ selector: 'iframe[appYoutubeEmbed]' })
export class YoutubeEmbed {
  readonly appYoutubeEmbed = input.required<string>();

  constructor() {
    const frame = inject<ElementRef<HTMLIFrameElement>>(ElementRef).nativeElement;
    effect(() => {
      const url = this.appYoutubeEmbed();
      frame.src = url.startsWith(EMBED_PREFIX) ? url : 'about:blank';
    });
  }
}

/**
 * What the YouTube tab keeps while the dialog is open (`neat-tabs` destroys a tab's panel when
 * another opens), with #170's defaults. Provided by the dialog.
 */
@Injectable()
export class YoutubeTabState {
  readonly url = signal('');
  readonly target = signal<YoutubeTarget>('1080p30');
  readonly start = signal('0:00');
  readonly length = signal(300);
  /** The validated link's preview; a link must be validated before it is imported. */
  readonly preview = signal<YoutubePreview | null>(null);
  readonly error = signal<string | null>(null);
  readonly validating = signal(false);
}

/**
 * The import dialog's YouTube tab (Inv-SM §1.1): a link validated by the server and previewed,
 * then a clip of it imported through `ImportRunner.importYoutube`, which Cancel Import aborts.
 */
@Component({
  selector: 'app-import-youtube',
  imports: [
    ImportPreview,
    ImportSummary,
    NeatButton,
    NeatErrorNote,
    NeatField,
    NeatInput,
    NeatNote,
    NeatSelect,
    YoutubeEmbed,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import-youtube.html',
  styleUrl: './import-youtube.css',
})
export class ImportYoutube {
  protected readonly state = inject(YoutubeTabState);
  protected readonly runner = inject(ImportRunner);
  private readonly session = inject(ImportSession);
  private readonly library = inject(MediaLibraryService);

  protected readonly targets = TARGETS;
  protected readonly lengths = LENGTHS;

  protected readonly importing = computed(() => this.runner.job() === 'youtube');
  protected readonly minutes = computed(() => this.state.length() / 60);
  protected readonly previewHeading = computed(() => {
    const preview = this.state.preview();
    return preview ? preview.title || 'YouTube Preview' : null;
  });
  protected readonly previewNotes = computed(() => [
    this.state.preview()?.normalized_url ?? '',
    ...(this.state.preview()?.is_live
      ? ['Live stream import is clipped to the selected duration.']
      : []),
    `Insight will import up to ${this.minutes()} minute(s) from ${this.state.start() || '0:00'} as ${this.state.target()} H.264 with B-frames disabled.`,
  ]);
  protected readonly canImport = computed(
    () => !this.runner.busy() && !!this.state.url().trim() && this.state.preview() !== null,
  );

  /** A different link is not the one validated. */
  protected setUrl(url: string): void {
    this.state.url.set(url);
    this.state.preview.set(null);
    this.state.error.set(null);
  }

  /**
   * Asks the server what the link would import. The link it answers with replaces the one typed,
   * and a start time in the link (`?t=`) fills Start Time. An answer for a link that was edited
   * meanwhile is dropped.
   */
  protected async validate(): Promise<void> {
    const url = this.state.url().trim();
    if (!url) {
      this.state.error.set('Enter a YouTube URL.');
      return;
    }
    this.state.validating.set(true);
    this.state.error.set(null);
    try {
      const preview = await this.library.validateYoutube(url);
      if (this.state.url().trim() !== url) return;
      this.state.preview.set(preview);
      this.state.url.set(preview.normalized_url || url);
      if (Number.isFinite(preview.clip_start)) this.state.start.set(String(preview.clip_start));
    } catch (failure) {
      if (this.state.url().trim() !== url) return;
      this.state.preview.set(null);
      // A failure without a message of its own says what did not work, as #170 did.
      this.state.error.set(
        failure instanceof Error && failure.message
          ? messageOf(failure)
          : 'Could not validate YouTube URL.',
      );
    } finally {
      this.state.validating.set(false);
    }
  }

  protected importClip(): void {
    const preview = this.state.preview();
    if (!preview || !this.canImport()) return;
    void this.session.run(() =>
      this.runner.importYoutube({
        url: preview.normalized_url || this.state.url().trim(),
        target: this.state.target(),
        clip_start: this.state.start(),
        clip_duration: this.state.length(),
      }),
    );
  }

  protected cancel(): void {
    this.runner.cancel();
  }
}
