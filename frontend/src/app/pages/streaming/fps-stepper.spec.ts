import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FpsStepper } from './fps-stepper';

@Component({
  imports: [FpsStepper],
  template: `<app-fps-stepper
    [value]="value()"
    [nativeFps]="nativeFps()"
    [disabled]="disabled()"
    [locked]="locked()"
    (commit)="commits.push($event)"
    (invalidChange)="invalid.push($event)"
  />`,
})
class Host {
  readonly value = signal<number | null>(null);
  readonly nativeFps = signal<number | null>(30);
  readonly disabled = signal(false);
  readonly locked = signal(false);
  readonly commits: number[] = [];
  readonly invalid: boolean[] = [];
}

describe('FpsStepper', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;

  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    await fixture.whenStable();
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const field = () => root().querySelector<HTMLInputElement>('input')!;
  const decrease = () =>
    root().querySelector<HTMLButtonElement>('[aria-label="Decrease FPS by 5"]')!;
  const increase = () =>
    root().querySelector<HTMLButtonElement>('[aria-label="Increase FPS by 5"]')!;

  async function type(text: string): Promise<void> {
    field().value = text;
    field().dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  async function blur(): Promise<void> {
    field().dispatchEvent(new Event('blur'));
    await fixture.whenStable();
  }

  it('shows the rate the slot streams at, the native one unless another is set', async () => {
    expect(field().value).toBe('30');
    expect(field().getAttribute('aria-label')).toBe('Frames per second');
    host.value.set(15);
    await fixture.whenStable();
    expect(field().value).toBe('15');
  });

  it('− and + commit a step of 5, down to 1 and without an upper bound', async () => {
    increase().click();
    decrease().click();
    expect(host.commits).toEqual([35, 25]);

    host.value.set(3);
    await fixture.whenStable();
    decrease().click();
    host.value.set(1);
    await fixture.whenStable();
    // Already at the minimum: nothing changes, so nothing is committed.
    decrease().click();
    host.value.set(240);
    await fixture.whenStable();
    increase().click();
    expect(host.commits).toEqual([35, 25, 1, 245]);
  });

  it('commits a typed whole number on Enter or when the field is left, and nothing while typing', async () => {
    await type('12');
    expect(host.commits).toEqual([]);
    field().focus();
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await fixture.whenStable();
    // Enter leaves the field, which commits.
    expect(document.activeElement).not.toBe(field());
    expect(host.commits).toEqual([12]);

    await type('300');
    await blur();
    expect(host.commits).toEqual([12, 300]);
  });

  it('marks a draft that is not a whole number of at least 1 as invalid until it is fixed or left', async () => {
    await type('29.97');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(host.invalid.at(-1)).toBe(true);

    await type('29');
    expect(field().hasAttribute('aria-invalid')).toBe(false);
    expect(host.invalid.at(-1)).toBe(false);

    await type('0');
    expect(host.invalid.at(-1)).toBe(true);
    // Leaving an invalid draft puts the rate back and commits nothing.
    await blur();
    expect(field().value).toBe('30');
    expect(field().hasAttribute('aria-invalid')).toBe(false);
    expect(host.invalid.at(-1)).toBe(false);
    expect(host.commits).toEqual([]);

    // An emptied field is not invalid while typing, and is put back when left.
    await type('');
    expect(host.invalid.at(-1)).toBe(false);
    await blur();
    expect(field().value).toBe('30');
    expect(host.commits).toEqual([]);
  });

  it('a new rate from the server replaces the draft and clears its invalid mark', async () => {
    await type('abc');
    expect(host.invalid.at(-1)).toBe(true);
    host.value.set(20);
    await fixture.whenStable();
    expect(field().value).toBe('20');
    expect(host.invalid.at(-1)).toBe(false);
  });

  it('is inert while disabled or locked, and its steps wait for a known rate', async () => {
    host.locked.set(true);
    await fixture.whenStable();
    expect(field().disabled).toBe(true);
    expect(decrease().disabled).toBe(true);
    expect(increase().disabled).toBe(true);

    host.locked.set(false);
    host.disabled.set(true);
    await fixture.whenStable();
    expect(field().disabled).toBe(true);
    expect(increase().disabled).toBe(true);

    host.disabled.set(false);
    host.nativeFps.set(null);
    await fixture.whenStable();
    expect(field().value).toBe('');
    expect(field().disabled).toBe(false);
    expect(increase().disabled).toBe(true);
    expect(decrease().disabled).toBe(true);
  });
});
