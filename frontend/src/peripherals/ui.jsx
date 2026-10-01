export function Pill({ tone = '', children }) {
  return <span className={['periph-pill', tone].filter(Boolean).join(' ')}>{children}</span>
}

export function Callout({ tone = 'warn', title, role, children }) {
  return <div className={`periph-callout ${tone}`} role={role}>{title && <strong>{title}</strong>}{children}</div>
}

export function ErrorNotice({ error, children }) {
  if (!error) return null
  return (
    <Callout tone="danger" title={error.message} role="alert">
      {error.hint && <p>{error.hint}</p>}
      {children}
    </Callout>
  )
}
