import type {
  CaptureScopeKind,
  CaptureTarget,
  RecorderSettings,
} from "./types";

export function targetsForScope(
  targets: CaptureTarget[],
  scope: CaptureScopeKind,
) {
  return targets.filter((target) => target.kind === scope);
}

// Keeps a chosen source selected while it is still open, and otherwise falls
// back to the first one, so the Start button is never blocked by a selection
// that quietly disappeared.
export function selectedTarget(targets: CaptureTarget[], requestedId: string) {
  return (
    targets.find((target) => target.id === requestedId) ?? targets[0] ?? null
  );
}

export function typedTextEnabled(settings: RecorderSettings) {
  return (
    settings.desktopTypedTextPolicy === "allowed" && settings.captureTypedText
  );
}
