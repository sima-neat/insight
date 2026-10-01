export function pollWhileVisible(run, ms, environment = {}) {
  const page = environment.document || document
  const defer = environment.setTimeout || setTimeout
  const cancel = environment.clearTimeout || clearTimeout
  let timer = null
  let running = false
  let stopped = false

  const schedule = () => {
    if (stopped || running || timer !== null || page.visibilityState === 'hidden') return
    timer = defer(execute, typeof ms === 'function' ? ms() : ms)
  }

  const execute = () => {
    timer = null
    if (stopped || page.visibilityState === 'hidden') return
    running = true
    let result
    try {
      result = run()
    } catch {
      result = undefined
    }
    Promise.resolve(result).then(
      () => { running = false; schedule() },
      () => { running = false; schedule() }
    )
  }

  const onVisibility = () => {
    if (page.visibilityState === 'hidden') {
      if (timer !== null) cancel(timer)
      timer = null
    } else if (timer === null && !running) execute()
  }

  onVisibility()
  page.addEventListener('visibilitychange', onVisibility)
  return () => {
    stopped = true
    if (timer !== null) cancel(timer)
    page.removeEventListener('visibilitychange', onVisibility)
  }
}

export function pollStats(readMetrics, readTrace) {
  return Promise.all([readMetrics(), readTrace()])
}
