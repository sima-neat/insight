// How the GenAI tab asks for a reply: the system prompt and the longest reply
// (max_tokens), both set in Settings, Replies and remembered per browser.
// Kept free of React and DOM so `node --test` covers it.

export const SYSTEM_PROMPT_KEY = 'neat-insight:genai-system-prompt'
export const MAX_TOKENS_KEY = 'neat-insight:genai-max-tokens'

// The standalone Studio's range and default (apps: src/common/config.yaml,
// request.max_tokens). The benchmark has its own setting.
export const MAX_TOKENS_LIMITS = { min: 32, max: 2048, step: 32, default: 512 }

// The tab's default system prompt. Settings, Replies shows it as the
// field's text until the user writes their own.
export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant. Answer clearly and concisely. Use Markdown formatting when it helps. ' +
  'Answer the question in the language it was asked in.'

// Whether the field holds the default: its text, or nothing at all (an empty
// field sends the default rather than no instructions).
export function isDefaultSystemPrompt(text) {
  const prompt = String(text || '').trim()
  return !prompt || prompt === DEFAULT_SYSTEM_PROMPT
}

// The line under the field.
export function systemPromptNote(text) {
  if (!String(text || '').trim()) return 'An empty prompt sends the default.'
  return isDefaultSystemPrompt(text) ? 'The default prompt: edit it to change how replies are written.' : 'Your prompt replaces the default.'
}

// The tab knows whether the message carries a picture, so it says so: a small
// vision model left to judge that itself answered "no image was provided" to
// some questions that had one, and invented a scene for others that had none.
// The sentence is added to the user's own prompt too.
const PICTURE_NOTES = {
  current: "The user's current message includes an image. Answer using what you see in it.",
  earlier: 'An earlier message in this conversation includes an image. Answer questions about it using what you see in it.',
  none:
    'No image is attached to the current message. If the user asks about an image, photo, camera or ' +
    'what you see, say that no image was provided and ask them to attach one or use the camera. Never describe an image you were not given.'
}

// picture: 'current' (this message has one), 'earlier' (an earlier one is sent
// again) or 'none'. custom: the field's text; empty uses the default.
export function systemPromptFor({ custom = '', picture = 'none' } = {}) {
  const base = String(custom || '').trim() || DEFAULT_SYSTEM_PROMPT
  return `${base} ${PICTURE_NOTES[picture] || PICTURE_NOTES.none}`
}

export function clampMaxTokens(value) {
  const { min, max, step, default: fallback } = MAX_TOKENS_LIMITS
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n / step) * step))
}

// What this browser remembers; storage that refuses (a private window) gives
// the defaults. systemPrompt is the field's text: the default when nothing
// of the user's own is saved.
export function loadReplySettings(storage) {
  let systemPrompt = DEFAULT_SYSTEM_PROMPT
  let maxTokens = MAX_TOKENS_LIMITS.default
  try {
    const prompt = storage.getItem(SYSTEM_PROMPT_KEY)
    if (prompt && prompt.trim()) systemPrompt = prompt
    const saved = storage.getItem(MAX_TOKENS_KEY)
    if (saved !== null) maxTokens = clampMaxTokens(saved)
  } catch {
    // Not remembered: the defaults apply.
  }
  return { systemPrompt, maxTokens }
}

// The default prompt (or an empty one), or the default reply length, is
// forgotten rather than stored, so a later change of the default reaches this
// browser too.
export function saveReplySettings(storage, { systemPrompt, maxTokens }) {
  try {
    if (systemPrompt !== undefined) {
      if (isDefaultSystemPrompt(systemPrompt)) storage.removeItem(SYSTEM_PROMPT_KEY)
      else storage.setItem(SYSTEM_PROMPT_KEY, String(systemPrompt))
    }
    if (maxTokens !== undefined) {
      const n = clampMaxTokens(maxTokens)
      if (n === MAX_TOKENS_LIMITS.default) storage.removeItem(MAX_TOKENS_KEY)
      else storage.setItem(MAX_TOKENS_KEY, String(n))
    }
  } catch {
    // The setting still applies until the page is reloaded.
  }
}

// The Replies card's one line.
export function replySummary({ systemPrompt, maxTokens } = {}) {
  const prompt = isDefaultSystemPrompt(systemPrompt) ? 'Default system prompt' : 'Custom system prompt'
  return `${prompt} · longest reply ${clampMaxTokens(maxTokens)} tokens`
}
