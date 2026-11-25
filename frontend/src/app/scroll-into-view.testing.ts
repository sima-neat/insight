/**
 * Gives elements a `scrollIntoView` for each test of the suite that calls it, and takes it away
 * after each: jsdom has none, and the kit's select calls it on its active option. Call it in a
 * `describe` body.
 */
export function stubScrollIntoView(): void {
  let original: PropertyDescriptor | undefined;
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    if (original === undefined) delete (Element.prototype as Partial<Element>).scrollIntoView;
    else Object.defineProperty(Element.prototype, 'scrollIntoView', original);
  });
}
