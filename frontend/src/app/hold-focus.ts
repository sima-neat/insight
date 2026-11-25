import { afterNextRender, DOCUMENT, type Injector } from '@angular/core';

/** Something that takes the focus: an element, or a kit component with a `focus()` of its own. */
export interface Focusable {
  focus(): void;
}

/**
 * Keeps the keyboard in place when a click removes the button it was on (Clear, Dismiss, Start,
 * Stop, a delete): once the next render shows what changed, the focus that fell to the body
 * moves to `target`. A focus moved elsewhere meanwhile (a request can take a while) is left where
 * it is, unless it is still inside `within`, whose content the change replaced. `target` is asked
 * for only then, so it can name what the new state shows.
 */
export function holdFocus(
  injector: Injector,
  target: () => Focusable | null | undefined,
  within?: () => HTMLElement,
): void {
  const document = injector.get(DOCUMENT);
  afterNextRender(
    {
      read: () => {
        const focused = document.activeElement;
        const lost = focused === null || focused === document.body;
        if (lost || (focused !== null && within?.().contains(focused))) target()?.focus();
      },
    },
    { injector },
  );
}
