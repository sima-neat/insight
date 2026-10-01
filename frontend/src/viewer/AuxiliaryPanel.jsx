import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import {
  auxiliaryRendererRegistry,
  createAuxiliaryViewPreference,
  initialAuxiliarySessionSettings,
  nextAuxiliaryPreview,
  reconcileAuxiliaryPanelMode,
  restoreAuxiliaryViewPreference,
  retainAuxiliaryViews,
  routeAuxiliarySettingsEvent,
} from "./auxiliaryVisualization.js";

const VALID_MODES = new Set(["compact", "collapsed", "expanded", "hidden"]);
const MAX_CANVAS_PIXEL_RATIO = 2;
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
  } catch (_err) {}
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
    const renderer = auxiliaryRendererRegistry.get(view.renderer);
    const toSession = renderer?.viewerSettings?.toSession;
    const preference = typeof toSession === "function"
      ? createAuxiliaryViewPreference(
        toSession(resolveRendererSettings(channelIndex, view.renderer)),
        settings,
      )
      : settings;
    window.localStorage.setItem(rendererPreferenceKey(channelIndex, view), JSON.stringify(preference));
  } catch (_err) {}
}

function resolveRendererSettings(channelIndex, renderer) {
  if (!renderer) return { enabled: true, panelMode: "compact" };
  const resolved = window.viewerSettingsApi?.resolveAuxiliarySettings?.(channelIndex, renderer);
  return {
    enabled: resolved?.enabled !== false,
    panelMode: VALID_MODES.has(resolved?.panelMode) && resolved.panelMode !== "hidden"
      ? resolved.panelMode
      : "compact",
    ...(resolved || {}),
  };
}

function hasExplicitRendererSettings(channelIndex, renderer) {
  if (!renderer) return false;
  try {
    return ["global", `channel_${channelIndex}`].some((scope) => {
      const raw = JSON.parse(window.localStorage.getItem(`viewerSettings_${scope}`) || "null");
      return raw?.auxiliary?.[renderer] && typeof raw.auxiliary[renderer] === "object";
    });
  } catch (_err) {
    return false;
  }
}

function displayMode(settings) {
  return settings.enabled === false ? "hidden" : settings.panelMode;
}

function panelSurfaceOpacity(settings) {
  const transparency = Number(settings?.backgroundTransparency);
  return 1 - Math.max(0, Math.min(1, Number.isFinite(transparency) ? transparency : 0));
}

function rendererForSelection(selectedId, payloads, knownViews) {
  return payloads.get(selectedId)?.renderer
    ?? knownViews.find((view) => view.id === selectedId)?.renderer
    ?? knownViews[0]?.renderer
    ?? null;
}

function settingsForSession(channelIndex, view) {
  const stored = loadRendererPreference(channelIndex, view);
  const renderer = auxiliaryRendererRegistry.get(view.renderer);
  const toSession = renderer?.viewerSettings?.toSession;
  if (typeof toSession !== "function") return stored;
  return restoreAuxiliaryViewPreference(
    toSession(resolveRendererSettings(channelIndex, view.renderer)),
    stored,
    !hasExplicitRendererSettings(channelIndex, view.renderer),
  );
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
            <label
              className="auxiliary-control-toggle"
              data-control-id={control.id}
              key={control.id}
              title={control.label}
            >
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
        if (control.type === "action") {
          return (
            <button
              className="auxiliary-control-action"
              data-control-id={control.id}
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
  const initialRendererSettings = useRef(resolveRendererSettings(channelIndex, null));
  const [mode, setMode] = useState(() => {
    const resolvedMode = displayMode(initialRendererSettings.current);
    const stored = initialPreference.current.mode;
    return resolvedMode === "compact" && stored !== "compact"
      ? stored
      : resolvedMode;
  });
  const [knownViews, setKnownViews] = useState([]);
  const [selectedId, setSelectedId] = useState(initialPreference.current.selectedId);
  const [rendererControls, setRendererControls] = useState([]);
  const [surfaceOpacity, setSurfaceOpacity] = useState(1);
  const modeRef = useRef(mode);
  const canvasRef = useRef(null);
  const payloadsRef = useRef(new Map());
  const lastViewAtRef = useRef(new Map());
  const knownViewsRef = useRef([]);
  const selectedIdRef = useRef(selectedId);
  const sessionsRef = useRef(new Map());
  const previewSettingsRef = useRef(null);
  const controlsSignatureRef = useRef("");
  const drawFrameRef = useRef(null);
  const scheduleDrawRef = useRef(() => {});

  const effectiveRendererSettings = useCallback((renderer) => {
    const resolved = resolveRendererSettings(channelIndex, renderer);
    const preview = previewSettingsRef.current;
    if (!preview || preview.renderer !== renderer) return resolved;
    return { ...resolved, ...preview.settings };
  }, [channelIndex]);

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

  const suspendPanel = useCallback(() => {
    if (drawFrameRef.current != null) {
      cancelAnimationFrame(drawFrameRef.current);
      drawFrameRef.current = null;
    }
    destroySessions();
  }, [destroySessions]);

  const getRendererSession = useCallback((view) => {
    const existing = sessionsRef.current.get(view.id);
    if (existing?.rendererName === view.renderer) return existing.session;
    existing?.session.destroy?.();

    const renderer = auxiliaryRendererRegistry.get(view.renderer);
    if (!renderer) return null;
    let session;
    if (typeof renderer.createSession === "function") {
      const toSession = renderer.viewerSettings?.toSession;
      const initialSettings = initialAuxiliarySessionSettings(
        settingsForSession(channelIndex, view),
        effectiveRendererSettings(view.renderer),
        toSession,
        previewSettingsRef.current?.renderer === view.renderer,
      );
      session = renderer.createSession({
        initialSettings,
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
  }, [channelIndex, effectiveRendererSettings, updateControls]);

  const drawCurrent = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || mode === "collapsed" || mode === "hidden") return;
    const cssWidth = Math.max(0, canvas.clientWidth);
    const cssHeight = Math.max(0, canvas.clientHeight);
    if (cssWidth === 0 || cssHeight === 0) return;

    const pixelRatio = Math.min(MAX_CANVAS_PIXEL_RATIO, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.round(cssWidth * pixelRatio);
    const height = Math.round(cssHeight * pixelRatio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const current = payloadsRef.current.get(selectedIdRef.current);
    if (!current) return;
    const session = getRendererSession(current);
    if (!session) return;
    updateControls(session);

    ctx.save();
    try {
      session.draw(ctx, { width: cssWidth, height: cssHeight }, current.payload, {
        channelIndex,
        frameId: current.frameId,
        rtpTimestamp: current.rtpTimestamp,
        settings: effectiveRendererSettings(current.renderer),
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
  }, [channelIndex, effectiveRendererSettings, getRendererSession, mode, updateControls]);

  const scheduleDraw = useCallback(() => {
    if (modeRef.current === "collapsed" || modeRef.current === "hidden") return;
    if (drawFrameRef.current != null) return;
    drawFrameRef.current = requestAnimationFrame(() => {
      drawFrameRef.current = null;
      drawCurrent();
    });
  }, [drawCurrent]);
  scheduleDrawRef.current = scheduleDraw;

  const clear = useCallback(() => {
    payloadsRef.current = new Map();
    lastViewAtRef.current = new Map();
    knownViewsRef.current = [];
    setKnownViews([]);
    destroySessions();
    scheduleDraw();
  }, [destroySessions, scheduleDraw]);

  useImperativeHandle(ref, () => ({
    showFrame(views) {
      const now = performance.now();
      const retained = retainAuxiliaryViews(
        payloadsRef.current,
        views,
        lastViewAtRef.current,
        now,
      );
      payloadsRef.current = retained.views;
      lastViewAtRef.current = retained.lastSeenById;
      const nextKnown = [...retained.views.values()].map((view) => ({
        id: view.id,
        renderer: view.renderer,
        title: view.title,
      }));
      const knownIds = new Set(nextKnown.map((view) => view.id));
      for (const [viewId, entry] of sessionsRef.current) {
        if (knownIds.has(viewId)) continue;
        entry.session.destroy?.();
        sessionsRef.current.delete(viewId);
      }
      if (descriptorSignature(nextKnown) !== descriptorSignature(knownViewsRef.current)) {
        knownViewsRef.current = nextKnown;
        setKnownViews(nextKnown);
      }
      if (nextKnown.length > 0) {
        if (!selectedIdRef.current || !knownIds.has(selectedIdRef.current)) {
          selectedIdRef.current = nextKnown[0].id;
          setSelectedId(nextKnown[0].id);
        }
        const renderer = rendererForSelection(selectedIdRef.current, payloadsRef.current, nextKnown);
        const rendererSettings = effectiveRendererSettings(renderer);
        const nextMode = reconcileAuxiliaryPanelMode(
          modeRef.current,
          rendererSettings,
          hasExplicitRendererSettings(channelIndex, renderer),
        );
        if (nextMode !== modeRef.current) {
          modeRef.current = nextMode;
          setMode(nextMode);
        }
        setSurfaceOpacity(panelSurfaceOpacity(rendererSettings));
      }
      scheduleDraw();
    },
    clearFrame: clear,
    reset: clear,
  }), [channelIndex, clear, effectiveRendererSettings, scheduleDraw]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    savePreference(channelIndex, mode, selectedId);
    scheduleDraw();
  }, [channelIndex, mode, scheduleDraw, selectedId]);

  useEffect(() => {
    const refreshSettings = (event) => {
      const changedScope = event?.detail?.scope;
      if (changedScope && changedScope !== "global" && changedScope !== `channel_${channelIndex}`) return;
      const renderer = rendererForSelection(
        selectedIdRef.current,
        payloadsRef.current,
        knownViewsRef.current,
      );
      const changedRenderer = event?.detail?.auxiliaryRenderer;
      const routing = routeAuxiliarySettingsEvent(
        event?.type,
        changedRenderer,
        renderer,
        previewSettingsRef.current?.renderer,
      );
      previewSettingsRef.current = nextAuxiliaryPreview(
        previewSettingsRef.current,
        routing,
        changedRenderer ?? renderer,
        event?.detail?.auxiliarySettings || {},
      );
      if (!routing.appliesToSelection) return;

      const isPreview = routing.isPreview;
      const resolved = effectiveRendererSettings(renderer);
      const nextMode = displayMode(resolved);
      modeRef.current = nextMode;
      setMode(nextMode);
      setSurfaceOpacity(panelSurfaceOpacity(resolved));
      if (nextMode === "collapsed" || nextMode === "hidden") suspendPanel();
      const current = sessionsRef.current.get(selectedIdRef.current)?.session;
      const toSession = auxiliaryRendererRegistry.get(renderer)?.viewerSettings?.toSession;
      if (typeof toSession === "function") {
        const view = payloadsRef.current.get(selectedIdRef.current)
          ?? knownViewsRef.current.find(({ id }) => id === selectedIdRef.current);
        current?.applySettings?.(
          isPreview || !view ? toSession(resolved) : settingsForSession(channelIndex, view),
        );
      }
      updateControls(current);
      scheduleDraw();
    };
    window.addEventListener("viewer-settings-changed", refreshSettings);
    window.addEventListener("viewer-settings-preview", refreshSettings);
    return () => {
      window.removeEventListener("viewer-settings-changed", refreshSettings);
      window.removeEventListener("viewer-settings-preview", refreshSettings);
    };
  }, [channelIndex, effectiveRendererSettings, scheduleDraw, suspendPanel, updateControls]);

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
    const renderer = knownViewsRef.current.find((view) => view.id === viewId)?.renderer;
    const rendererSettings = effectiveRendererSettings(renderer);
    const nextMode = reconcileAuxiliaryPanelMode(
      modeRef.current,
      rendererSettings,
      hasExplicitRendererSettings(channelIndex, renderer),
    );
    modeRef.current = nextMode;
    setMode(nextMode);
    setSurfaceOpacity(panelSurfaceOpacity(rendererSettings));
    scheduleDraw();
  };
  const setPanelMode = (nextMode) => {
    if (!VALID_MODES.has(nextMode)) return;
    const renderer = selected?.renderer;
    const settingsApi = window.viewerSettingsApi;
    if (renderer && settingsApi?.writeScopeAuxiliarySettings) {
      const targetScope = `channel_${channelIndex}`;
      settingsApi.writeScopeAuxiliarySettings(targetScope, renderer, {
        enabled: nextMode !== "hidden",
        ...(nextMode === "hidden" ? {} : { panelMode: nextMode }),
      });
      window.dispatchEvent(new CustomEvent("viewer-settings-changed", {
        detail: { scope: targetScope, auxiliaryRenderer: renderer },
      }));
    }
    modeRef.current = nextMode;
    if (nextMode === "collapsed" || nextMode === "hidden") suspendPanel();
    setMode(nextMode);
  };

  return (
    <div
      className={`auxiliary-panel auxiliary-panel-${mode}${hasViews ? "" : " auxiliary-panel-empty"}`}
      style={{ "--auxiliary-surface-opacity": surfaceOpacity }}
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
