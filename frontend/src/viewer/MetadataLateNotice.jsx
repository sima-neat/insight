import { useEffect, useRef, useState } from "react";

const BLOCKED_TEXT = {
  maximum: "The buffer needed exceeds the 4000 ms maximum. The application must send metadata sooner.",
  unsupported: "This browser cannot delay video; overlays cannot be synchronized.",
};

function formatLateness(latenessMs) {
  return latenessMs == null ? "more than 5 s" : `~${latenessMs} ms`;
}

export default function MetadataLateNotice({ details, onRaise }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const visible = Boolean(details);

  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!details) return null;

  const raise = (target) => {
    if (onRaise(details.suggestedBufferMs, target)) setOpen(false);
  };

  return (
    <div className="metadata-late-notice" ref={rootRef}>
      <button
        type="button"
        className="metadata-late-chip"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((previous) => !previous)}
      >
        <span aria-hidden="true">{"⚠︎"}</span> Metadata late
      </button>
      {open && (
        <div className="metadata-late-panel" role="dialog" aria-label="Metadata late">
          <div className="metadata-late-title">Overlays are being dropped</div>
          <div>Metadata arrives after its video frame was already shown.</div>
          <dl className="metadata-late-values">
            <dt>Arrives after its frame</dt>
            <dd>{formatLateness(details.latenessMs)}</dd>
            <dt>Video sync buffer</dt>
            <dd>{details.bufferMs} ms</dd>
            <dt>Late messages</dt>
            <dd>{details.latePercent == null ? "—" : `${details.latePercent} %`}</dd>
          </dl>
          {details.blockedBy ? (
            <div className="metadata-late-blocked">{BLOCKED_TEXT[details.blockedBy]}</div>
          ) : (
            <div className="metadata-late-actions">
              <button type="button" className="metadata-late-action" onClick={() => raise("channel")}>
                <span>Raise for this channel to {details.suggestedBufferMs} ms</span>
                <span className="metadata-late-action-sub">Other channels keep their setting.</span>
              </button>
              {details.globalAction && (
                // Both kinds pass the suggestion; the resolver decides what is written.
                <button
                  type="button"
                  className="metadata-late-action metadata-late-action--secondary"
                  onClick={() => raise("global")}
                >
                  {details.globalAction.kind === "follow" ? (
                    <>
                      <span>Use global value ({details.globalAction.valueMs} ms)</span>
                      <span className="metadata-late-action-sub">Removes this channel's own value.</span>
                    </>
                  ) : (
                    <>
                      <span>Raise globally to {details.globalAction.valueMs} ms</span>
                      <span className="metadata-late-action-sub">Applies to every channel without its own value.</span>
                    </>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
