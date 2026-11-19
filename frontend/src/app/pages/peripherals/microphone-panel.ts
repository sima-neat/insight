import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  type ElementRef,
  inject,
  input,
  untracked,
  viewChild,
} from '@angular/core';
import {
  NeatAsideHeading,
  NeatAsidePanel,
  NeatButton,
  NeatInlineButton,
  NeatNote,
} from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatLevelMeter } from '@sima/neat-ui/level-meter';
import { Announcement } from '../../announcement';
import { BoardService } from '../../board/board.service';
import { PanelTitle } from '../../panel-title';
import type { MicrophoneItem } from '../../peripherals/api';
import { type DeviceChip, microphoneSubtitle } from '../../peripherals/devices';
import { MicTest } from '../../peripherals/mic-test';
import {
  captureModes,
  micLevelNotice,
  micTestAction,
  micTestCaption,
  micTestErrorAction,
} from '../../peripherals/mic-test-state';
import { createPlaybackLevel, type PlaybackLevel } from '../../peripherals/playback-level';
import { DeviceDetails } from './device-details';
import { DeviceErrors } from './device-errors';

/** The microphone and board a test is shown for; another of either starts afresh. */
interface ShownTest {
  microphone: MicrophoneItem;
  board: string;
}

/**
 * The selected microphone in Peripherals' side panel, top to bottom: its name and chip, "Part of …" when
 * the same USB device is a camera too, the capture formats, the microphone test, then the
 * collapsed Details.
 *
 * The test is the page's (`MicTest`), one at a time: it records on the board while the meter
 * shows the live level, plays the recording back by itself, then offers Replay. Opening the panel
 * takes up a test the backend still holds for this microphone (`resume`), and so does a rescan
 * that lists another device under its id, or another board; closing it leaves the board's
 * recording to finish, for the next opening to take up.
 *
 * Neat Core has no audio input node, so there is no mode to pick and nothing to export: the panel
 * shows what the board reports and a recording to listen to.
 */
@Component({
  selector: 'app-microphone-panel',
  imports: [
    Announcement,
    DeviceDetails,
    DeviceErrors,
    NeatAsideHeading,
    NeatButton,
    NeatCallout,
    NeatInlineButton,
    NeatLevelMeter,
    NeatNote,
    PanelTitle,
  ],
  hostDirectives: [NeatAsidePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './microphone-panel.html',
  styleUrl: './microphone-panel.css',
})
export class MicrophonePanel {
  readonly microphone = input.required<MicrophoneItem>();
  /** The microphone's row chip in the device list, which the title repeats. */
  readonly chip = input.required<DeviceChip>();

  private readonly board = inject(BoardService);
  private readonly micTest = inject(MicTest);
  private readonly audio = viewChild.required<ElementRef<HTMLAudioElement>>('audio');

  /**
   * The playback's level for the meter, made on the first click that leads to a playback and
   * kept for every playback in this panel's `<audio>`; null before.
   */
  private playback: PlaybackLevel | null = null;
  /** Reads the playback's level for the meter, which calls it unbound once per frame. */
  private readonly playbackLevel = (): number | null => this.playback?.read() ?? null;

  protected readonly partOf = computed(() => microphoneSubtitle(this.microphone()));
  /** One line per capture combination; null when the device does not report its formats. */
  protected readonly captureLines = computed(
    () =>
      captureModes(this.microphone())?.map((mode) => ({
        key: mode.key,
        text: mode.badges.join(' · '),
      })) ?? null,
  );

  /**
   * Which test this panel shows: compared by the microphone's id and `record` and the board's id,
   * so that a Refresh listing the same device does not start the test afresh (and clear an error
   * it shows), while another device under this id, or another board, does.
   */
  private readonly shown = computed<ShownTest | null>(
    () => {
      const board = this.board.id();
      return board === null ? null : { microphone: this.microphone(), board };
    },
    {
      equal: (a, b) =>
        a?.microphone.id === b?.microphone.id &&
        a?.microphone.record === b?.microphone.record &&
        a?.board === b?.board,
    },
  );

  /**
   * The page's test, which is this microphone's: the panel's `resume` (below) runs before the
   * panel first renders, and starts the test afresh when it was another microphone's. The page
   * shows device panels only once a board is selected, so there is a board to resume on.
   */
  protected readonly view = this.micTest.state;
  protected readonly action = computed(() =>
    micTestAction(this.view().status, this.micTest.stopping()),
  );
  protected readonly caption = computed(() =>
    micTestCaption(this.view().status, this.micTest.elapsed()),
  );
  /**
   * What the meter samples: the board's level while recording, the playback's while it plays;
   * nothing otherwise, so the meter is dark and samples nothing.
   */
  protected readonly sample = computed(() => {
    switch (this.view().status) {
      case 'recording':
        return this.micTest.level;
      case 'playing':
        return this.playbackLevel;
      default:
        return null;
    }
  });
  /** The status lines for screen readers; the caption ticks, so it is not a live region. */
  protected readonly announcement = computed(() => {
    switch (this.view().status) {
      case 'recording':
        return 'Recording. Speak now, then press Stop recording.';
      case 'playing':
        return 'Recording playing.';
      default:
        return '';
    }
  });
  /** Said once the playback is over. */
  protected readonly silenceNotice = computed(() => {
    const view = this.view();
    return view.status === 'done' ? micLevelNotice(view.test?.level) : '';
  });
  /** Why the test failed, or, while it still records, why a stop failed. */
  protected readonly error = computed(() => {
    const { status, error } = this.view();
    return status === 'error' || status === 'recording' ? error : null;
  });
  protected readonly errorAction = computed(() => micTestErrorAction(this.error()));

  constructor() {
    // On open, and for another device under this id or another board;
    // `resume` keeps a test already shown for exactly this microphone.
    effect(() => {
      const shown = this.shown();
      if (shown) untracked(() => void this.micTest.resume(shown.microphone, shown.board));
    });
    // After the render that builds this panel: the panel it replaces lets go of its own element
    // when it goes, in that same render, so the order of the two never matters.
    afterNextRender(() => this.micTest.attachAudio(this.audio().nativeElement));
    inject(DestroyRef).onDestroy(() => {
      this.micTest.attachAudio(null);
      this.playback?.close();
    });
  }

  protected act(): void {
    // A press while the stop is under way (aria-disabled) is ignored by `MicTest.stop`.
    const action = this.action();
    if (action.action === 'stop-playing') {
      void this.micTest.stop();
      return;
    }
    // A recording ends in a playback, which may start with no click of its own (a recording
    // that reaches the board's 30 s): the level is made now, while a click lets audio start.
    if (action.action === 'stop') {
      this.preparePlayback();
      void this.micTest.stop();
      return;
    }
    // The page shows device panels only once the board is read, so `shown` is there.
    const shown = this.shown();
    if (!shown) return;
    this.preparePlayback();
    void this.micTest.start(this.microphone(), shown.board);
  }

  protected replay(): void {
    // A finished recording taken up on open has had no click here before.
    this.preparePlayback();
    this.micTest.replay();
  }

  /**
   * Makes the playback level once, inside a click (`createPlaybackLevel`): a media element takes
   * one Web Audio source in its lifetime, so one level serves every playback.
   */
  private preparePlayback(): void {
    this.playback ??= createPlaybackLevel(this.audio().nativeElement);
  }
}
