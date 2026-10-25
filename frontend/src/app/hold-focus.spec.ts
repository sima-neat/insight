import { ApplicationRef, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { holdFocus } from './hold-focus';

describe('holdFocus', () => {
  let area: HTMLElement;
  let target: HTMLButtonElement;
  let outside: HTMLButtonElement;

  beforeEach(() => {
    area = document.createElement('div');
    target = document.createElement('button');
    const inside = document.createElement('button');
    inside.className = 'inside';
    area.append(target, inside);
    outside = document.createElement('button');
    document.body.append(area, outside);
  });

  afterEach(() => {
    area.remove();
    outside.remove();
  });

  /** Asks for the hold, then renders once, as a click's change detection would. */
  function holdAndRender(within?: () => HTMLElement, to = () => target): void {
    holdFocus(TestBed.inject(Injector), to, within);
    TestBed.inject(ApplicationRef).tick();
  }

  it('moves a focus that fell to the body, once rendered', () => {
    const vanishing = document.createElement('button');
    document.body.append(vanishing);
    vanishing.focus();
    holdFocus(TestBed.inject(Injector), () => target);
    // The button goes with the render; until then the focus stays where it is.
    vanishing.remove();
    expect(document.activeElement).toBe(document.body);
    TestBed.inject(ApplicationRef).tick();
    expect(document.activeElement).toBe(target);
  });

  it('leaves a focus moved elsewhere where it is', () => {
    outside.focus();
    holdAndRender();
    expect(document.activeElement).toBe(outside);
  });

  it('moves a focus still inside `within`, and only there', () => {
    area.querySelector<HTMLElement>('.inside')!.focus();
    holdAndRender(() => area);
    expect(document.activeElement).toBe(target);

    outside.focus();
    holdAndRender(() => area);
    expect(document.activeElement).toBe(outside);
  });

  it('does nothing without a target', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    holdAndRender(undefined, () => null as unknown as HTMLButtonElement);
    expect(document.activeElement).toBe(document.body);
  });
});
