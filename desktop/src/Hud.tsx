import {
  Check,
  GripVertical,
  LoaderCircle,
  Pause,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "./ipc";
import type { AppSnapshot } from "./types";

export default function Hud() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void desktop.snapshot().then(setSnapshot);
    let dispose: (() => void) | undefined;
    void desktop.onSnapshot(setSnapshot).then((unlisten) => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, []);

  // A rejected command used to be swallowed here, which left the bar looking
  // like nothing had happened. The recorder reports the reason on the snapshot
  // it emits, so this only has to stop pretending the action succeeded.
  async function act(action: () => Promise<AppSnapshot>) {
    setBusy(true);
    try {
      setSnapshot(await action());
    } catch {
      setSnapshot(await desktop.snapshot().catch(() => null));
    } finally {
      setBusy(false);
    }
  }

  const recorder = snapshot?.recorder;
  if (!snapshot || !recorder) return null;
  const paused = recorder.status === "paused";
  const working = recorder.status === "finishing" || recorder.status === "uploading";
  const attention = recorder.status === "recovery";
  const steps = recorder.steps.length;
  const state = attention
    ? "Needs attention"
    : working
      ? recorder.status === "uploading"
        ? "Uploading"
        : "Finishing"
      : paused
        ? "Paused"
        : "Recording";

  if (confirmDiscard) {
    return (
      <main className="hud" data-tauri-drag-region>
        <section className="hud-bar confirming" data-tauri-drag-region>
          <div className="hud-state" data-tauri-drag-region>
            <strong>Discard this capture?</strong>
            <small>
              {steps} {steps === 1 ? "step" : "steps"} will be erased from this device.
            </small>
          </div>
          <button
            className="hud-button wide"
            disabled={busy}
            onClick={() => setConfirmDiscard(false)}
          >
            Keep recording
          </button>
          <button
            className="hud-button wide danger"
            disabled={busy}
            onClick={() => void act(desktop.discard)}
          >
            {busy ? <LoaderCircle className="spin" /> : <Trash2 />} Discard
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="hud" data-tauri-drag-region>
      <section
        className={`hud-bar${attention ? " attention" : ""}`}
        data-tauri-drag-region
      >
        {/* startDragging is called directly here rather than relying on the
            drag region alone, so the bar always has one handle that moves it. */}
        <span
          className="hud-grip"
          title="Drag to move the recorder"
          onPointerDown={(event) => {
            if (event.button === 0) void getCurrentWindow().startDragging();
          }}
        >
          <GripVertical />
        </span>
        <span
          className={`record-dot${attention ? " attention" : paused ? " paused" : ""}`}
          data-tauri-drag-region
          aria-hidden="true"
        />
        <div className="hud-state" data-tauri-drag-region>
          <strong data-tauri-drag-region>{state}</strong>
          {/* The bar names what is being recorded. Routine notices ("step
              captured", "activity outside the selected scope is ignored")
              scrolled past here as though they were the subject of the
              capture; only something the author has to act on replaces it. */}
          <small data-tauri-drag-region>
            {attention
              ? (recorder.statusMessage ?? "This capture needs attention.")
              : recorder.scopeLabel}
          </small>
        </div>
        <span className="step-count" title={`${steps} captured`}>
          <Check /> {steps}
        </span>
        {attention ? null : (
          <button
            className="hud-button wide"
            disabled={busy || working}
            onClick={() => void act(paused ? desktop.resume : desktop.pause)}
          >
            {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
          </button>
        )}
        <button
          className="hud-button wide finish"
          disabled={busy || working || steps === 0}
          title={
            steps === 0
              ? "Perform at least one action before finishing"
              : attention
                ? "Try finishing this capture again"
                : "Finish and open the draft"
          }
          onClick={() => void act(desktop.finish)}
        >
          {busy || working ? <LoaderCircle className="spin" /> : <Square />}{" "}
          {attention ? "Retry" : "Finish"}
        </button>
        <button
          className="hud-button danger"
          disabled={busy || working}
          title="Discard this capture"
          onClick={() => setConfirmDiscard(true)}
        >
          <Trash2 />
        </button>
      </section>
    </main>
  );
}
