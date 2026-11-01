// The questions GenAI Studio asks before an action, for ConfirmDialog
// (sima-neat/insight#221). Each message is the text the browser's confirm()
// used to show.
import { formatBytes, formatDuration, friendlyModelName } from './backendState.js'

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
    confirmLabel: 'Load'
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
