// Cuts a reply into pieces to read aloud while it is still being written, like
// the standalone Studio: each finished sentence (or line) goes to the speech
// engine at once instead of waiting for the whole reply.
import { speakableText } from './speech.js'

// Pieces shorter than this ("1.", "Yes.") wait and join the next one, as the
// standalone Studio does, so the voice doesn't stop after every fragment.
export const MIN_SPOKEN_CHARS = 20

const FENCE = /^\s*```[^\n]*\n[\s\S]*?\n\s*```[^\n]*(\n|$)/
// A sentence ends at . ! ? (plus closing quotes or brackets) before whitespace,
// or at CJK full stops, which are not followed by spaces.
const SENTENCE_END = /[。！？]+|[.!?…]+["'”’)\]]*(?=\s)/

// push(full, final) takes the whole reply so far (Markdown) and returns the new
// speakable pieces; final = true flushes what is left. Code blocks are skipped.
export function createSentenceSplitter({ minChars = MIN_SPOKEN_CHARS } = {}) {
  let pos = 0
  let held = ''

  function emit(raw, out, flush) {
    const words = speakableText(raw)
    // Chinese and Japanese put no space after a full stop.
    const gap = /[。！？]$/.test(held) ? '' : ' '
    const piece = words ? (held ? `${held}${gap}${words}` : words) : held
    if (!piece) return
    if (piece.length < minChars && !flush) {
      held = piece
      return
    }
    out.push(piece)
    held = ''
  }

  return {
    push(full, final = false) {
      const text = String(full || '')
      const out = []
      while (pos < text.length) {
        const rest = text.slice(pos)
        if (/^\s*```/.test(rest)) {
          const block = FENCE.exec(rest)
          if (!block) {
            // An unfinished code block: wait for it, or drop it at the end.
            if (final) pos = text.length
            break
          }
          pos += block[0].length
          continue
        }
        const ends = []
        const sentence = SENTENCE_END.exec(rest)
        if (sentence) ends.push(sentence.index + sentence[0].length)
        const newline = rest.indexOf('\n')
        if (newline !== -1) ends.push(newline + 1)
        const fence = rest.indexOf('```')
        if (fence > 0) ends.push(fence)
        if (!ends.length) {
          if (final) {
            emit(rest, out, false)
            pos = text.length
          }
          break
        }
        const end = Math.min(...ends)
        emit(rest.slice(0, end), out, false)
        pos += end
      }
      if (final && held) {
        out.push(held)
        held = ''
      }
      return out
    }
  }
}

// All pieces of a finished reply, for Read aloud.
export function speakablePieces(markdown, options) {
  return createSentenceSplitter(options).push(markdown, true)
}
