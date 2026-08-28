export type ConnectionState =
  | { status: "disconnected" }
  | { status: "authorizing"; deviceName: string; expiresAt: string }
  | {
      status: "connected";
      workspaceId: string;
      workspaceName: string;
      minimumVersion: string;
    }
  | { status: "blocked"; message: string };

export type CaptureScopeKind = "application" | "monitor";

export type CaptureTarget = {
  id: string;
  kind: CaptureScopeKind;
  label: string;
  detail: string;
  processId?: number;
  bounds?: { x: number; y: number; width: number; height: number };
};

export type CaptureTargetPreview = {
  targetId: string;
  dataUrl: string;
};

export type RecorderSettings = {
  captureTypedText: boolean;
  desktopTypedTextPolicy: "allowed" | "disabled";
};

export type StepSummary = {
  id: string;
  order: number;
  title: string;
  instruction: string;
  interaction: string;
};

export type RecorderState = {
  status:
    | "idle"
    | "countdown"
    | "recording"
    | "paused"
    | "finishing"
    | "uploading"
    | "recovery";
  captureId?: string;
  scopeLabel?: string;
  countdownRemaining?: number;
  steps: StepSummary[];
  statusMessage?: string;
  editorUrl?: string;
};

export type AppSnapshot = {
  version: string;
  connection: ConnectionState;
  recorder: RecorderState;
  settings: RecorderSettings;
  update: {
    status: "idle" | "checking" | "available" | "deferred" | "current" | "error";
    version?: string;
  };
};

export type StartCaptureInput = {
  scopeKind: CaptureScopeKind;
  targetId?: string;
  targetLabel: string;
  captureTypedText: boolean;
};
