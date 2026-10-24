/**
 * Writes `text` to the clipboard as plain text. Rejects when the browser has no clipboard (it
 * offers one only in a secure context: HTTPS or localhost) or refuses access; each caller words
 * that failure for what it was copying. Insight is served over HTTPS, so #170's textarea fallback
 * for insecure pages has no case here (F9).
 */
export async function copyText(text: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard) throw new Error('The browser offers no clipboard on this page.');
  await clipboard.writeText(text);
}
