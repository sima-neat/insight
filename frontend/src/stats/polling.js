export function pollWhileVisible(run, ms, environment = {}) {
  const page = environment.document || document
  const repeat = environment.setInterval || setInterval
  const cancel = environment.clearInterval || clearInterval
  let timer = null

  const onVisibility = () => {
    if (page.visibilityState === 'hidden') {
      if (timer !== null) cancel(timer)
      timer = null
    } else if (timer === null) {
      run()
      timer = repeat(run, ms)
    }
  }

  onVisibility()
  page.addEventListener('visibilitychange', onVisibility)
  return () => {
    if (timer !== null) cancel(timer)
    page.removeEventListener('visibilitychange', onVisibility)
  }
}
