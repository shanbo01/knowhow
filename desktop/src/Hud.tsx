import {
  Check,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { desktop } from "./ipc";
import type { AppSnapshot } from "./types";

export default function Hud() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void desktop.setHudExpanded(expanded);
  }, [expanded]);

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

  if (!snapshot) return null;
  const recorder = snapshot.recorder;
  const paused = recorder.status === "paused";
  const working = recorder.status === "finishing" || recorder.status === "uploading";
  return (
    <main className={`hud${expanded ? " expanded" : ""}`}>
      <section className="hud-pill" data-tauri-drag-region>
        <span className={`record-dot${paused ? " paused" : ""}`} />
        <div className="hud-scope" data-tauri-drag-region><strong>{paused ? "Paused" : working ? "Finishing" : "Recording"}</strong><small>{recorder.scopeLabel}</small></div>
        <span className="step-count"><Check /> {recorder.steps.length}</span>
        <button className="hud-button" disabled={busy || working} title={paused ? "Resume" : "Pause"} onClick={() => void act(paused ? desktop.resume : desktop.pause)}>{paused ? <Play /> : <Pause />}</button>
        <button className="hud-button finish" disabled={busy || working || recorder.steps.length === 0} title="Finish capture" onClick={() => void act(desktop.finish)}>{working ? <LoaderCircle className="spin" /> : <Square />}</button>
        <button className="hud-button" title="Show recent steps" onClick={() => setExpanded((open) => !open)}><ChevronDown className={expanded ? "open" : ""} /></button>
      </section>
      {expanded ? (
        <section className="hud-feed">
          <header><div><strong>Recent steps</strong><small>Delete or retry immediately</small></div><button onClick={() => setExpanded(false)}><X /></button></header>
          {recorder.statusMessage ? <p className="hud-status"><CircleAlert /> {recorder.statusMessage}</p> : null}
          <div className="hud-steps">
            {[...recorder.steps].reverse().slice(0, 8).map((step) => (
              <article key={step.id}>
                <span>{step.order + 1}</span><div><strong>{step.title}</strong><small>{step.instruction}</small></div>
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
