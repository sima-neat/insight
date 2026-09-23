import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { auxiliaryRendererRegistry, shouldAnimateAuxiliaryView } from "./auxiliaryVisualization.js";
import "./blazePose3DRenderer.js";

const VALID_MODES = new Set(["compact", "collapsed", "expanded", "hidden"]);
const drawWarnings = new Set();

function preferenceKey(channelIndex) {
  return `viewerAuxiliaryPanel_${channelIndex}`;
}

function rendererPreferenceKey(channelIndex, view) {
  return `viewerAuxiliaryRenderer_${JSON.stringify([channelIndex, view.renderer, view.id])}`;
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

function loadRendererPreference(channelIndex, view) {
  try {
    return JSON.parse(window.localStorage.getItem(rendererPreferenceKey(channelIndex, view)) || "null");
  } catch (_err) {
    return null;
  }
}

function saveRendererPreference(channelIndex, view, settings) {
  try {
    window.localStorage.setItem(rendererPreferenceKey(channelIndex, view), JSON.stringify(settings));
  } catch (_err) {
    // Renderer preferences are optional; private browsing can reject storage.
  }
}

function descriptorSignature(views) {
  return views.map((view) => `${view.id}\u0000${view.renderer}\u0000${view.title}`).join("\u0001");
}

function controlsSignature(controls) {
  return JSON.stringify(controls);
}

function pointerPosition(event) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
    pointerId: event.pointerId,
  };
}

function RendererControls({ controls, onControl }) {
  if (controls.length === 0) return null;
  return (
    <div className="auxiliary-renderer-controls" aria-label="Visualization controls">
      {controls.map((control) => {
        if (control.type === "toggle") {
          return (
            <label className="auxiliary-control-toggle" key={control.id} title={control.label}>
              <input
                type="checkbox"
                checked={Boolean(control.value)}
                disabled={Boolean(control.disabled)}
                onChange={(event) => onControl(control.id, event.target.checked)}
              />
              <span>{control.label}</span>
            </label>
          );
        }
        if (control.type === "range") {
          return (
            <label className="auxiliary-control-range" key={control.id} title={control.valueLabel ?? control.label}>
              <span>{control.label}</span>
              <input
                type="range"
                min={control.min}
                max={control.max}
                step={control.step}
                value={control.value}
                disabled={Boolean(control.disabled)}
                aria-valuetext={control.valueLabel}
                onChange={(event) => onControl(control.id, Number(event.target.value))}
              />
            </label>
          );
        }
        if (control.type === "action") {
          return (
            <button
              className="auxiliary-control-action"
              key={control.id}
              type="button"
              disabled={Boolean(control.disabled)}
              onClick={() => onControl(control.id)}
            >
              {control.label}
            </button>
          );
        }
        return null;
      })}
    </div>
  );
}

const AuxiliaryPanel = forwardRef(function AuxiliaryPanel({ channelIndex }, ref) {
  const initialPreference = useRef(loadPreference(channelIndex));
  const [mode, setMode] = useState(initialPreference.current.mode);
  const [knownViews, setKnownViews] = useState([]);
  const [selectedId, setSelectedId] = useState(initialPreference.current.selectedId);
  const [rendererControls, setRendererControls] = useState([]);
  const modeRef = useRef(mode);
  const canvasRef = useRef(null);
  const emptyRef = useRef(null);
  const payloadsRef = useRef(new Map());
  const knownViewsRef = useRef([]);
  const selectedIdRef = useRef(selectedId);
  const sessionsRef = useRef(new Map());
  const controlsSignatureRef = useRef("");
  const drawFrameRef = useRef(null);
  const scheduleDrawRef = useRef(() => {});

  const updateControls = useCallback((session) => {
    const controls = session?.getControls?.() ?? [];
    const signature = controlsSignature(controls);
    if (signature === controlsSignatureRef.current) return;
    controlsSignatureRef.current = signature;
    setRendererControls(controls);
  }, []);

  const destroySessions = useCallback((updateUi = true) => {
    for (const { session } of sessionsRef.current.values()) session.destroy?.();
    sessionsRef.current.clear();
    controlsSignatureRef.current = "";
    if (updateUi) setRendererControls([]);
  }, []);

  const getRendererSession = useCallback((view) => {
    const existing = sessionsRef.current.get(view.id);
    if (existing?.rendererName === view.renderer) return existing.session;
    existing?.session.destroy?.();

    const renderer = auxiliaryRendererRegistry.get(view.renderer);
    if (!renderer) return null;
    let session;
    if (typeof renderer.createSession === "function") {
      session = renderer.createSession({
        initialSettings: loadRendererPreference(channelIndex, view),
        onSettingsChange(settings) {
          saveRendererPreference(channelIndex, view, settings);
          if (selectedIdRef.current === view.id) {
            updateControls(sessionsRef.current.get(view.id)?.session);
          }
        },
        requestDraw() {
          scheduleDrawRef.current();
        },
      });
    } else {
      session = { draw: (...args) => renderer.draw(...args) };
    }
    if (!session || typeof session.draw !== "function") return null;
    sessionsRef.current.set(view.id, { rendererName: view.renderer, session });
    return session;
  }, [channelIndex, updateControls]);

  const drawCurrent = useCallback((animationTimeMs) => {
    const canvas = canvasRef.current;
    if (!canvas || mode === "collapsed" || mode === "hidden") return false;
    const cssWidth = Math.max(0, canvas.clientWidth);
    const cssHeight = Math.max(0, canvas.clientHeight);
    if (cssWidth === 0 || cssHeight === 0) return false;

    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.round(cssWidth * pixelRatio);
    const height = Math.round(cssHeight * pixelRatio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const current = payloadsRef.current.get(selectedIdRef.current);
    if (emptyRef.current) emptyRef.current.hidden = Boolean(current);
    if (!current) return false;
    const session = getRendererSession(current);
    if (!session) return false;
    updateControls(session);

    ctx.save();
    try {
      session.draw(ctx, { width: cssWidth, height: cssHeight }, current.payload, {
        channelIndex,
        frameId: current.frameId,
        rtpTimestamp: current.rtpTimestamp,
        animationTimeMs,
      });
    } catch (error) {
      const warningKey = `${channelIndex}:${current.renderer}`;
      if (!drawWarnings.has(warningKey)) {
        drawWarnings.add(warningKey);
        console.warn(`auxiliary: channel ${channelIndex} failed to draw ${current.renderer}`, error);
      }
      return false;
    } finally {
      ctx.restore();
    }
    return shouldAnimateAuxiliaryView(mode, true, session);
  }, [channelIndex, getRendererSession, mode, updateControls]);

  const scheduleDraw = useCallback(() => {
    if (modeRef.current === "collapsed" || modeRef.current === "hidden") return;
    if (drawFrameRef.current != null) return;
    drawFrameRef.current = requestAnimationFrame((animationTimeMs) => {
      drawFrameRef.current = null;
      if (drawCurrent(animationTimeMs)) scheduleDrawRef.current();
    });
  }, [drawCurrent]);
  scheduleDrawRef.current = scheduleDraw;

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
      destroySessions();
      scheduleDraw();
    },
  }), [destroySessions, scheduleDraw]);

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
    destroySessions(false);
  }, [destroySessions]);

  const currentSession = () => {
    const current = payloadsRef.current.get(selectedIdRef.current);
    return current ? getRendererSession(current) : null;
  };
  const applyRendererControl = (controlId, value) => {
    const session = currentSession();
    session?.applyControl?.(controlId, value);
    updateControls(session);
    scheduleDraw();
  };
  const onPointerDown = (event) => {
    const session = currentSession();
    if (!session?.pointerDown?.(pointerPosition(event))) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateControls(session);
  };
  const onPointerMove = (event) => {
    const session = currentSession();
    if (session?.pointerMove?.(pointerPosition(event))) updateControls(session);
  };
  const endPointer = (event) => {
    const session = currentSession();
    if (session?.pointerUp?.(pointerPosition(event))) updateControls(session);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const hasViews = knownViews.length > 0;
  const selected = knownViews.find((view) => view.id === selectedId) ?? knownViews[0];
  const selectView = (viewId) => {
    if (selectedIdRef.current !== viewId) {
      const previous = sessionsRef.current.get(selectedIdRef.current);
      previous?.session.destroy?.();
      sessionsRef.current.delete(selectedIdRef.current);
    }
    selectedIdRef.current = viewId;
    controlsSignatureRef.current = "";
    setRendererControls([]);
    setSelectedId(viewId);
    scheduleDraw();
  };
  const setPanelMode = (nextMode) => {
    if (!VALID_MODES.has(nextMode)) return;
    modeRef.current = nextMode;
    if (nextMode === "collapsed" || nextMode === "hidden") {
      if (drawFrameRef.current != null) {
        cancelAnimationFrame(drawFrameRef.current);
        drawFrameRef.current = null;
      }
      const current = sessionsRef.current.get(selectedIdRef.current);
      current?.session.destroy?.();
      sessionsRef.current.delete(selectedIdRef.current);
      controlsSignatureRef.current = "";
      setRendererControls([]);
    }
    setMode(nextMode);
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
                      onClick={() => selectView(view.id)}
                    >
                      {view.title}
                    </button>
                  ))}
                </div>
              )}
              <div className="auxiliary-panel-content">
                <canvas
                  ref={canvasRef}
                  aria-label="Interactive auxiliary visualization"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={endPointer}
                  onPointerCancel={endPointer}
                />
                <div ref={emptyRef} className="auxiliary-panel-no-data">
                  No data for this frame
                </div>
              </div>
              <RendererControls controls={rendererControls} onControl={applyRendererControl} />
            </>
          )}
        </>
      )}
    </div>
  );
});

export default AuxiliaryPanel;
