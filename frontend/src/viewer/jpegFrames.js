// A JPEG channel's frames arrive on the "jpeg" DataChannel as chunks, each an
// 8-byte big-endian header (rtp_timestamp u32, chunk_index u16, chunk_count
// u16) and up to 60000 JPEG bytes. rtp_timestamp is the value the frame's
// metadata carries as _insight.rtp_timestamp.
const HEADER_BYTES = 8;

export function parseJpegChunk(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= HEADER_BYTES) return null;
  const view = new DataView(buffer);
  const index = view.getUint16(4);
  const count = view.getUint16(6);
  if (index >= count) return null;
  return { ts: view.getUint32(0), index, count, data: new Uint8Array(buffer, HEADER_BYTES) };
}

export function createJpegAssembler() {
  return { ts: null, count: 0, parts: [], received: 0, incomplete: 0 };
}

// Returns { ts, parts, bytes, receivedAt } once every chunk of a frame is in,
// else null. The channel is ordered but unreliable, so a chunk of a newer frame
// means the unfinished one lost a chunk: it is discarded and counted.
export function acceptJpegChunk(assembler, chunk, receivedAt) {
  if (assembler.ts !== chunk.ts || assembler.count !== chunk.count) {
    if (assembler.ts !== null) assembler.incomplete += 1;
    assembler.ts = chunk.ts;
    assembler.count = chunk.count;
    assembler.parts = new Array(chunk.count);
    assembler.received = 0;
  }
  if (assembler.parts[chunk.index]) return null;
  assembler.parts[chunk.index] = chunk.data;
  assembler.received += 1;
  if (assembler.received < assembler.count) return null;
  const parts = assembler.parts;
  assembler.ts = null;
  assembler.parts = [];
  return {
    ts: chunk.ts,
    parts,
    bytes: parts.reduce((total, part) => total + part.byteLength, 0),
    receivedAt,
  };
}

// Like the H.264 jitter buffer, every frame waits the Video Sync Buffer so all
// of its metadata types can arrive. Picks the newest frame that has waited;
// older waited frames are dropped only when presentation fell behind. Returns
// null while no frame is ready.
export function selectFrameToPresent(pending, videoSyncBufferMs, now) {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (now - pending[index].receivedAt >= videoSyncBufferMs) {
      return { frame: pending[index], dropped: index, remaining: pending.slice(index + 1) };
    }
  }
  return null;
}
