/**
 * What a screen reader says for a segmented control's radio: its text without the aria-hidden
 * width reserve the kit renders beside each label (so `textContent` alone reads the label twice).
 */
export const radioLabel = (radio: Element | null | undefined): string => {
  if (!radio) return '';
  const copy = radio.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
  return copy.textContent?.replace(/\s+/g, ' ').trim() ?? '';
};
