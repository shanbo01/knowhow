import {
  Check,
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

  async function act(action: () => Promise<AppSnapshot>) {
    setBusy(true);
    try {
      setSnapshot(await action());
    } finally {
      setBusy(false);
    }
  }

  const recorder = snapshot?.recorder;
  if (!snapshot || !recorder) return null;
  const paused = recorder.status === "paused";
  const working = recorder.status === "finishing" || recorder.status === "uploading";
  const steps = recorder.steps.length;
  const state = working
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
      <section className="hud-bar" data-tauri-drag-region>
        <span
          className={`record-dot${paused ? " paused" : ""}`}
          data-tauri-drag-region
          aria-hidden="true"
        />
        <div
          className="hud-state"
          data-tauri-drag-region
          onPointerDown={(event) => {
            if (event.button === 0) void getCurrentWindow().startDragging();
          }}
        >
          <strong data-tauri-drag-region>{state}</strong>
          <small data-tauri-drag-region>
            {recorder.statusMessage ?? recorder.scopeLabel}
          </small>
        </div>
        <span className="step-count" title={`${steps} captured`}>
          <Check /> {steps}
        </span>
        <button
          className="hud-button wide"
          disabled={busy || working}
          onClick={() => void act(paused ? desktop.resume : desktop.pause)}
        >
          {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
        </button>
        <button
          className="hud-button wide finish"
          disabled={busy || working || steps === 0}
          title={
            steps === 0
              ? "Perform at least one action before finishing"
              : "Finish and open the draft"
          }
          onClick={() => void act(desktop.finish)}
        >
          {working ? <LoaderCircle className="spin" /> : <Square />} Finish
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
