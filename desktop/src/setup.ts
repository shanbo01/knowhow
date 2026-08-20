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
export function selectedTarget(
  targets: CaptureTarget[],
  requestedId: string,
) {
  return (
    targets.find(
      (target) => target.id === requestedId && !target.protected,
    ) ?? targets.find((target) => !target.protected) ?? null
  );
}

export function typedTextEnabled(settings: RecorderSettings) {
  return (
    settings.desktopTypedTextPolicy === "allowed" &&
    settings.captureTypedText
  );
}
