// Export chat (.log) and the SiMaSentry Solutions launcher, matching the
// standalone GenAI Studio. Kept free of React and DOM so `node --test` covers them.
import { splitThinking } from './streams.js'

// The conversation as the standalone Studio's .log export: a header, then each
// turn as "You:" / "Assistant:" and its text; pictures appear as [image].
function chatLines(messages) {
  const body = []
  for (const m of messages || []) {
    if (m.role === 'user') {
      body.push('You:')
      if (m.image) body.push('[image]')
      if (m.text) body.push(m.text)
      body.push('')
    } else {
      const answer = splitThinking(m.content || '').answer.trim()
      if (!answer && !m.error) continue
      body.push('Assistant:', answer || `[${m.error}]`, '')
    }
  }
  return body
}

export function chatLog({ messages, model, now = new Date() }) {
  const body = chatLines(messages)
  if (!body.length) return null
  const header = [
    'Neat GenAI Studio — chat export',
    `Exported: ${now.toLocaleString()}`,
    `Model: ${model || '(none)'}`,
    '='.repeat(60),
    ''
  ]
  return header.concat(body).join('\n')
}

// Every compared model's conversation, one section each. chats: model name to
// its messages.
export function compareLog({ chats, now = new Date() }) {
  const sections = Object.entries(chats || {})
    .map(([model, messages]) => ({ model, body: chatLines((messages || []).filter((m) => !m.skipped)) }))
    .filter(({ body }) => body.length)
  if (!sections.length) return null
  const header = [
    'Neat GenAI Studio — compare export',
    `Exported: ${now.toLocaleString()}`,
    `Models: ${sections.map(({ model }) => model).join(', ')}`,
    '='.repeat(60),
    ''
  ]
  return header.concat(sections.flatMap(({ model, body }) => [`Model: ${model}`, '-'.repeat(60), '', ...body])).join('\n')
}

export function chatLogFilename(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `neat-chat-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.log`
}

// The three SiMaSentry demo apps, served by Insight from public/genai-solutions.
export const SOLUTIONS = [
  { mode: 'health', name: 'SiMaSentry-Med', image: 'SiMaSentry-Med.png', summary: 'Clinical VLM chat and diagnostic imaging workbench' },
  { mode: 'safety', name: 'SiMaSentry-Safe', image: 'SiMaSentry-Safe.png', summary: 'PPE and hazard inspection with live camera zones' },
  { mode: 'security', name: 'SiMaSentry-Sec', image: 'SiMaSentry-Sec.png', summary: 'SOC threat analysis and change detection' }
]

export const SOLUTIONS_ROOT = '/genai-solutions'

// The app's address, pre-wired to the board's loaded model through Insight's
// relay. provider=ollama keeps the app from asking for an API key; the URL
// parameters override what the app remembers, so each open uses the current model.
export function solutionUrl(mode, model) {
  const params = new URLSearchParams({ provider: 'ollama', base_url: '/api/genai/v1/chat/completions' })
  if (model) params.set('model', model)
  return `${SOLUTIONS_ROOT}/${mode}/index.html?${params.toString()}`
}
