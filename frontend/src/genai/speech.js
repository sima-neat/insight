// Text the board's speech engines can read aloud, from a Markdown reply.
// Markdown symbols would be spoken one by one, and emoji (with their variation
// selectors, skin tones and joiners) make Supertonic fail with a 500.
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu

export function speakableText(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>|~-]+/g, ' ')
    .replace(EMOJI, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
