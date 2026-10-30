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
//   cameraOpen    a camera panel under the chat is open (this browser's or the board's)
//   visionOpen    the vision view is open
//   replying      a reply is streaming
//   recording     the microphone is recording
//   micOpening    the browser is opening the microphone (it may be asking permission)
//   transcribing  a recording is being turned into text
//   modelOp       a model load, unload, delete or speech-model switch runs
//   benchmarking  the benchmark is running (it loads models and keeps the board busy)
//   documentTask  a document upload, reset or clear is running
//   documentsAvailable  the board can answer from documents
//   benchmarkAvailable  the board offers the benchmark
//   boardCameraAvailable  the board can take pictures with its own camera
//   boardSnapshot a picture is being taken with the board's camera
//   visionAsking  the vision view is waiting for an answer about a picture
//   visionLoop    the vision view's loop is running
//   useDocuments  questions are sent with the documents
//   downloading   a model download runs
//   hubEnabled    the board allows model downloads (its server.hub.allow_download)
export function allowedActions(state) {
  const s = state || {}
  const listening = Boolean(s.recording || s.micOpening || s.transcribing)
  const ready = Boolean(s.usable && !s.modelOp && !s.benchmarking)
  const canChat = ready && Boolean(s.hasChatModel)
  const canSee = canChat && Boolean(s.sees)
  // The vision view asks the model too: one request at a time, as for a reply.
  const visionBusy = Boolean(s.visionAsking || s.visionLoop)
  // A camera panel or the vision view is about to give the current model a picture.
  const previewOpen = Boolean(s.cameraOpen || s.visionOpen)
  // Models change only when nothing is using them.
  const modelsQuiet = ready && !s.replying && !listening && !previewOpen && !visionBusy
  return {
    listening,
    typeMessage: canChat,
    // While the documents are rebuilt their search is down, so a question
    // that asks for them waits.
    send: canChat && !s.replying && !listening && !visionBusy && Boolean(s.hasDraft) && !(s.useDocuments && s.documentTask),
    stopReply: Boolean(s.replying),
    attachPicture: canSee,
    openCamera: canSee && !previewOpen,
    // The board's own camera: a panel under the chat lists its cameras. One
    // picture at a time: a camera device can't serve two captures at once.
    openBoardCamera: canSee && Boolean(s.boardCameraAvailable) && !previewOpen,
    takeBoardSnapshot: canSee && Boolean(s.boardCameraAvailable) && !s.boardSnapshot && !visionBusy,
    // The vision view: ask about a picture once, or loop until stopped. Not
    // beside a reply or a spoken question, which would ask the model at once,
    // nor while a picture is still being taken on the board.
    openVision: canSee && !previewOpen,
    askVision: canSee && !s.replying && !listening && !visionBusy && !s.boardSnapshot,
    startVisionLoop: canSee && !s.replying && !listening && !visionBusy && !s.boardSnapshot,
    // Ends the loop, or the one question being answered (and its reading aloud).
    stopVision: visionBusy,
    // Checked before every turn: a running loop stops once the model can no
    // longer take its pictures (a model operation, a benchmark, the board gone).
    continueVisionLoop: canSee,
    // The picture source and camera stay fixed while the view is asking.
    chooseVisionSource: !visionBusy,
    // A spoken question can be recorded while a reply streams; it waits as a draft.
    startRecording: ready && Boolean(s.hasAsr) && !listening,
    stopRecording: Boolean(s.recording),
    newChat: Boolean(s.hasMessages) && !listening,
    readAloud: ready,
    // The system prompt and reply length are read as each request is sent; a
    // running loop keeps asking the same way until it stops.
    changeReplySettings: !s.visionLoop,
    changeChatModel: modelsQuiet,
    changeSpeechModel: modelsQuiet,
    // Deleting is a model operation too, and the board rescans its models
    // when a download finishes.
    deleteModel: modelsQuiet && !s.downloading,
    // Requests in flight belong to the board they started on (a model load
    // can't be stopped there), so the address waits until they finish.
    changeBoard: !s.replying && !listening && !s.modelOp && !s.downloading && !s.benchmarking && !s.documentTask && !visionBusy,
    searchModels: !s.downloading,
    downloadModel: !s.downloading,
    // The chat's offer of a first model downloads it, then loads it: one
    // download at a time, and not under a model operation or the benchmark.
    downloadFirstModel: ready && Boolean(s.hubEnabled) && !s.downloading,
    // Opens Settings, Models at the Hugging Face search, which exists only
    // on a board that allows downloads.
    browseModels: Boolean(s.hubEnabled),
    // The benchmark loads and unloads models: the same rule as changing them.
    openBenchmark: modelsQuiet && !s.documentTask && Boolean(s.benchmarkAvailable),
    // Fixed for the length of a reply: the reply was sent with or without them.
    toggleDocuments: Boolean(s.documentsAvailable) && !s.replying,
    // A reply that uses the documents may still be searching them.
    // ... and a spoken question may be about to ask them.
    documentTasks: ready && !s.documentTask && !(s.replying && s.useDocuments) && !listening,
    // Reading the database while it is rebuilt would show half of it.
    inspectDocuments: Boolean(s.documentsAvailable) && !s.documentTask
  }
}
