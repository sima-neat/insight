// The one rule table for what the GenAI tab lets the user do. Every control's
// disabled state and every action's guard read it, so an activity (a reply,
// speech input, a model operation, a download) is respected everywhere at
// once instead of button by button.
//
// state:
//   usable        the board answers and no model operation runs
//   hasChatModel  a chat model is loaded
//   sees          the loaded model takes pictures
//   hasAsr        a speech recognition model is loaded
//   hasMessages   the chat has messages
//   hasDraft      there is text or a picture to send
//   cameraOpen    the camera preview is open
//   replying      a reply is streaming
//   recording     the microphone is recording
//   micOpening    the browser is opening the microphone (it may be asking permission)
//   transcribing  a recording is being turned into text
//   modelOp       a model load, unload or speech-model switch runs
//   benchmarking  the benchmark is running (it loads models and keeps the board busy)
//   documentTask  a document upload, reset or clear is running
//   documentsAvailable  the board can answer from documents
//   useDocuments  questions are sent with the documents
//   downloading   a model download runs
export function allowedActions(state) {
  const s = state || {}
  const listening = Boolean(s.recording || s.micOpening || s.transcribing)
  const ready = Boolean(s.usable && !s.modelOp && !s.benchmarking)
  const canChat = ready && Boolean(s.hasChatModel)
  // Models change only when nothing is using them (an open camera preview is
  // about to give the current model a picture).
  const modelsQuiet = ready && !s.replying && !listening && !s.cameraOpen
  return {
    listening,
    typeMessage: canChat,
    // While the documents are rebuilt their search is down, so a question
    // that asks for them waits.
    send: canChat && !s.replying && !listening && Boolean(s.hasDraft) && !(s.useDocuments && s.documentTask),
    stopReply: Boolean(s.replying),
    attachPicture: canChat && Boolean(s.sees),
    openCamera: canChat && Boolean(s.sees) && !s.cameraOpen,
    // A spoken question can be recorded while a reply streams; it waits as a draft.
    startRecording: ready && Boolean(s.hasAsr) && !listening,
    stopRecording: Boolean(s.recording),
    newChat: Boolean(s.hasMessages) && !listening,
    readAloud: ready,
    changeChatModel: modelsQuiet,
    changeSpeechModel: modelsQuiet,
    // Requests in flight belong to the board they started on (a model load
    // can't be stopped there), so the address waits until they finish.
    changeBoard: !s.replying && !listening && !s.modelOp && !s.downloading && !s.benchmarking && !s.documentTask,
    searchModels: !s.downloading,
    downloadModel: !s.downloading,
    // The benchmark loads and unloads models: the same rule as changing them.
    openBenchmark: modelsQuiet && !s.documentTask,
    // Fixed for the length of a reply: the reply was sent with or without them.
    toggleDocuments: Boolean(s.documentsAvailable) && !s.replying,
    // A reply that uses the documents may still be searching them.
    // ... and a spoken question may be about to ask them.
    documentTasks: ready && !s.documentTask && !(s.replying && s.useDocuments) && !listening
  }
}
