// The GenAI tab's tutorial: shown on the first visit and replayable from the
// header. `target` names the control a step highlights; `action` names what
// its "Try it" button does (the view decides how).

export const TUTORIAL_STORAGE_KEY = 'neat-insight:genai-tutorial-seen'

export function tutorialSteps({ canThink = false } = {}) {
  const steps = [
    {
      id: 'intro',
      title: 'Generative AI on your DevKit',
      body:
        "This tab chats with AI models that run on the board's own accelerator, so your questions, " +
        'pictures and voice never leave the board. Everything happens in one chat: type or talk, add a ' +
        'picture, and hear the answer.',
      target: null,
      action: null
    },
    {
      id: 'model',
      title: 'Choose a model',
      body:
        'The model at the top answers your messages. "Sees images" means it also understands pictures. ' +
        'Loading a different model takes a few minutes; Settings, Get more models downloads new ones.',
      target: 'model',
      action: null
    },
    {
      id: 'ask',
      title: 'Ask anything',
      body:
        'Type in the message box and press Enter. The answer appears as it is written; Stop ends it early. ' +
        'New chat starts over.',
      target: 'composer',
      action: 'example-question'
    },
    {
      id: 'picture',
      title: 'Show it a picture',
      body:
        'With a model that sees images, attach a photo or take one with your camera, then ask about it: ' +
        '"What is in this picture?" or "What does this sign say?"',
      target: 'media',
      action: 'camera'
    },
    {
      id: 'talk',
      title: 'Talk to it',
      body:
        'Press the microphone, speak, and press it again. Your words are turned into text and sent. ' +
        'The first time, your browser asks for permission to use the microphone.',
      target: 'mic',
      action: null
    },
    {
      id: 'listen',
      title: 'Hear the answer',
      body:
        'Read aloud reads one reply; press Stop speaking to end it. Turn on Read replies aloud to hear every ' +
        "reply. Some languages, such as Telugu, have no voice on the board yet; the tab tells you when.",
      target: 'read-aloud',
      action: null
    },
    {
      id: 'languages',
      title: 'Use your language',
      body:
        'Ask in your language and the model answers in it, or ask it to translate: ' +
        '"Translate \'good morning\' into Spanish."',
      target: 'composer',
      action: 'example-translate'
    }
  ]
  if (canThink) {
    steps.push({
      id: 'think',
      title: 'Let it think first',
      body:
        'This model can reason step by step before answering. Turn on Think first for maths or logic: it ' +
        'is slower, and the reasoning appears folded above the answer.',
      target: 'think',
      action: null
    })
  }
  steps.push({
    id: 'help',
    title: 'When something is wrong',
    body:
      'The label at the top left shows whether the board is ready. If it says Not running, start GenAI ' +
      'Studio on the board; Settings holds the board address. If a model gets stuck, Settings, ' +
      'Troubleshooting restarts the accelerator. Replay this tutorial any time with Tutorial.',
    target: 'status',
    action: 'settings'
  })
  return steps
}

export function tutorialSeen(storage) {
  try {
    return storage.getItem(TUTORIAL_STORAGE_KEY) === '1'
  } catch {
    return true
  }
}

export function markTutorialSeen(storage) {
  try {
    storage.setItem(TUTORIAL_STORAGE_KEY, '1')
  } catch {
    // Private windows may refuse storage; tutorialSeen() then reports it as seen,
    // so it is not forced on every visit (the Tutorial button still replays it).
  }
}
