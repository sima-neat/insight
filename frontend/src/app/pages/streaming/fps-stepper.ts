import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { NeatButton } from '@sima/neat-ui';
import { NeatInput } from '@sima/neat-ui/input';
import { NO_VALUE } from '../../no-value';
import { parseFps, stepFps } from '../../sources/fps';

/**
 * A slot's output frame rate: − and + step by 5 down to 1, with no upper
 * bound, and the field takes any whole number. A step commits at once; a typed number commits on
 * Enter, which keeps the focus in the field, or when the field is left after typing (leaving an
 * untouched field chooses nothing, so tabbing past it commits nothing). A draft that is not a whole number of at least 1 is marked
 * invalid while it is typed (`invalidChange`, so the panel can hold Start); leaving it, or an
 * emptied field, puts the rate back and commits nothing. A rate equal to the one shown is no
 * change and is not committed.
 *
 * It shows `value`, else the file's own `nativeFps`; the draft follows whenever that changes.
 */
@Component({
  selector: 'app-fps-stepper',
  imports: [NeatButton, NeatInput],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './fps-stepper.html',
  styleUrl: './fps-stepper.css',
})
export class FpsStepper {
  /** The rate the slot is set to; null streams at the file's own. */
  readonly value = input<number | null>(null);
  readonly nativeFps = input<number | null>(null);
  /** Nothing to set: no file, or one whose rate cannot change (MJPEG). */
  readonly disabled = input(false);
  /** The rate cannot change right now: the slot is streaming or encoding. */
  readonly locked = input(false);

  readonly commit = output<number>();
  readonly invalidChange = output<boolean>();

  protected readonly effective = computed(() => this.value() ?? this.nativeFps());
  protected readonly inert = computed(() => this.disabled() || this.locked());
  protected readonly noValue = NO_VALUE;
  protected readonly draft = signal('');
  protected readonly invalid = signal(false);
  /** Typed in since the field last showed the rate or committed. */
  private edited = false;

  constructor() {
    effect(() => {
      this.effective();
      untracked(() => this.reset());
    });
  }

  /** Shows the slot's rate again, after a commit the server refused. */
  reset(): void {
    this.edited = false;
    const effective = this.effective();
    this.draft.set(effective == null ? '' : String(effective));
    this.markInvalid(false);
  }

  protected step(direction: -1 | 1): void {
    const effective = this.effective();
    if (effective != null) this.commitRate(stepFps(effective, direction));
  }

  protected edit(text: string): void {
    this.edited = true;
    this.draft.set(text);
    this.markInvalid(text.trim() !== '' && parseFps(text) === null);
  }

  /** Leaving the field after typing in it. */
  protected left(): void {
    if (this.edited) this.commitDraft();
  }

  /** Enter, or leaving: an accepted rate is committed, anything else puts the rate back. */
  protected commitDraft(): void {
    const parsed = parseFps(this.draft());
    if (parsed === null) this.reset();
    else this.commitRate(parsed);
  }

  private commitRate(fps: number): void {
    this.edited = false;
    this.markInvalid(false);
    if (fps !== this.effective()) this.commit.emit(fps);
  }

  private markInvalid(invalid: boolean): void {
    if (invalid === this.invalid()) return;
    this.invalid.set(invalid);
    this.invalidChange.emit(invalid);
  }
}
