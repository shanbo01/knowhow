import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSnapshot,
  CaptureTarget,
  CaptureTargetPreview,
  RecorderSettings,
  StartCaptureInput,
} from "./types";

export const desktop = {
  snapshot: () => invoke<AppSnapshot>("app_snapshot"),
  authorize: () => invoke<{ verificationUri: string }>("begin_authorization"),
  pollAuthorization: () => invoke<AppSnapshot>("poll_authorization"),
  targets: () => invoke<CaptureTarget[]>("capture_targets"),
  previews: (targetIds: string[]) =>
    invoke<CaptureTargetPreview[]>("capture_target_previews", { targetIds }),
  start: (input: StartCaptureInput) => invoke<AppSnapshot>("start_capture", { input }),
  cancelCountdown: () => invoke<AppSnapshot>("cancel_countdown"),
  pause: () => invoke<AppSnapshot>("pause_capture"),
  resume: () => invoke<AppSnapshot>("resume_capture"),
  finish: () => invoke<AppSnapshot>("finish_capture"),
  discard: () => invoke<AppSnapshot>("discard_capture"),
  deleteStep: (stepId: string) =>
    invoke<AppSnapshot>("delete_capture_step", { stepId }),
  retryStep: (stepId: string) =>
    invoke<AppSnapshot>("retry_capture_step", { stepId }),
  settings: (settings: RecorderSettings) =>
    invoke<AppSnapshot>("update_recorder_settings", { settings }),
  showMain: () => invoke<void>("show_main_window"),
  setHudMode: (mode: "retracted" | "compact" | "expanded") =>
    invoke<void>("set_hud_mode", { mode }),
  openKnowHow: () => invoke<void>("open_knowhow"),
  checkUpdate: () => invoke<AppSnapshot>("check_for_updates"),
  requestQuit: () => invoke<void>("request_quit"),
  onSnapshot: (handler: (snapshot: AppSnapshot) => void): Promise<UnlistenFn> =>
    listen<AppSnapshot>("app-snapshot", (event) => handler(event.payload)),
};
