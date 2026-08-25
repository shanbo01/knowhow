import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  GripVertical,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "./ipc";
import type { AppSnapshot } from "./types";

export default function Hud() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [mode, setMode] = useState<"retracted" | "compact" | "expanded">("compact");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  // A step's stored image never changes after capture, so once fetched a
  // thumbnail is cached for the rest of this session. The ref is the
  // "already fetched, or fetch in flight" record the effect below checks
  // before asking the backend again; the state is only ever replaced with a
  // full copy of it, so React re-renders exactly when new thumbnails land.
  const thumbnailCache = useRef<Record<string, string>>({});
  const cachedCaptureId = useRef<string | undefined>(undefined);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  useEffect(() => {
    void desktop.setHudMode(mode);
  }, [mode]);

  useEffect(() => {
    void desktop.snapshot().then(setSnapshot);
    let dispose: (() => void) | undefined;
    void desktop.onSnapshot(setSnapshot).then((unlisten) => { dispose = unlisten; });
    return () => dispose?.();
  }, []);

  async function act(action: () => Promise<AppSnapshot>) {
    setBusy(true);
    try { setSnapshot(await action()); } finally { setBusy(false); }
  }

  const recorder = snapshot?.recorder;
  // The feed only ever shows these 8, newest first — the same ones the JSX
  // below renders — so nothing outside this set is ever fetched.
  const visibleIds = recorder ? [...recorder.steps].reverse().slice(0, 8).map((step) => step.id) : [];
  const visibleKey = visibleIds.join("|");

  useEffect(() => {
    if (recorder?.captureId !== cachedCaptureId.current) {
      cachedCaptureId.current = recorder?.captureId;
      thumbnailCache.current = {};
      setThumbnails({});
    }
    if (mode !== "expanded" || !visibleKey) return;
    const missing = visibleKey.split("|").filter((id) => !(id in thumbnailCache.current));
    if (!missing.length) return;
    let active = true;
    void Promise.all(
      missing.map(async (id) => {
        try {
          thumbnailCache.current[id] = await desktop.stepThumbnail(id);
        } catch {
          // The step may already be deleted, or the capture may have ended
          // between render and fetch; it just shows without a thumbnail.
        }
      }),
    ).then(() => {
      if (active) setThumbnails({ ...thumbnailCache.current });
    });
    return () => { active = false; };
  }, [mode, visibleKey, recorder?.captureId]);

  if (!snapshot || !recorder) return null;
  const paused = recorder.status === "paused";
  const working = recorder.status === "finishing" || recorder.status === "uploading";
  const retracted = mode === "retracted";
  const expanded = mode === "expanded";
  return (
    <main className={`hud ${mode}`}>
      <section className="hud-pill" data-tauri-drag-region>
        <span
          className="hud-grip"
          data-tauri-drag-region
          title="Drag recorder"
          onPointerDown={(event) => {
            if (event.button === 0) void getCurrentWindow().startDragging();
          }}
        ><GripVertical data-tauri-drag-region /></span>
        <span className={`record-dot${paused ? " paused" : ""}`} />
        {retracted ? <strong className="hud-mini-state" data-tauri-drag-region>{paused ? "Paused" : "Recording"}</strong> : <div className="hud-scope" data-tauri-drag-region><strong>{paused ? "Paused" : working ? "Finishing" : "Recording"}</strong><small>{recorder.scopeLabel}</small></div>}
        <span className="step-count"><Check /> {recorder.steps.length}</span>
        {retracted ? <button className="hud-button reveal" title="Expand recorder" onClick={() => setMode("compact")}><ChevronRight /></button> : <>
          <button className="hud-button" disabled={busy || working} title={paused ? "Resume" : "Pause"} onClick={() => void act(paused ? desktop.resume : desktop.pause)}>{paused ? <Play /> : <Pause />}</button>
          <button className="hud-button finish" disabled={busy || working || recorder.steps.length === 0} title="Finish capture" onClick={() => void act(desktop.finish)}>{working ? <LoaderCircle className="spin" /> : <Square />}</button>
          <button className="hud-button" title="Retract recorder" onClick={() => setMode("retracted")}><ChevronLeft /></button>
          <button className="hud-button" title={expanded ? "Hide recent steps" : "Show recent steps"} onClick={() => setMode(expanded ? "compact" : "expanded")}><ChevronDown className={expanded ? "open" : ""} /></button>
        </>}
      </section>
      {expanded ? (
        <section className="hud-feed">
          <header><div><strong>Recent steps</strong><small>Captured and privacy-processed live</small></div><button title="Close recent steps" onClick={() => setMode("compact")}><X /></button></header>
          {recorder.statusMessage ? <p className="hud-status"><CircleAlert /> {recorder.statusMessage}</p> : null}
          <div className="hud-steps">
            {[...recorder.steps].reverse().slice(0, 8).map((step) => (
              <article key={step.id}>
                <span className="hud-thumb">
                  {thumbnails[step.id] ? <img src={thumbnails[step.id]} alt="" /> : null}
                  <b>{step.order + 1}</b>
                </span>
                <div><strong>{step.title}</strong><small>{step.instruction}</small></div>
                {step.status === "retry" ? <button title="Retry" onClick={() => void act(() => desktop.retryStep(step.id))}><RotateCcw /></button> : null}
                <button title="Delete" onClick={() => void act(() => desktop.deleteStep(step.id))}><Trash2 /></button>
              </article>
            ))}
            {!recorder.steps.length ? <p className="hud-empty">Your meaningful actions will appear here.</p> : null}
          </div>
          <footer>
            {confirmDiscard ? <><span>Discard this capture?</span><button onClick={() => setConfirmDiscard(false)}>Cancel</button><button className="danger" onClick={() => void act(desktop.discard)}>Discard</button></> : <button className="discard-link" onClick={() => setConfirmDiscard(true)}><Trash2 /> Discard capture</button>}
          </footer>
        </section>
      ) : null}
    </main>
  );
}
