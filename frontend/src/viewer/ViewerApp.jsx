import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MAX_CHANNELS = 80;
const MAX_VIDEOS_PER_PAGE = 80;
const DEFAULT_VISIBLE_PER_PAGE = 4;
const PAGE_SIZE_PRESETS = [1, 4, 9, 16, 40, 80];
const METADATA_QUEUE_HARD_LIMIT = 300;
const METADATA_QUEUE_SOFT_LIMIT = 20;
const RECONNECT_DELAY_MS = 5000;
const STREAM_STALE_MS = 1800;

function parseIndices(srcParam) {
  if (!srcParam) {
    return Array.from({ length: MAX_CHANNELS }, (_, i) => i);
  }
  const seen = new Set();
  srcParam
    .split(",")
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < MAX_CHANNELS)
    .forEach((value) => seen.add(value));
  return Array.from(seen).sort((a, b) => a - b);
}

function getMetadataDelayMs() {
  try {
    const settings = JSON.parse(window.localStorage.getItem("viewerSettings_global") || "{}");
    if (typeof settings.metadataDelay === "number") return settings.metadataDelay;
  } catch (_err) {
    // Use default.
  }
  return 0;
}

function chooseMetadataCandidate(queue, metadataDelayMs) {
  if (!queue.length) return null;
  if (metadataDelayMs <= 0) return queue[queue.length - 1];
  const now = performance.now();
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const item = queue[i];
    if (now - item.timestamp >= metadataDelayMs) return item;
  }
  return null;
}

function applyLayout(count) {
  const grid = document.getElementById("videoGrid");
  if (!grid) return;

  if (count <= 0) {
    grid.style.gridTemplateColumns = "1fr";
    grid.style.gridTemplateRows = "1fr";
    document.body.classList.remove("single-tile");
    return;
  }

  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  document.body.classList.toggle("single-tile", count === 1);
}

function ChannelTile({ index, onActiveChange, debug }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const metadataQueueRef = useRef([]);
  const rtcpRef = useRef({
    lastBytes: null,
    lastTs: null,
    messageCount: 0,
    lastCount: 0,
    lastFramesDecoded: null,
  });
  const playbackRef = useRef({ lastFrameAt: 0 });
  const activeRef = useRef(false);
  const [banner, setBanner] = useState(`Channel ${index}`);
  const [active, setActive] = useState(false);

  useEffect(() => {
    let mounted = true;
    let pc = null;
    let metadataChannel = null;
    let animationFrame = null;
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
      metadataQueueRef.current = [];
      rtcpRef.current = {
        lastBytes: null,
        lastTs: null,
        messageCount: 0,
        lastCount: 0,
        lastFramesDecoded: null,
      };
      playbackRef.current = { lastFrameAt: 0 };
      const metadataDelayMs = getMetadataDelayMs();
      debugLog("connect start", { metadataDelayMs });

      pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.addTransceiver("video", { direction: "recvonly" });
      metadataChannel = pc.createDataChannel("metadata");
      debugLog("pc created");

      metadataChannel.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          const queue = metadataQueueRef.current;
          queue.push({ timestamp: performance.now(), data: parsed, rendered: false });
          rtcpRef.current.messageCount += 1;
          if (queue.length > METADATA_QUEUE_HARD_LIMIT) {
            queue.splice(0, queue.length - METADATA_QUEUE_SOFT_LIMIT);
          }
        } catch (_err) {
          // Ignore malformed data channel payloads.
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

      const draw = () => {
        if (!mounted || !canvasRef.current || !videoRef.current) return;
        const canvas = canvasRef.current;
        const video = videoRef.current;
        const queue = metadataQueueRef.current;
        const ctx = canvas.getContext("2d");

        if (video.readyState >= 2) {
          const now = Date.now();
          if (
            playbackRef.current.lastFrameAt > 0 &&
            now - playbackRef.current.lastFrameAt <= STREAM_STALE_MS
          ) {
            setTileActive(true);
          } else {
            setTileActive(false);
          }

          if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientHeight;
          }

          if (ctx) {
            // Always clear overlay to avoid stale masks/opaque leftovers.
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const candidate = chooseMetadataCandidate(queue, metadataDelayMs);
            if (candidate) {
              const strategy = window.drawStrategies?.[candidate.data?.type];
              if (strategy) {
                strategy(ctx, canvas, candidate.data?.data, video, index);
                candidate.rendered = true;
              }
            }
          }
        } else if (ctx && canvas.width > 0 && canvas.height > 0) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }

        while (queue.length > 0 && queue[0].rendered) queue.shift();
        animationFrame = requestAnimationFrame(draw);
      };

      draw();

      statsInterval = window.setInterval(async () => {
        if (!mounted || !pc || pc.connectionState !== "connected") return;
        try {
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type !== "inbound-rtp" || report.kind !== "video") return;

            const fps = report.framesPerSecond?.toFixed(1) ?? "N/A";
            const width = report.frameWidth ?? "?";
            const height = report.frameHeight ?? "?";

            const tracker = rtcpRef.current;
            const hasPreviousSample = tracker.lastBytes != null && tracker.lastTs != null;
            const deltaBytes = hasPreviousSample ? report.bytesReceived - tracker.lastBytes : 0;
            const deltaTime = hasPreviousSample ? (report.timestamp - tracker.lastTs) / 1000 : 0;
            const bitrateBps = deltaTime > 0 ? (deltaBytes * 8) / deltaTime : 0;
            const bitrate = (bitrateBps / 1000).toFixed(1);
            if (
              typeof report.framesDecoded === "number" &&
              (tracker.lastFramesDecoded == null || report.framesDecoded > tracker.lastFramesDecoded)
            ) {
              playbackRef.current.lastFrameAt = Date.now();
              setTileActive(true);
            }
            setBanner(
              `Channel ${index} | ${width}x${height} | ${fps} fps | ${bitrate} kbps | ${tracker.lastCount} msgs/sec`
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

            if (metadataChannel?.readyState === "open") {
              const video = videoRef.current;
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
                  inbound_rtp: {
                    bytes_received: report.bytesReceived,
                    packets_received: report.packetsReceived,
                    packets_lost: report.packetsLost,
                    frames_received: report.framesReceived,
                    frames_decoded: report.framesDecoded,
                    frames_dropped: report.framesDropped,
                    frames_per_second: report.framesPerSecond,
                    frame_width: report.frameWidth,
                    frame_height: report.frameHeight,
                    freeze_count: report.freezeCount,
                    pause_count: report.pauseCount,
                    bitrate_bps: Number(bitrateBps.toFixed(1)),
                  },
                  video: {
                    ready_state: video?.readyState ?? 0,
                    paused: video?.paused ?? true,
                    current_time: video?.currentTime ?? 0,
                    video_width: video?.videoWidth,
                    video_height: video?.videoHeight,
                    last_frame_age_ms: lastFrameAgeMs,
                    active: activeRef.current,
                  },
                  data_channel: {
                    state: metadataChannel.readyState,
                    metadata_messages_per_sec: tracker.lastCount,
                  },
                })
              );
            }

            tracker.lastBytes = report.bytesReceived;
            tracker.lastTs = report.timestamp;
            tracker.lastFramesDecoded = report.framesDecoded ?? tracker.lastFramesDecoded;
            tracker.lastCount = tracker.messageCount;
            tracker.messageCount = 0;
          });
        } catch (_err) {
          // Ignore getStats failures for transient states.
        }
      }, 1000);

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const response = await fetch(`/offer?channel=${index}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(offer),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const answer = await response.json();
        if (!mounted || sessionId !== currentSession) return;
        await pc.setRemoteDescription(answer);
        debugLog("setRemoteDescription ok");
      } catch (_err) {
        if (!mounted) return;
        debugLog("connect error", _err?.message || _err);
        scheduleReconnect();
      }
    };

    connect();

    return () => {
      mounted = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (statsInterval) window.clearInterval(statsInterval);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (metadataChannel && metadataChannel.readyState === "open") {
        metadataChannel.close();
      }
      if (pc) pc.close();
      setTileActive(false);
    };
  }, [index, onActiveChange]);

  const openScopeSettings = () => {
    if (typeof window.openSettingsForScope === "function") {
      window.openSettingsForScope(`channel_${index}`);
    }
  };

  return (
    <div className="video-tile" style={{ position: "relative" }} data-active={active ? "1" : "0"}>
      <video ref={videoRef} autoPlay playsInline muted />
      <canvas ref={canvasRef} />
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
  const configuredChannels = useMemo(() => parseIndices(searchParams.get("src")), [searchParams]);

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
    const parsed = Number.parseInt(raw || `${DEFAULT_VISIBLE_PER_PAGE}`, 10);
    return Number.isNaN(parsed) ? DEFAULT_VISIBLE_PER_PAGE : Math.max(1, Math.min(MAX_VIDEOS_PER_PAGE, parsed));
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
    const count = Number.parseInt(value, 10);
    const safeCount = Number.isNaN(count) ? DEFAULT_VISIBLE_PER_PAGE : Math.max(1, Math.min(MAX_VIDEOS_PER_PAGE, count));
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
    if (!Number.isInteger(channel) || channel < 0 || channel >= MAX_CHANNELS) return;
    const absoluteIndex = configuredChannels.indexOf(channel);
    if (absoluteIndex < 0) return;
    setCurrentPage(Math.floor(absoluteIndex / visiblePerPage));
  };

  return (
    <>
      <div id="controls">
        <span className="page-size-label">Videos Per Page:</span>
        <div className="layout-presets">
          {PAGE_SIZE_PRESETS.map((preset) => (
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
              placeholder="0-79"
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
