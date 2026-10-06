// Incremental parsers for the GenAI Studio's two streaming formats, fed text
// chunks as they arrive from fetch():
// - server-sent events (chat replies, model-load progress)
// - JSON lines (Hugging Face download progress)
// Kept free of React and DOM so `node --test` covers them.

// Feed SSE text chunks; returns complete events ({event, data, id}) and keeps a
// partial event buffered until its blank-line terminator arrives.
export function createSseParser() {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk.replace(/\r\n?/g, '\n')
      const events = []
      let end
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = { event: 'message', data: '', id: null }
        const dataLines = []
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue
          const colon = line.indexOf(':')
          const field = colon === -1 ? line : line.slice(0, colon)
          let value = colon === -1 ? '' : line.slice(colon + 1)
          if (value.startsWith(' ')) value = value.slice(1)
          if (field === 'data') dataLines.push(value)
          else if (field === 'event') event.event = value
          else if (field === 'id') event.id = value
        }
        if (!dataLines.length && event.event === 'message') continue
        event.data = dataLines.join('\n')
        events.push(event)
      }
      return events
    }
  }
}

// Feed text chunks of newline-delimited JSON; returns the parsed objects of
// complete lines. A line that is not JSON is returned as {state:'error'}.
export function createJsonLinesParser() {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop()
      const items = []
      for (const line of lines) {
        const text = line.trim()
        if (!text) continue
        try {
          items.push(JSON.parse(text))
        } catch {
          items.push({ state: 'error', message: `Unreadable progress line: ${text.slice(0, 120)}` })
        }
      }
      return items
    }
  }
}

// The text an OpenAI chat-completions stream event adds, or null for the
// terminating [DONE] marker. Unparseable events add nothing.
export function chatDeltaText(data) {
  if (data === '[DONE]') return null
  try {
    const parsed = JSON.parse(data)
    if (parsed.error) throw new Error(parsed.error.message || String(parsed.error))
    const choice = parsed.choices && parsed.choices[0]
    return (choice && choice.delta && choice.delta.content) || ''
  } catch (error) {
    if (error instanceof SyntaxError) return ''
    throw error
  }
}

// Reasoning models wrap their thinking in <think>…</think>; the tab shows it
// separately (and folded) from the answer.
export function splitThinking(text) {
  const open = text.indexOf('<think>')
  if (open === -1) return { thinking: '', answer: text, thinkingDone: true }
  const close = text.indexOf('</think>', open)
  if (close === -1) {
    return { thinking: text.slice(open + 7).trim(), answer: text.slice(0, open).trim(), thinkingDone: false }
  }
  return {
    thinking: text.slice(open + 7, close).trim(),
    answer: (text.slice(0, open) + text.slice(close + 8)).trim(),
    thinkingDone: true
  }
}
