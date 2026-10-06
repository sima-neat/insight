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
