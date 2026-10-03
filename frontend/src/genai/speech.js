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

// The language a reply is written in, when its script names one. Latin text
// returns null: the script alone can't tell English from German.
const SCRIPTS = [
  { code: 'te', name: 'Telugu', re: /[ఀ-౿]/g },
  { code: 'ta', name: 'Tamil', re: /[஀-௿]/g },
  { code: 'kn', name: 'Kannada', re: /[ಀ-೿]/g },
  { code: 'ml', name: 'Malayalam', re: /[ഀ-ൿ]/g },
  { code: 'bn', name: 'Bengali', re: /[ঀ-৿]/g },
  { code: 'gu', name: 'Gujarati', re: /[઀-૿]/g },
  { code: 'pa', name: 'Punjabi', re: /[਀-੿]/g },
  { code: 'hi', name: 'Hindi', re: /[ऀ-ॿ]/g },
  { code: 'th', name: 'Thai', re: /[฀-๿]/g },
  { code: 'he', name: 'Hebrew', re: /[֐-׿]/g },
  { code: 'ar', name: 'Arabic', re: /[؀-ۿ]/g },
  { code: 'el', name: 'Greek', re: /[Ͱ-Ͽ]/g },
  { code: 'ko', name: 'Korean', re: /[가-힯ᄀ-ᇿ]/g },
  { code: 'ja', name: 'Japanese', re: /[぀-ヿ]/g },
  { code: 'zh', name: 'Chinese', re: /[一-鿿]/g },
  { code: 'ru', name: 'Russian', re: /[Ѐ-ӿ]/g }
]

export function scriptLanguage(text) {
  const sample = String(text || '')
  const letters = (sample.match(/\p{L}/gu) || []).length
  if (!letters) return null
  let best = null
  for (const script of SCRIPTS) {
    const count = (sample.match(script.re) || []).length
    if (!best || count > best.count) best = { ...script, count }
  }
  // Japanese text mixes kana with Han characters; any kana means Japanese.
  if (/[぀-ヿ]/.test(sample)) best = { ...SCRIPTS.find((s) => s.code === 'ja'), count: letters }
  if (!best || best.count < letters * 0.3) return null
  return { code: best.code, name: best.name }
}

const LANGUAGE_NAMES = {
  ar: 'Arabic', bg: 'Bulgarian', cs: 'Czech', da: 'Danish', de: 'German', el: 'Greek', en: 'English',
  es: 'Spanish', et: 'Estonian', fi: 'Finnish', fr: 'French', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian',
  id: 'Indonesian', it: 'Italian', ja: 'Japanese', ko: 'Korean', lt: 'Lithuanian', lv: 'Latvian',
  nl: 'Dutch', pl: 'Polish', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak',
  sl: 'Slovenian', sv: 'Swedish', tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese', zh: 'Chinese'
}

export function languageNames(codes) {
  return (codes || []).filter((c) => LANGUAGE_NAMES[c]).map((c) => LANGUAGE_NAMES[c]).sort()
}

// Whether the board's voices can read `text`, and in which language.
// `voiceLanguages` is /v1/audio/voices' `languages`; null while unknown.
export function readAloudSupport(text, voiceLanguages, fallback = 'en') {
  const script = scriptLanguage(speakableText(text))
  if (!script) return { supported: true, language: fallback }
  if (!voiceLanguages || voiceLanguages.includes(script.code)) return { supported: true, language: script.code }
  // Cyrillic covers Russian, Ukrainian and Bulgarian; the board may have any of them.
  if (script.code === 'ru') {
    const cyrillic = ['ru', 'uk', 'bg'].find((c) => voiceLanguages.includes(c))
    if (cyrillic) return { supported: true, language: cyrillic }
  }
  return { supported: false, language: script.code, name: script.name }
}
