// Every request to the board belongs to the board session it started in.
// Changing the board address or leaving the tab ends the session: its requests
// are aborted, and results that still arrive are recognised as stale and
// dropped. Operations take a ticket instead of tracking the board themselves.

export function anySignal(signals) {
  const list = signals.filter(Boolean)
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const controller = new AbortController()
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

export function createBoardSession() {
  let controller = new AbortController()
  return {
    // One operation's ticket: `signal` ends with the session (and with `own`,
    // the operation's own abort signal, when given); `live()` says whether
    // its results still belong to the current board.
    ticket(own) {
      const session = controller.signal
      return { signal: own ? anySignal([session, own]) : session, live: () => !session.aborted }
    },
    // A new board: everything started for the previous one ends.
    restart() {
      controller.abort()
      controller = new AbortController()
    },
    close() {
      controller.abort()
    }
  }
}

// For a tab that is gone: its signal is already aborted and nothing it
// returns is used.
export function closedTicket() {
  const session = createBoardSession()
  session.close()
  return session.ticket()
}

export function isAbort(error) {
  return Boolean(error) && error.name === 'AbortError'
}
