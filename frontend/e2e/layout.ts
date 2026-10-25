import { Page } from '@playwright/test';

/** The viewports every page's layout is held to. */
export const LAPTOP = { width: 1366, height: 768 };
export const DESKTOP = { width: 1920, height: 1080 };
export const TABLET = { width: 768, height: 1024 };
/**
 * A phone, below the kit's narrow breakpoint (48rem). Not in `VIEWPORTS`: those flows assume the
 * side panel sits beside the page and the top bar names the page, neither of which holds here.
 */
export const PHONE = { width: 390, height: 844 };

/** The three viewports by name, for tests that run a flow at each of them. */
export const VIEWPORTS = [
  { name: '1366×768', size: LAPTOP },
  { name: '1920×1080', size: DESKTOP },
  { name: '768×1024', size: TABLET },
];

/** How far the document and the shell's content area reach past their boxes. */
export function pageOverflow(page: Page) {
  return page.evaluate(() =>
    [document.documentElement, document.querySelector('main')!].map((element) => ({
      horizontal: Math.max(0, element.scrollWidth - element.clientWidth),
      vertical: Math.max(0, element.scrollHeight - element.clientHeight),
    })),
  );
}

/**
 * The top bar's items that spill out of it, and how far the page tools overflow their region. With
 * `toolbarMayScroll` (Ruling R14: tablets) the tools may overflow and scroll sideways: whatever is
 * inside their region counts as clipped by it, so only the region itself has to stay in the bar.
 * A page without tools (Stats) has no region, which overflows by nothing.
 */
export function topBarSpill(page: Page, toolbarMayScroll: boolean) {
  return page.evaluate((mayScroll) => {
    // The shell's top bar is the first header; a page may have headers of its own (a panel's).
    const header = document.querySelector('header')!;
    const bar = header.getBoundingClientRect();
    const tools = header.querySelector('[role="group"][aria-label="Page tools"]');
    const spilled = [...header.querySelectorAll('*:not(svg *)')]
      .filter((element) => {
        if (mayScroll && tools?.contains(element) && element !== tools) return false;
        const box = element.getBoundingClientRect();
        return (
          box.width > 0 &&
          (box.left < bar.left - 0.5 ||
            box.right > bar.right + 0.5 ||
            box.top < bar.top - 0.5 ||
            box.bottom > bar.bottom + 0.5)
        );
      })
      .map((element) => element.outerHTML.slice(0, 80));
    const toolsOverflow = mayScroll || !tools ? 0 : tools.scrollWidth - tools.clientWidth;
    return { spilled, toolsOverflow };
  }, toolbarMayScroll);
}
