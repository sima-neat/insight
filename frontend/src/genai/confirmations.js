// The questions GenAI Studio asks before an action, for ConfirmDialog
// (sima-neat/insight#221). Each message is the text the browser's confirm()
// used to show.
import { chatModels, formatBytes, formatDuration, friendlyModelName } from './backendState.js'
import { loadedChatModels, residentLimit } from './models.js'

export function deleteModelQuestion(model) {
  const size = model.sizeBytes ? ` (${formatBytes(model.sizeBytes)})` : ''
  return {
    title: 'Delete the model',
    message: `Delete ${friendlyModelName(model.name)}${size} from the board? Its files are removed; download it again to use it.`,
    confirmLabel: 'Delete',
    danger: true
  }
}

// plan: loadPlan() for the model, of kind replace or add (use and choose ask
// nothing, or ask which models to unload).
export function loadModelQuestion(model, plan) {
  const wait = model.estimatedLoadS ? ` It takes about ${formatDuration(model.estimatedLoadS)}.` : ''
  const names = (list) => list.map((m) => friendlyModelName(m.name)).join(', ')
  const others = plan.kind === 'add' && plan.keeps.length
    ? ` ${names(plan.keeps)} ${plan.keeps.length === 1 ? 'stays' : 'stay'} loaded.`
    : plan.kind === 'replace' && plan.unloads.length ? ` ${names(plan.unloads)} is unloaded first.` : ''
  return {
    title: 'Load the model',
    message: `Load ${friendlyModelName(model.name)}?${wait}${others}`,
    confirmLabel: 'Load',
    plan: loadPlanKey(plan)
  }
}

// What a load does to the other loaded models, by their exact names: the
// message can't tell two builds of a model apart, since friendlyModelName()
// drops the build and quantization.
export function loadPlanKey(plan) {
  const names = (list) => list.map((m) => m.name).sort().join('\n')
  if (plan.kind === 'replace') return `replace\n${names(plan.unloads)}`
  if (plan.kind === 'add') return `add\n${names(plan.keeps)}`
  return plan.kind
}

function nameList(names) {
  const friendly = names.map(friendlyModelName)
  return friendly.length < 2 ? friendly.join('') : `${friendly.slice(0, -1).join(', ')} and ${friendly[friendly.length - 1]}`
}

// What a benchmark of `chosen`, run in that order, does to the loaded models,
// or null when it loads nothing. On a board that keeps one model each load
// replaces the one before, so even a model loaded now can need loading again.
// A board that keeps several unloads only when it is full or short of memory,
// which it decides when the load arrives.
export function benchmarkLoadQuestion(status, chosen) {
  const loadedNow = loadedChatModels(status).map((m) => m.name)
  const limit = residentLimit(status)
  let held = new Set(loadedNow)
  const loads = []
  for (const name of chosen) {
    if (held.has(name)) continue
    loads.push(name)
    if (limit === 1) held = new Set()
    held.add(name)
  }
  if (!loads.length) return null

  const estimates = loads.map((name) => chatModels(status).find((m) => m.name === name)?.estimatedLoadS)
  const wait = estimates.every(Boolean) ? `about ${formatDuration(estimates.reduce((a, b) => a + b, 0))}` : 'a few minutes'
  const opening = `This test loads ${nameList(loads)}${loads.length > 1 ? ', one at a time' : ''}, which takes ${wait}`
  const plan = [limit, ...[...loadedNow].sort(), '', ...chosen].join('\n')
  const ask = { confirmLabel: 'Load and run', plan }

  if (limit === 1) {
    const gone = loadedNow.filter((name) => !held.has(name))
    const stays = `${friendlyModelName(loads[loads.length - 1])} stays loaded afterwards.`
    return gone.length
      ? { ...ask, title: 'Swap the loaded model?', message: `${opening} and unloads ${nameList(gone)}. ${stays} To chat with ${nameList(gone)} again, load it from the Model menu.` }
      : { ...ask, title: 'Load the model first?', message: `${opening}. ${stays}` }
  }
  if (!loadedNow.length) return { ...ask, title: 'Load the model first?', message: `${opening}.` }
  const full = loadedNow.length >= limit
  const which = loadedNow.length > 1 ? `one or more of ${nameList(loadedNow)}` : nameList(loadedNow)
  return {
    ...ask,
    title: full ? 'Swap the loaded model?' : 'Load the model first?',
    message: `${opening}. ${full ? 'That unloads' : 'If the board runs out of room, that unloads'} ${which}. To chat with an unloaded model again, load it from the Model menu.`
  }
}

export function clearDocumentsQuestion() {
  return {
    title: 'Clear the documents',
    message: 'Remove all documents from the board? Use my documents then finds nothing until you upload or reset.',
    confirmLabel: 'Clear',
    danger: true
  }
}

// model: the loaded chat model's name, or null; asked only when it can't see images.
export function solutionQuestion(app, model) {
  return {
    title: `Open ${app.name}`,
    message: model
      ? `${friendlyModelName(model)} doesn't see images, so the ${app.name} picture features won't work. Open it anyway?`
      : `No chat model is loaded, so ${app.name} can't answer until you load one. Open it anyway?`,
    confirmLabel: 'Open anyway'
  }
}

// Whether an answer runs the action: a yes to a question asked about the
// board that is still selected. A board switch while it is open drops it.
export function acceptedAnswer(ask, yes, board) {
  return Boolean(yes && ask && ask.board === board)
}
