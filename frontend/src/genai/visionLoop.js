// The vision view's loop, like the standalone Studio's: take a picture, ask
// the model about it, show the answer, pause, and again until stopped. One
// request at a time: the next picture is taken only once the answer (and its
// reading aloud) is over. Kept free of React and DOM so `node --test` covers it.

export const VISION_PRESETS = ['What do you see?', 'Describe the scene in detail', 'Read any text in view']

// The standalone Studio's pause between answers: time to read one before the
// next replaces it, and a breather for the board.
export const LOOP_PAUSE_MS = 800

// Waits `ms`, or less when `signal` ends.
export function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

// capture(signal) -> picture; ask({picture, prompt, signal, turn}) -> answer
// (resolves once the answer is shown and read). prompt() is read at every turn,
// so an edited prompt is asked from the next picture on. blocked() returns why
// the loop can't go on (null when it can), checked before every picture.
// onStop(reason) is called once: reason is null when stopped by stop() without
// one, or the error or block that ended the loop.
export function createVisionLoop({ capture, ask, prompt, blocked = () => null, onStop, pauseMs = LOOP_PAUSE_MS, wait = pause }) {
  const controller = new AbortController()
  let stopped = false
  let turns = 0

  function stop(reason = null) {
    if (stopped) return
    stopped = true
    controller.abort()
    onStop?.(reason)
  }

  async function run() {
    const { signal } = controller
    try {
      while (!stopped) {
        const reason = blocked()
        if (reason) {
          stop(reason)
          break
        }
        const picture = await capture(signal)
        if (stopped) break
        turns += 1
        await ask({ picture, prompt: prompt(), signal, turn: turns })
        if (stopped) break
        await wait(pauseMs, signal)
      }
    } catch (error) {
      // An abort the loop didn't ask for (the board session ended) stops it quietly.
      stop(error && error.name === 'AbortError' ? null : (error && error.message) || String(error))
    }
  }

  return {
    signal: controller.signal,
    start() {
      run()
      return this
    },
    stop,
    get running() { return !stopped },
    get turns() { return turns }
  }
}
