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

export type CaptureScopeKind =
  | "application"
  | "window"
  | "monitor"
  | "all-displays";

export type CaptureTarget = {
  id: string;
  kind: Exclude<CaptureScopeKind, "all-displays">;
  label: string;
  detail: string;
  processId?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  protected: boolean;
};

export type CaptureTargetPreview = {
  targetId: string;
  dataUrl: string;
};

export type SmartBlurSettings = {
  emails: boolean;
  phoneNumbers: boolean;
  financialNumbers: boolean;
  identifiers: boolean;
  formFields: boolean;
  images: boolean;
  tableRows: boolean;
  longText: boolean;
};

export type RecorderSettings = {
  captureTypedText: boolean;
  desktopTypedTextPolicy: "allowed" | "disabled";
  smartBlur: SmartBlurSettings;
};

export type StepSummary = {
  id: string;
  order: number;
  title: string;
  instruction: string;
  interaction: string;
  status: "ready" | "processing" | "retry" | "deleting";
};

export type RecorderState = {
  status:
    | "idle"
    | "countdown"
    | "recording"
    | "paused"
    | "finishing"
    | "uploading"
    | "recovery"
    | "blocked";
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
  smartBlur: SmartBlurSettings;
};
