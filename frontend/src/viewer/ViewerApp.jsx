import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyVideoSyncBuffer,
  createMetadataQueue,
  enqueueMetadata,
  holdOverlays,
  metadataQueueSnapshot,
  takeMetadataForFrame,
} from "./metadataSync.js";
import AuxiliaryPanel from "./AuxiliaryPanel.jsx";
import "./blazePose3DRenderer.js";
import { partitionFrameMetadata } from "./auxiliaryVisualization.js";
import { channelLabel, formatChannelStatus, resolveCodecLabel } from "./channelStatus.js";
import { updateDecoderHealth } from "./decoderHealth.js";
import {
  acceptJpegChunk,
  createJpegAssembler,
  parseJpegChunk,
  selectFrameToPresent,
} from "./jpegFrames.js";
import { drawMetadata, hasDrawableMetadata } from "./metadataDrawing.js";
import {
  gridDimensions,
  normalizeMaxChannels,
  normalizeVisiblePerPage,
  orientationTransform,
  pageSizePresetsForLimit,
  parseChannelIndices,
} from "./viewerLayout.js";
import {
  isRetryableWebRTCAnswerError,
  requestWebRTCAnswer,
} from "../../../webrtc/static/js/webrtcSignaling.js";

const RECONNECT_DELAY_MS = 2000;
// Deliberately longer than the retry delay: a decoder can legitimately produce
// nothing for a moment while it waits for a keyframe, and reconnecting is the
// more expensive response.
const DECODER_STALL_MS = 5000;
const STREAM_STALE_MS = 1800;
// A JPEG frame still pending this long after the Video Sync Buffer would have
// been presented already; it only stays while the tab is hidden and
// requestAnimationFrame stops presenting, so it is dropped to bound memory.
const JPEG_PENDING_GRACE_MS = 1000;
const auxiliaryWarnings = new Set();

function warnIgnoredAuxiliary(channelIndex, ignored) {
  for (const item of ignored) {
    const id = item.message?.data?.id ?? "<unknown>";
    const key = `${channelIndex}:${id}:${item.reason}`;
    if (auxiliaryWarnings.has(key) || auxiliaryWarnings.size >= 128) continue;
    auxiliaryWarnings.add(key);
    console.warn(`auxiliary: channel ${channelIndex} ignored ${id}: ${item.reason}`);
  }
}

function getResolvedViewerSettings(channelIndex, metadataType = "object-detection") {
  if (typeof window.resolveTypeSettings === "function") {
    return window.resolveTypeSettings(channelIndex, metadataType);
  }
  return {
    general: { videoSyncBufferMs: 300, metadataRetentionMs: 0, showRoi: true },
    type: {},
  };
}

function getSynchronizationSettings(channelIndex) {
  const settings = getResolvedViewerSettings(channelIndex);
  return {
    videoSyncBufferMs:
      typeof settings.general.videoSyncBufferMs === "number" ? settings.general.videoSyncBufferMs : 300,
    metadataRetentionMs:
      typeof settings.general.metadataRetentionMs === "number" ? settings.general.metadataRetentionMs : 0,
  };
}

function getOrientation(channelIndex) {
  return getResolvedViewerSettings(channelIndex).general.orientation;
}

function createJpegTileState() {
  return {
    active: false,
    assembler: createJpegAssembler(),
    pending: [],
    next: null,
    decoding: false,
    width: 0,
    height: 0,
    framesReceived: 0,
    framesDecoded: 0,
    framesSkipped: 0,
    bytesReceived: 0,
    sample: null,
  };
}

function fitCanvas(canvas) {
  if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }
}

function applyLayout(count) {
  const grid = document.getElementById("videoGrid");
  if (!grid) return;

  if (count <= 0) {
    grid.style.gridTemplateColumns = "1fr";
    grid.style.gridTemplateRows = "";
    document.body.classList.remove("single-tile");
    return;
  }

  const { columns } = gridDimensions(count);
  grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  grid.style.gridTemplateRows = "";
  document.body.classList.toggle("single-tile", count === 1);
}

function ChannelTile({ index, onActiveChange, debug }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const auxiliaryPanelRef = useRef(null);
  const metadataQueueRef = useRef(createMetadataQueue());
  const synchronizationSettingsRef = useRef(getSynchronizationSettings(index));
  const videoSyncStatusRef = useRef({ supported: false, applied: false, targetMs: null });
  const heldOverlaysRef = useRef(new Map());
  const trackHistoryRef = useRef(new Map());
  const rtcpRef = useRef({
    lastBytes: null,
    lastTs: null,
    messageCount: 0,
    lastCount: 0,
    codecLabel: null,
    decoderHealth: {
      lastFramesReceived: null,
      lastFramesDecoded: null,
      stalledSinceMs: null,
    },
  });
  const playbackRef = useRef({ lastFrameAt: 0 });
  const activeRef = useRef(false);
  const [banner, setBanner] = useState(`Channel ${index}`);
  const [active, setActive] = useState(false);
  const [jpegMode, setJpegMode] = useState(false);
  const [orientation, setOrientation] = useState(() => getOrientation(index));

  useEffect(() => {
    let mounted = true;
    let pc = null;
    let videoReceiver = null;
    let metadataChannel = null;
    let jpegChannel = null;
    let jpeg = createJpegTileState();
    let animationFrame = null;
    let videoFrameCallback = null;
    let statsInterval = null;
    let reconnectTimer = null;
    let reconnectPending = false;
    let currentSession = 0;

    const debugLog = (...args) => {
      if (!debug) return;
      console.log(`[viewer][ch${index}]`, ...args);
    };

    const setTileActive = (nextActive) => {
      if (activeRef.current === nextActive) return;
      activeRef.current = nextActive;
      setActive(nextActive);
      onActiveChange(index, nextActive);
      debugLog("active", nextActive);
    };

    const applySynchronizationSettings = () => {
      synchronizationSettingsRef.current = getSynchronizationSettings(index);
      videoSyncStatusRef.current = applyVideoSyncBuffer(
        videoReceiver,
        synchronizationSettingsRef.current.videoSyncBufferMs,
      );
    };

    const onViewerSettingsChanged = (event) => {
      const changedScope = event.detail?.scope;
      if (changedScope && changedScope !== "global" && changedScope !== `channel_${index}`) return;
      applySynchronizationSettings();
      setOrientation(getOrientation(index));
      if (event.detail?.metadataType === "tracking") {
        trackHistoryRef.current.clear();
      }
    };

    const scheduleReconnect = () => {
      if (!mounted || reconnectPending) return;
      reconnectPending = true;
      reconnectTimer = window.setTimeout(() => {
        reconnectPending = false;
        connect();
      }, RECONNECT_DELAY_MS);
    };

    const connect = async () => {
      if (!mounted) return;
      currentSession += 1;
      const sessionId = currentSession;
      if (animationFrame != null) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      if (statsInterval != null) {
        window.clearInterval(statsInterval);
        statsInterval = null;
      }
      if (videoFrameCallback != null && videoRef.current?.cancelVideoFrameCallback) {
        videoRef.current.cancelVideoFrameCallback(videoFrameCallback);
        videoFrameCallback = null;
      }
      if (metadataChannel) {
        metadataChannel.close();
        metadataChannel = null;
      }
      if (jpegChannel) {
        jpegChannel.close();
        jpegChannel = null;
      }
      if (pc) {
        // Avoid self-triggered reconnect from deliberate close.
        pc.onconnectionstatechange = null;
        pc.close();
        pc = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setTileActive(false);
      setBanner(`Channel ${index}`);
      setJpegMode(false);
      jpeg = createJpegTileState();
      metadataQueueRef.current = createMetadataQueue();
      auxiliaryPanelRef.current?.reset();
      heldOverlaysRef.current.clear();
      trackHistoryRef.current.clear();
      rtcpRef.current = {
        lastBytes: null,
        lastTs: null,
        messageCount: 0,
        lastCount: 0,
        codecLabel: null,
        decoderHealth: {
          lastFramesReceived: null,
          lastFramesDecoded: null,
          stalledSinceMs: null,
        },
      };
      playbackRef.current = { lastFrameAt: 0 };
      synchronizationSettingsRef.current = getSynchronizationSettings(index);
      debugLog("connect start", synchronizationSettingsRef.current);

      pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      const videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
      videoReceiver = videoTransceiver.receiver;
      applySynchronizationSettings();
      metadataChannel = pc.createDataChannel("metadata", {
        ordered: true,
        maxRetransmits: 0,
      });
      debugLog("pc created");

      metadataChannel.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          enqueueMetadata(metadataQueueRef.current, parsed, performance.now());
          rtcpRef.current.messageCount += 1;
        } catch (_err) {
          // Ignore malformed data channel payloads.
        }
      };

      // A JPEG channel answers without video and sends whole frames here; the
      // first one switches the tile from <video> to drawing on the canvas.
      jpegChannel = pc.createDataChannel("jpeg", {
        ordered: true,
        maxRetransmits: 0,
      });
      jpegChannel.binaryType = "arraybuffer";
      jpegChannel.onmessage = (event) => {
        if (!mounted || sessionId !== currentSession) return;
        const chunk = parseJpegChunk(event.data);
        if (!chunk) return;
        if (!jpeg.active) {
          jpeg.active = true;
          setJpegMode(true);
          setBanner(channelLabel(index, "JPEG"));
          debugLog("jpeg mode");
          animationFrame = requestAnimationFrame(presentJpegFrames);
        }
        const now = performance.now();
        const frame = acceptJpegChunk(jpeg.assembler, chunk, now);
        if (!frame) return;
        jpeg.framesReceived += 1;
        jpeg.bytesReceived += frame.bytes;
        jpeg.pending.push(frame);
        const maxAgeMs = synchronizationSettingsRef.current.videoSyncBufferMs + JPEG_PENDING_GRACE_MS;
        while (now - jpeg.pending[0].receivedAt > maxAgeMs) {
          jpeg.pending.shift();
          jpeg.framesSkipped += 1;
        }
      };

      pc.ontrack = (event) => {
        if (!mounted || sessionId !== currentSession || event.track.kind !== "video" || !videoRef.current) return;
        debugLog("ontrack", {
          kind: event.track.kind,
          id: event.track.id,
          state: event.track.readyState,
        });
        const stream = new MediaStream();
        stream.addTrack(event.track);
        const video = videoRef.current;
        video.srcObject = stream;
        video.onloadedmetadata = () => debugLog("video event: loadedmetadata", { w: video.videoWidth, h: video.videoHeight });
        video.oncanplay = () => debugLog("video event: canplay");
        video.onplaying = () => debugLog("video event: playing");
        video.onpause = () => debugLog("video event: pause");
        video.onstalled = () => debugLog("video event: stalled");
        video.onerror = () => debugLog("video event: error", video.error);
        video
          .play()
          .then(() => {
            playbackRef.current.lastFrameAt = Date.now();
            setTileActive(true);
            debugLog("video.play() resolved");
          })
          .catch((err) => debugLog("video.play() rejected", err?.message || err));
        event.track.onunmute = () => {
          debugLog("track onunmute");
          video.play().catch(() => {});
        };
        startVideoFrameLoop();
      };

      pc.onconnectionstatechange = () => {
        if (!pc || sessionId !== currentSession) return;
        debugLog("connectionState", pc.connectionState);
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          scheduleReconnect();
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (!pc || sessionId !== currentSession) return;
        debugLog("iceConnectionState", pc.iceConnectionState);
      };
      pc.onicegatheringstatechange = () => {
        if (!pc || sessionId !== currentSession) return;
        debugLog("iceGatheringState", pc.iceGatheringState);
      };

      // Picks the frame's metadata and draws it over whatever the canvas holds.
      // source is the <video>, or for JPEG an object with the frame's size.
      const drawFrameMetadata = (ctx, canvas, source, rtpTimestamp, now) => {
        const candidates = takeMetadataForFrame(
          metadataQueueRef.current,
          rtpTimestamp,
          synchronizationSettingsRef.current.metadataRetentionMs,
          now,
        );
        const { overlays, auxiliaryViews, ignoredAuxiliary } = partitionFrameMetadata(
          candidates,
          rtpTimestamp,
        );
        auxiliaryPanelRef.current?.showFrame(auxiliaryViews);
        warnIgnoredAuxiliary(index, ignoredAuxiliary);
        if (!ctx) return;
        // Every type for this frame draws onto the same overlay.
        const frameState = {};
        for (const candidate of holdOverlays(heldOverlaysRef.current, overlays, now)) {
          const metadataType = candidate.data?.type;
          const resolvedSettings = getResolvedViewerSettings(index, metadataType);
          if (
            typeof metadataType !== "string"
            || !hasDrawableMetadata(candidate.data, resolvedSettings)
          ) continue;
          const drawContext = {
            settings: resolvedSettings,
            trackHistory: trackHistoryRef.current,
            now,
            frameState,
            held: candidate.held === true,
          };
          drawMetadata(ctx, canvas, candidate.data, source, index, drawContext);
        }
      };

      const drawFrame = (now, frameMetadata) => {
        if (!mounted || sessionId !== currentSession || !canvasRef.current || !videoRef.current) return;
        const canvas = canvasRef.current;
        const video = videoRef.current;
        const ctx = canvas.getContext("2d");

        if (video.readyState >= 2) {
          if (frameMetadata) {
            playbackRef.current.lastFrameAt = Date.now();
            setTileActive(true);
          }
          fitCanvas(canvas);
          // Always clear overlay to avoid stale masks/opaque leftovers.
          ctx?.clearRect(0, 0, canvas.width, canvas.height);
          drawFrameMetadata(ctx, canvas, video, frameMetadata?.rtpTimestamp, now);
        } else if (ctx && canvas.width > 0 && canvas.height > 0) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          heldOverlaysRef.current.clear();
          trackHistoryRef.current.clear();
          auxiliaryPanelRef.current?.clearFrame();
        }
      };

      const drawJpegFrame = (bitmap, rtpTimestamp, now) => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!ctx) return;
        fitCanvas(canvas);
        jpeg.width = bitmap.width;
        jpeg.height = bitmap.height;
        const source = { videoWidth: bitmap.width, videoHeight: bitmap.height };
        const { scaleX, scaleY, offsetX, offsetY } = window.computeScaleAndOffset(source, canvas);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, offsetX, offsetY, bitmap.width * scaleX, bitmap.height * scaleY);
        playbackRef.current.lastFrameAt = Date.now();
        setTileActive(true);
        drawFrameMetadata(ctx, canvas, source, rtpTimestamp, now);
      };

      // One decode at a time; a frame selected meanwhile replaces the waiting one.
      const decodeJpegFrame = () => {
        if (jpeg.decoding || !jpeg.next) return;
        const state = jpeg;
        const frame = state.next;
        state.next = null;
        state.decoding = true;
        createImageBitmap(new Blob(frame.parts, { type: "image/jpeg" })).then(
          (bitmap) => {
            state.decoding = false;
            if (mounted && sessionId === currentSession) {
              state.framesDecoded += 1;
              drawJpegFrame(bitmap, frame.ts, performance.now());
            }
            bitmap.close();
            if (mounted && sessionId === currentSession) decodeJpegFrame();
          },
          () => {
            state.decoding = false;
            state.framesSkipped += 1;
            if (mounted && sessionId === currentSession) decodeJpegFrame();
          },
        );
      };

      const presentJpegFrames = (now) => {
        if (!mounted || sessionId !== currentSession) return;
        const selected = selectFrameToPresent(
          jpeg.pending,
          synchronizationSettingsRef.current.videoSyncBufferMs,
          now,
        );
        if (selected) {
          jpeg.framesSkipped += selected.dropped + (jpeg.next ? 1 : 0);
          jpeg.pending = selected.remaining;
          jpeg.next = selected.frame;
          decodeJpegFrame();
        }
        animationFrame = requestAnimationFrame(presentJpegFrames);
      };

      const startVideoFrameLoop = () => {
        const video = videoRef.current;
        if (!mounted || sessionId !== currentSession || !video) return;
        if (typeof video.requestVideoFrameCallback === "function") {
          videoFrameCallback = video.requestVideoFrameCallback((now, frameMetadata) => {
            drawFrame(now, frameMetadata);
            startVideoFrameLoop();
          });
          return;
        }
        animationFrame = requestAnimationFrame((now) => {
          drawFrame(now, undefined);
          startVideoFrameLoop();
        });
      };

      const clearStaleTile = () => {
        if (playbackRef.current.lastFrameAt <= 0 || Date.now() - playbackRef.current.lastFrameAt <= STREAM_STALE_MS) {
          return;
        }
        setTileActive(false);
        const canvas = canvasRef.current;
        canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
        heldOverlaysRef.current.clear();
        trackHistoryRef.current.clear();
        auxiliaryPanelRef.current?.clearFrame();
      };

      const sendBrowserReport = (inboundRtp, videoState) => {
        if (metadataChannel?.readyState !== "open") return;
        const metadataSync = metadataQueueSnapshot(metadataQueueRef.current);
        const videoSync = videoSyncStatusRef.current;
        const lastFrameAgeMs =
          playbackRef.current.lastFrameAt > 0 ? Date.now() - playbackRef.current.lastFrameAt : undefined;
        metadataChannel.send(
          JSON.stringify({
            type: "browser_egress_stats",
            channel: index,
            time: new Date().toISOString(),
            connection: {
              connection_state: pc.connectionState,
              ice_connection_state: pc.iceConnectionState,
              ice_gathering_state: pc.iceGatheringState,
              signaling_state: pc.signalingState,
            },
            inbound_rtp: inboundRtp,
            video: {
              ...videoState,
              last_frame_age_ms: lastFrameAgeMs,
              active: activeRef.current,
            },
            data_channel: {
              state: metadataChannel.readyState,
              metadata_messages_per_sec: rtcpRef.current.lastCount,
            },
            synchronization: {
              video_sync_buffer_ms: synchronizationSettingsRef.current.videoSyncBufferMs,
              metadata_retention_ms: synchronizationSettingsRef.current.metadataRetentionMs,
              jitter_buffer_target_supported: videoSync.supported,
              jitter_buffer_target_applied: videoSync.applied,
              jitter_buffer_target_ms: videoSync.targetMs,
              timestamp_matches: metadataSync.timestampMatches,
              arrival_fallbacks: metadataSync.arrivalFallbacks,
              frame_misses: metadataSync.frameMisses,
              metadata_expired: metadataSync.expired,
              metadata_evicted: metadataSync.evicted,
              untimestamped_metadata_received: metadataSync.untimestampedReceived,
              timestamped_metadata_pending: metadataSync.timestampedPending,
              arrival_metadata_pending: metadataSync.arrivalPending,
            },
          })
        );
      };

      // JPEG has no inbound-rtp video report; the tile's own counters stand in.
      const reportJpegStats = () => {
        const tracker = rtcpRef.current;
        const now = performance.now();
        const previous = jpeg.sample;
        const seconds = previous ? (now - previous.at) / 1000 : 0;
        const fps = seconds > 0 ? (jpeg.framesDecoded - previous.framesDecoded) / seconds : 0;
        const bitrateBps = seconds > 0 ? ((jpeg.bytesReceived - previous.bytesReceived) * 8) / seconds : 0;
        jpeg.sample = { at: now, framesDecoded: jpeg.framesDecoded, bytesReceived: jpeg.bytesReceived };
        clearStaleTile();
        setBanner(
          formatChannelStatus({
            index,
            codec: "JPEG",
            width: jpeg.width || "?",
            height: jpeg.height || "?",
            fps: fps.toFixed(1),
            bitrate: (bitrateBps / 1000).toFixed(1),
            messageRate: tracker.lastCount,
          })
        );
        sendBrowserReport(
          {
            bytes_received: jpeg.bytesReceived,
            frames_received: jpeg.framesReceived,
            frames_decoded: jpeg.framesDecoded,
            frames_dropped: jpeg.assembler.incomplete + jpeg.framesSkipped,
            frames_per_second: Number(fps.toFixed(1)),
            frame_width: jpeg.width,
            frame_height: jpeg.height,
            bitrate_bps: Number(bitrateBps.toFixed(1)),
          },
          // The canvas stands in for <video>: HAVE_ENOUGH_DATA once a frame is drawn.
          {
            ready_state: jpeg.framesDecoded > 0 ? 4 : 0,
            paused: false,
            current_time: 0,
            video_width: jpeg.width,
            video_height: jpeg.height,
          },
        );
        tracker.lastCount = tracker.messageCount;
        tracker.messageCount = 0;
      };

      statsInterval = window.setInterval(async () => {
        if (!mounted || !pc || pc.connectionState !== "connected") return;
        if (jpeg.active) {
          reportJpegStats();
          return;
        }
        try {
          const stats = await pc.getStats();
          let decoderStalled = false;
          stats.forEach((report) => {
            if (report.type !== "inbound-rtp" || report.kind !== "video") return;

            const fps = report.framesPerSecond?.toFixed(1) ?? "N/A";
            const width = report.frameWidth ?? "?";
            const height = report.frameHeight ?? "?";

            const tracker = rtcpRef.current;
            // Retained across samples so a report that omits the codec does not
            // blank the segment; reset on connect so a codec change cannot show
            // the previous session's label.
            tracker.codecLabel = resolveCodecLabel(stats, report) ?? tracker.codecLabel;
            const hasPreviousSample = tracker.lastBytes != null && tracker.lastTs != null;
            const deltaBytes = hasPreviousSample ? report.bytesReceived - tracker.lastBytes : 0;
            const deltaTime = hasPreviousSample ? (report.timestamp - tracker.lastTs) / 1000 : 0;
            const bitrateBps = deltaTime > 0 ? (deltaBytes * 8) / deltaTime : 0;
            const bitrate = (bitrateBps / 1000).toFixed(1);
            const jitterBufferDelayMs =
              report.jitterBufferEmittedCount > 0
                ? (report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000
                : 0;
            tracker.decoderHealth = updateDecoderHealth(
              tracker.decoderHealth,
              report,
              Date.now(),
              DECODER_STALL_MS,
            );
            if (tracker.decoderHealth.decodedAdvanced) {
              playbackRef.current.lastFrameAt = Date.now();
              setTileActive(true);
            }
            decoderStalled ||= tracker.decoderHealth.stalled;
            clearStaleTile();
            setBanner(
              formatChannelStatus({
                index,
                codec: tracker.codecLabel,
                width,
                height,
                fps,
                bitrate,
                messageRate: tracker.lastCount,
              })
            );
            debugLog("stats", {
              framesReceived: report.framesReceived,
              framesDecoded: report.framesDecoded,
              framesDropped: report.framesDropped,
              packetsReceived: report.packetsReceived,
              packetsLost: report.packetsLost,
              bytesReceived: report.bytesReceived,
              fps: report.framesPerSecond,
              readyState: videoRef.current?.readyState,
              paused: videoRef.current?.paused,
              currentTime: videoRef.current?.currentTime,
            });

            const video = videoRef.current;
            sendBrowserReport(
              {
                bytes_received: report.bytesReceived,
                packets_received: report.packetsReceived,
                packets_lost: report.packetsLost,
                frames_received: report.framesReceived,
                frames_decoded: report.framesDecoded,
                frames_dropped: report.framesDropped,
                frames_per_second: report.framesPerSecond,
                decoder_implementation: report.decoderImplementation,
                power_efficient_decoder: report.powerEfficientDecoder,
                frame_width: report.frameWidth,
                frame_height: report.frameHeight,
                freeze_count: report.freezeCount,
                pause_count: report.pauseCount,
                bitrate_bps: Number(bitrateBps.toFixed(1)),
                average_jitter_buffer_delay_ms: Number(jitterBufferDelayMs.toFixed(1)),
              },
              {
                ready_state: video?.readyState ?? 0,
                paused: video?.paused ?? true,
                current_time: video?.currentTime ?? 0,
                video_width: video?.videoWidth,
                video_height: video?.videoHeight,
              },
            );

            tracker.lastBytes = report.bytesReceived;
            tracker.lastTs = report.timestamp;
            tracker.lastCount = tracker.messageCount;
            tracker.messageCount = 0;
          });
          if (decoderStalled && mounted && sessionId === currentSession) {
            debugLog("decoder stalled; reconnecting channel");
            scheduleReconnect();
          }
        } catch (_err) {
          // Ignore getStats failures for transient states.
        }
      }, 1000);

      try {
        const answer = await requestWebRTCAnswer(pc, `/offer?channel=${index}`);
        if (!mounted || sessionId !== currentSession) return;
        await pc.setRemoteDescription(answer);
        debugLog("setRemoteDescription ok");
      } catch (_err) {
        if (!mounted || sessionId !== currentSession) return;
        debugLog("connect error", _err?.message || _err);
        if (statsInterval != null) {
          window.clearInterval(statsInterval);
          statsInterval = null;
        }
        if (metadataChannel) {
          metadataChannel.close();
          metadataChannel = null;
        }
        if (jpegChannel) {
          jpegChannel.close();
          jpegChannel = null;
        }
        if (pc) {
          pc.onconnectionstatechange = null;
          pc.close();
          pc = null;
        }
        if (isRetryableWebRTCAnswerError(_err)) {
          setBanner(`Channel ${index} | Waiting for stream`);
          scheduleReconnect();
          return;
        }
        setBanner(`Channel ${index} | Connection failed: ${_err?.message || "Unknown error"}`);
      }
    };

    window.addEventListener("viewer-settings-changed", onViewerSettingsChanged);
    connect();

    return () => {
      mounted = false;
      window.removeEventListener("viewer-settings-changed", onViewerSettingsChanged);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (statsInterval) window.clearInterval(statsInterval);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (videoFrameCallback != null && videoRef.current?.cancelVideoFrameCallback) {
        videoRef.current.cancelVideoFrameCallback(videoFrameCallback);
      }
      if (metadataChannel && metadataChannel.readyState === "open") {
        metadataChannel.close();
      }
      if (jpegChannel && jpegChannel.readyState === "open") {
        jpegChannel.close();
      }
      if (pc) pc.close();
      auxiliaryPanelRef.current?.reset();
      setTileActive(false);
    };
  }, [index, onActiveChange]);

  const transform = orientationTransform(orientation);
  const openScopeSettings = () => {
    if (typeof window.openSettingsForScope === "function") {
      window.openSettingsForScope(`channel_${index}`);
    }
  };

  return (
    <div className="video-tile" style={{ position: "relative" }} data-active={active ? "1" : "0"}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ transform: transform || undefined, visibility: jpegMode ? "hidden" : undefined }}
      />
      <canvas ref={canvasRef} style={{ transform: transform || undefined }} />
      <AuxiliaryPanel ref={auxiliaryPanelRef} channelIndex={index} />
      {!active && <div className="tile-no-video">No active video received</div>}
      <div className="tile-banner-wrapper">
        <div className="tile-banner-text">{banner}</div>
        <button className="channel-menu-button" title="Settings" onClick={openScopeSettings} type="button">
          <img src="/static/icons/menu.png" alt="Settings" className="channel-menu-icon" />
        </button>
      </div>
    </div>
  );
}

export default function ViewerApp() {
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const mode = searchParams.get("mode");
  const debug = useMemo(() => {
    if (searchParams.get("debug") === "1") return true;
    return window.localStorage.getItem("viewerDebug") === "1";
  }, [searchParams]);
  const maxChannels = useMemo(() => normalizeMaxChannels(searchParams.get("max_channels")), [searchParams]);
  const configuredChannels = useMemo(
    () => parseChannelIndices(searchParams.get("src"), maxChannels),
    [searchParams, maxChannels],
  );
  const pageSizePresets = useMemo(() => pageSizePresetsForLimit(maxChannels), [maxChannels]);

  useEffect(() => {
    if (!debug) return;
    console.log("[viewer] debug enabled", {
      href: window.location.href,
      channels: configuredChannels.slice(0, 8),
      totalChannels: configuredChannels.length,
    });
  }, [debug, configuredChannels]);

  const [visiblePerPage, setVisiblePerPage] = useState(() => {
    const raw = window.localStorage.getItem("layoutCount");
    return normalizeVisiblePerPage(raw, maxChannels);
  });
  const [currentPage, setCurrentPage] = useState(0);
  const [activeMap, setActiveMap] = useState({});
  const [pageInput, setPageInput] = useState("1");
  const [channelInput, setChannelInput] = useState("");
  const pageInputRef = useRef(null);

  useEffect(() => {
    if (mode === "light" || mode === "dark") {
      document.documentElement.setAttribute("data-theme", mode);
    }
  }, [mode]);

  const pageCount = Math.max(1, Math.ceil(configuredChannels.length / visiblePerPage));

  useEffect(() => {
    if (currentPage >= pageCount) setCurrentPage(pageCount - 1);
  }, [currentPage, pageCount]);

  useEffect(() => {
    setPageInput(`${currentPage + 1}`);
  }, [currentPage]);

  const pageChannels = useMemo(() => {
    const start = currentPage * visiblePerPage;
    return configuredChannels.slice(start, start + visiblePerPage);
  }, [configuredChannels, currentPage, visiblePerPage]);

  useEffect(() => {
    applyLayout(pageChannels.length);
  }, [pageChannels.length]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const targetTag = event.target?.tagName?.toLowerCase();
      const isTyping = targetTag === "input" || targetTag === "textarea";
      if (isTyping) return;

      if (event.key === "ArrowLeft" && currentPage > 0) {
        setCurrentPage((prev) => Math.max(0, prev - 1));
      } else if (event.key === "ArrowRight" && currentPage < pageCount - 1) {
        setCurrentPage((prev) => Math.min(pageCount - 1, prev + 1));
      } else if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        pageInputRef.current?.focus();
        pageInputRef.current?.select();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentPage, pageCount]);

  const onActiveChange = useCallback((index, active) => {
    setActiveMap((prev) => {
      if (prev[index] === active) return prev;
      return { ...prev, [index]: active };
    });
  }, []);

  const handleVisiblePerPageChange = (value) => {
    const safeCount = normalizeVisiblePerPage(value, maxChannels);
    setVisiblePerPage(safeCount);
    window.localStorage.setItem("layoutCount", `${safeCount}`);
    setCurrentPage(0);
  };

  const goToPage = (pageOneBased) => {
    const parsed = Number.parseInt(`${pageOneBased}`, 10);
    if (!Number.isInteger(parsed)) return;
    const bounded = Math.max(1, Math.min(pageCount, parsed));
    setCurrentPage(bounded - 1);
  };

  const onPageJumpSubmit = (event) => {
    event.preventDefault();
    goToPage(pageInput);
  };

  const onChannelJumpSubmit = (event) => {
    event.preventDefault();
    const channel = Number.parseInt(channelInput, 10);
    if (!Number.isInteger(channel) || channel < 0 || channel >= maxChannels) return;
    const absoluteIndex = configuredChannels.indexOf(channel);
    if (absoluteIndex < 0) return;
    setCurrentPage(Math.floor(absoluteIndex / visiblePerPage));
  };

  return (
    <>
      <div id="controls">
        <span className="page-size-label">Videos Per Page:</span>
        <div className="layout-presets">
          {pageSizePresets.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`preset-btn${visiblePerPage === preset ? " active" : ""}`}
              onClick={() => handleVisiblePerPageChange(`${preset}`)}
            >
              {preset}
            </button>
          ))}
        </div>
        <div className="pagination-controls">
          <button
            type="button"
            className="nav-btn"
            disabled={currentPage <= 0}
            onClick={() => setCurrentPage((prev) => Math.max(0, prev - 1))}
          >
            Prev
          </button>
          <span className="page-summary">
            Page {currentPage + 1} of {pageCount}
          </span>
          <button
            type="button"
            className="nav-btn"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setCurrentPage((prev) => Math.min(pageCount - 1, prev + 1))}
          >
            Next
          </button>
          <form className="jump-form" onSubmit={onPageJumpSubmit}>
            <label htmlFor="pageJumpInput">Go to</label>
            <input
              id="pageJumpInput"
              ref={pageInputRef}
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              inputMode="numeric"
              pattern="[0-9]*"
              aria-label="Go to page"
            />
          </form>
          <form className="jump-form" onSubmit={onChannelJumpSubmit}>
            <label htmlFor="channelJumpInput">Channel</label>
            <input
              id="channelJumpInput"
              value={channelInput}
              onChange={(event) => setChannelInput(event.target.value)}
              inputMode="numeric"
              pattern="[0-9]*"
              aria-label="Go to channel"
              placeholder={`0-${maxChannels - 1}`}
            />
          </form>
        </div>
      </div>

      <div id="videoGrid">
        {pageChannels.map((index) => (
          <ChannelTile key={index} index={index} onActiveChange={onActiveChange} debug={debug} />
        ))}
      </div>
    </>
  );
}
