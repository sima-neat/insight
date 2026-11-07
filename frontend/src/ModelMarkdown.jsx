import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Model output is untrusted: an image in it would be fetched from wherever the
// model points (so it is shown as its alt text), and links open outside Insight.
const MARKDOWN_COMPONENTS = {
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />
}

export default function ModelMarkdown({ children }) {
  return <div className="genai-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{children}</ReactMarkdown></div>
}
