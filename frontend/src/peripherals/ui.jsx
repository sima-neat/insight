import { safeHref } from './model.js'

export function Pill({ tone, children }) {
  return <span className={['sysinfo-pill', 'periph-pill', tone].filter(Boolean).join(' ')}>{children}</span>
}

export function Callout({ tone = 'warn', title, role, children }) {
  return (
    <div className={`periph-callout ${tone}`} role={role}>
      {title && <p className="periph-callout-title">{title}</p>}
      {children}
    </div>
  )
}

export function ErrorNotice({ error, children }) {
  if (!error) return null
  return (
    <>
      <p className="sr-only" role="alert">{error.message}</p>
      <Callout tone="danger" title={error.message}>
        {error.hint && <p>{error.hint}</p>}
        {children}
      </Callout>
    </>
  )
}

export function SupportLinks({ links, inline = false }) {
  const valid = (links || []).filter((link) => safeHref(link.url))
  if (!valid.length) return null
  const Tag = inline ? 'span' : 'p'
  return (
    <Tag className="periph-links">
      Tracked in{' '}
      {valid.map((link, index) => (
        <span key={link.url}>
          {index > 0 && ', '}
          <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label || link.url}</a>
        </span>
      ))}
    </Tag>
  )
}
