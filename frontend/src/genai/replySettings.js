// How the GenAI tab asks for a reply: the system prompt and the longest reply
// (max_tokens), both set in Settings, Replies and remembered per browser.
// Kept free of React and DOM so `node --test` covers it.

export const SYSTEM_PROMPT_KEY = 'neat-insight:genai-system-prompt'
export const MAX_TOKENS_KEY = 'neat-insight:genai-max-tokens'

// The standalone Studio's range and default (apps: src/common/config.yaml,
// request.max_tokens). The benchmark has its own setting.
export const MAX_TOKENS_LIMITS = { min: 32, max: 2048, step: 32, default: 512 }

// The Studio's default system prompt (apps: src/common/config.yaml).
export const DEFAULT_SYSTEM_PROMPT =
  'Answer clearly and concisely. Use Markdown formatting when it helps. ' +
  'Answer the question in the language it was asked in.'

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
// again) or 'none'. custom: the user's prompt; empty uses the default.
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
// the defaults.
export function loadReplySettings(storage) {
  let systemPrompt = ''
  let maxTokens = MAX_TOKENS_LIMITS.default
  try {
    systemPrompt = storage.getItem(SYSTEM_PROMPT_KEY) || ''
    const saved = storage.getItem(MAX_TOKENS_KEY)
    if (saved !== null) maxTokens = clampMaxTokens(saved)
  } catch {
    // Not remembered: the defaults apply.
  }
  return { systemPrompt, maxTokens }
}

// An empty prompt, or the default reply length, is forgotten rather than
// stored, so a later change of the default reaches this browser too.
export function saveReplySettings(storage, { systemPrompt, maxTokens }) {
  try {
    if (systemPrompt !== undefined) {
      if (String(systemPrompt).trim()) storage.setItem(SYSTEM_PROMPT_KEY, String(systemPrompt))
      else storage.removeItem(SYSTEM_PROMPT_KEY)
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
