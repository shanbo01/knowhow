import { useEffect, useState } from "react";
import { desktop } from "./ipc";
import type { AppSnapshot } from "./types";

/**
 * A click-through frame drawn around whatever is being recorded, so the author
 * can always see the boundary their actions have to stay inside. The window
 * itself is positioned and resized by the recorder; this only draws the edge
 * and colours it for the current state.
 */
export default function Outline() {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    void desktop
      .snapshot()
      .then((snapshot) => setPaused(snapshot.recorder.status === "paused"))
      .catch(() => undefined);
    let dispose: (() => void) | undefined;
    void desktop
      .onSnapshot((snapshot: AppSnapshot) =>
        setPaused(snapshot.recorder.status === "paused"),
      )
      .then((unlisten) => {
        dispose = unlisten;
      });
    return () => dispose?.();
  }, []);

  return <div className={`capture-outline${paused ? " paused" : ""}`} aria-hidden="true" />;
}
