import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { NeatButton, NeatNote } from '@sima/neat-ui';
import { NeatErrorNote, NeatField } from '@sima/neat-ui/field';
import { NeatInput } from '@sima/neat-ui/input';
import { NeatPopover, NeatPopoverContent, NeatPopoverTrigger } from '@sima/neat-ui/popover';
import { NeatToasts } from '@sima/neat-ui/toast';
import { Announcement } from '../../announcement';
import { ticking } from '../../clock';
import { holdFocus } from '../../hold-focus';
import { formatElapsed } from '../../stats/format';
import { parseTags, traceName, validateTrace } from '../../stats/runs';
import type { SentinelFailure } from '../../stats/sentinel-failure';
import { SentinelRuns } from '../../stats/sentinel-runs';

/** The Record form's fields, each of which shows its own validation message. */
type TraceField = 'name' | 'note' | 'tags';

/**
 * The first problem with a trace request and the field it concerns. `validateTrace` checks the
 * name, then the note, then the tags, so asked with the later parts empty it can only fault an
 * earlier one: the field is known without reading its message.
 */
function traceProblem(
  name: string,
  note: string,
  tags: readonly string[],
): { field: TraceField; message: string } | null {
  const checks: [TraceField, string | null][] = [
    ['name', validateTrace(name, '', [])],
    ['note', validateTrace(name, note, [])],
    ['tags', validateTrace(name, note, tags)],
  ];
  const found = checks.find(([, message]) => message !== null);
  return found ? { field: found[0], message: found[1]! } : null;
}

/**
 * The Stats toolbar's trace control. With no trace recording on the board it is Record, which
 * opens the Start a trace popover: Name (offered afresh from the time on each opening), Note and
 * Tags. While one records (started here, elsewhere in Insight or from the Sentinel CLI: the trace
 * is `SentinelRuns`' 30 s read) it says "Recording · <name> · <elapsed>" with Stop.
 *
 * The note and the tags stay as typed from one opening to the next: traces recorded one after the
 * other usually share them, while each needs a name of its own.
 */
@Component({
  selector: 'app-record-trace',
  imports: [
    Announcement,
    NeatButton,
    NeatErrorNote,
    NeatField,
    NeatInput,
    NeatNote,
    NeatPopover,
    NeatPopoverContent,
    NeatPopoverTrigger,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './record-trace.html',
  styleUrl: './record-trace.css',
})
export class RecordTrace {
  protected readonly runs = inject(SentinelRuns);
  private readonly toasts = inject(NeatToasts);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly injector = inject(Injector);
  /** The elapsed time moves in seconds. */
  private readonly now = ticking(1000);

  protected readonly open = signal(false);
  protected readonly name = signal('');
  protected readonly note = signal('');
  protected readonly tags = signal('');
  private readonly fields: Record<TraceField, WritableSignal<string>> = {
    name: this.name,
    note: this.note,
    tags: this.tags,
  };
  /** What Start found wrong with the form, until the field it concerns is edited. */
  protected readonly problem = signal<{ field: TraceField; message: string } | null>(null);
  /** Why the last Start was refused, until the popover opens again or Start is pressed. */
  protected readonly failure = signal<SentinelFailure | null>(null);
  /** What a successful start says to screen readers, until the trace ends. */
  protected readonly announced = signal('');

  protected readonly starting = computed(() => this.runs.traceBusy() === 'start');

  /**
   * How long the trace has recorded: the last summary's duration plus the time since it was read,
   * or the time since the start's answer before any summary, all on this browser's clock
   * (`SentinelRuns.traceReadAt` says why not the board's `started_at`). The clock ticks up to a
   * second behind a read, so the time since is never below zero. While the newest trace read
   * failed it is left out.
   */
  protected readonly elapsed = computed(() => {
    const readAt = this.runs.traceReadAt();
    // While the trace cannot be read, whether it still records is not known: no clock runs on.
    if (readAt === null || this.runs.traceFailure() !== null) return '';
    const recorded = this.runs.traceSummary()?.duration_ms ?? 0;
    return formatElapsed(recorded + Math.max(0, this.now() - readAt));
  });

  constructor() {
    // A trace that shows (a refused start read it, or the 30 s read found one) replaces Record and
    // its popover; the popover is closed with it, so it neither opens by itself once the trace
    // ends nor keeps a start's refusal from the toast. A trace that ends takes its start's
    // announcement with it: the line would otherwise still say it records.
    effect(() => {
      const recording = this.runs.trace() !== null;
      untracked(() => (recording ? this.open.set(false) : this.announced.set('')));
    });
  }

  protected errorOf(field: TraceField): string {
    const problem = this.problem();
    return problem?.field === field ? problem.message : '';
  }

  /** Follows the popover; each opening offers a name made from the time, with nothing to fix. */
  protected setOpen(open: boolean): void {
    if (open) {
      this.name.set(traceName(new Date()));
      this.problem.set(null);
      this.failure.set(null);
    }
    this.open.set(open);
  }

  protected edit(field: TraceField, value: string): void {
    this.fields[field].set(value);
    if (this.problem()?.field === field) this.problem.set(null);
  }

  /** Starts the trace the form describes, as validated: the popover closes once it records. */
  protected async start(): Promise<void> {
    if (this.runs.traceBusy() !== null) return;
    const note = this.note().trim();
    const tags = parseTags(this.tags());
    const problem = traceProblem(this.name(), note, tags);
    this.problem.set(problem);
    this.failure.set(null);
    if (problem) return;
    const name = this.name().trim();
    const failure = await this.runs.startTrace({
      name,
      ...(note === '' ? {} : { note }),
      ...(tags.length === 0 ? {} : { tags }),
    });
    if (failure) {
      // Closed while the start was out (Cancel, Escape): the refusal is said where it is seen.
      if (this.open()) this.failure.set(failure);
      else this.toasts.error(failure.title);
      return;
    }
    this.open.set(false);
    this.announced.set(`Recording ${name}`);
    this.holdFocus();
  }

  protected async stop(): Promise<void> {
    if (this.runs.traceBusy() !== null) return;
    const failure = await this.runs.stopTrace();
    if (failure) this.toasts.error(failure.title);
    else this.holdFocus();
  }

  /**
   * Once the toolbar shows the new state: the button that had the focus (Start in the popover,
   * Stop) is gone by then, which leaves the focus on the body. It moves to this state's button.
   */
  private holdFocus(): void {
    holdFocus(this.injector, () => this.host.nativeElement.querySelector('button'));
  }
}
