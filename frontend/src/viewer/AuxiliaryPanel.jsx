import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { auxiliaryRendererRegistry } from "./auxiliaryVisualization.js";
import "./blazePose3DRenderer.js";

const VALID_MODES = new Set(["compact", "collapsed", "expanded", "hidden"]);
const drawWarnings = new Set();

function preferenceKey(channelIndex) {
  return `viewerAuxiliaryPanel_${channelIndex}`;
}

function loadPreference(channelIndex) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(preferenceKey(channelIndex)) || "null");
    return {
      mode: VALID_MODES.has(parsed?.mode) ? parsed.mode : "compact",
      selectedId: typeof parsed?.selectedId === "string" ? parsed.selectedId : null,
    };
  } catch (_err) {
    return { mode: "compact", selectedId: null };
  }
}

function savePreference(channelIndex, mode, selectedId) {
  try {
    window.localStorage.setItem(preferenceKey(channelIndex), JSON.stringify({ mode, selectedId }));
  } catch (_err) {
    // Viewer preferences are optional; private browsing can reject storage.
  }
}

function descriptorSignature(views) {
  return views.map((view) => `${view.id}\u0000${view.renderer}\u0000${view.title}`).join("\u0001");
}

const AuxiliaryPanel = forwardRef(function AuxiliaryPanel({ channelIndex }, ref) {
  const initialPreference = useRef(loadPreference(channelIndex));
  const [mode, setMode] = useState(initialPreference.current.mode);
  const [knownViews, setKnownViews] = useState([]);
  const [selectedId, setSelectedId] = useState(initialPreference.current.selectedId);
  const canvasRef = useRef(null);
  const emptyRef = useRef(null);
  const payloadsRef = useRef(new Map());
  const knownViewsRef = useRef([]);
  const selectedIdRef = useRef(selectedId);
  const drawFrameRef = useRef(null);

  const drawCurrent = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || mode === "collapsed" || mode === "hidden") return;
    const cssWidth = Math.max(0, canvas.clientWidth);
    const cssHeight = Math.max(0, canvas.clientHeight);
    if (cssWidth === 0 || cssHeight === 0) return;

    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.round(cssWidth * pixelRatio);
    const height = Math.round(cssHeight * pixelRatio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const current = payloadsRef.current.get(selectedIdRef.current);
    if (emptyRef.current) emptyRef.current.hidden = Boolean(current);
    if (!current) return;
    const renderer = auxiliaryRendererRegistry.get(current.renderer);
    if (!renderer) return;

    ctx.save();
    try {
      renderer.draw(ctx, { width: cssWidth, height: cssHeight }, current.payload, {
        channelIndex,
        frameId: current.frameId,
        rtpTimestamp: current.rtpTimestamp,
      });
    } catch (error) {
      const warningKey = `${channelIndex}:${current.renderer}`;
      if (!drawWarnings.has(warningKey)) {
        drawWarnings.add(warningKey);
        console.warn(`auxiliary: channel ${channelIndex} failed to draw ${current.renderer}`, error);
      }
    } finally {
      ctx.restore();
    }
  }, [channelIndex, mode]);

  const scheduleDraw = useCallback(() => {
    if (drawFrameRef.current != null) cancelAnimationFrame(drawFrameRef.current);
    drawFrameRef.current = requestAnimationFrame(() => {
      drawFrameRef.current = null;
      drawCurrent();
    });
  }, [drawCurrent]);

  useImperativeHandle(ref, () => ({
    showFrame(views) {
      payloadsRef.current = new Map(views.map((view) => [view.id, view]));
      if (views.length > 0) {
        const byId = new Map(knownViewsRef.current.map((view) => [view.id, view]));
        for (const view of views) {
          byId.set(view.id, { id: view.id, renderer: view.renderer, title: view.title });
        }
        const nextKnown = [...byId.values()];
        if (descriptorSignature(nextKnown) !== descriptorSignature(knownViewsRef.current)) {
          knownViewsRef.current = nextKnown;
          setKnownViews(nextKnown);
        }
        if (!selectedIdRef.current || !byId.has(selectedIdRef.current)) {
          selectedIdRef.current = views[0].id;
          setSelectedId(views[0].id);
        }
      }
      scheduleDraw();
    },
    clearFrame() {
      payloadsRef.current = new Map();
      scheduleDraw();
    },
    reset() {
      payloadsRef.current = new Map();
      knownViewsRef.current = [];
      setKnownViews([]);
      scheduleDraw();
    },
  }), [scheduleDraw]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    savePreference(channelIndex, mode, selectedId);
    scheduleDraw();
  }, [channelIndex, mode, scheduleDraw, selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [scheduleDraw]);

  useEffect(() => () => {
    if (drawFrameRef.current != null) cancelAnimationFrame(drawFrameRef.current);
  }, []);

  const hasViews = knownViews.length > 0;
  const selected = knownViews.find((view) => view.id === selectedId) ?? knownViews[0];
  const setPanelMode = (nextMode) => {
    if (VALID_MODES.has(nextMode)) setMode(nextMode);
  };

  return (
    <div
      className={`auxiliary-panel auxiliary-panel-${mode}${hasViews ? "" : " auxiliary-panel-empty"}`}
      aria-hidden={!hasViews}
      data-channel={channelIndex}
    >
      {mode === "hidden" ? (
        <button
          className="auxiliary-restore-button"
          type="button"
          onClick={() => setPanelMode("compact")}
          title="Show auxiliary visualization"
        >
          Aux
        </button>
      ) : (
        <>
          <div className="auxiliary-panel-header">
            <span className="auxiliary-panel-title">{selected?.title ?? "Auxiliary"}</span>
            <span className="auxiliary-panel-actions">
              <button
                type="button"
                title={mode === "collapsed" ? "Show panel" : "Collapse panel"}
                aria-label={mode === "collapsed" ? "Show auxiliary panel" : "Collapse auxiliary panel"}
                onClick={() => setPanelMode(mode === "collapsed" ? "compact" : "collapsed")}
              >
                {mode === "collapsed" ? "+" : "−"}
              </button>
              <button
                type="button"
                title={mode === "expanded" ? "Restore panel size" : "Expand panel"}
                aria-label={mode === "expanded" ? "Restore auxiliary panel size" : "Expand auxiliary panel"}
                onClick={() => setPanelMode(mode === "expanded" ? "compact" : "expanded")}
              >
                {mode === "expanded" ? "↙" : "↗"}
              </button>
              <button
                type="button"
                title="Hide panel"
                aria-label="Hide auxiliary panel"
                onClick={() => setPanelMode("hidden")}
              >
                ×
              </button>
            </span>
          </div>
          {mode !== "collapsed" && (
            <>
              {knownViews.length > 1 && (
                <div className="auxiliary-panel-tabs" role="tablist" aria-label="Auxiliary visualizations">
                  {knownViews.map((view) => (
                    <button
                      key={view.id}
                      type="button"
                      role="tab"
                      aria-selected={view.id === selected?.id}
                      className={view.id === selected?.id ? "active" : ""}
                      onClick={() => setSelectedId(view.id)}
                    >
                      {view.title}
                    </button>
                  ))}
                </div>
              )}
              <div className="auxiliary-panel-content">
                <canvas ref={canvasRef} />
                <div ref={emptyRef} className="auxiliary-panel-no-data">
                  No data for this frame
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
});

export default AuxiliaryPanel;
