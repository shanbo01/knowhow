import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSnapshot,
  CaptureTarget,
  CaptureTargetPreview,
  RecorderSettings,
  StartCaptureInput,
} from "./types";

/**
 * Tauri creates every window in the configuration before the setup hook runs,
 * so a webview can ask for the first snapshot while the recorder is still being
 * constructed and `manage`d — which surfaced as "state not managed for field
 * `state`" in the window that happened to ask first. Nothing is wrong at that
 * point except the timing, so the first read waits for the backend rather than
 * reporting a failure the author can do nothing about.
 */
async function firstSnapshot(): Promise<AppSnapshot> {
  const attempts = 25;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await invoke<AppSnapshot>("app_snapshot");
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
}

export const desktop = {
  snapshot: firstSnapshot,
  authorize: () => invoke<{ verificationUri: string }>("begin_authorization"),
  pollAuthorization: () => invoke<AppSnapshot>("poll_authorization"),
  disconnect: () => invoke<AppSnapshot>("disconnect"),
  targets: () => invoke<CaptureTarget[]>("capture_targets"),
  previews: (targetIds: string[]) =>
    invoke<CaptureTargetPreview[]>("capture_target_previews", { targetIds }),
  start: (input: StartCaptureInput) => invoke<AppSnapshot>("start_capture", { input }),
  cancelCountdown: () => invoke<AppSnapshot>("cancel_countdown"),
  pause: () => invoke<AppSnapshot>("pause_capture"),
  resume: () => invoke<AppSnapshot>("resume_capture"),
  finish: () => invoke<AppSnapshot>("finish_capture"),
  discard: () => invoke<AppSnapshot>("discard_capture"),
  settings: (settings: RecorderSettings) =>
    invoke<AppSnapshot>("update_recorder_settings", { settings }),
  showMain: () => invoke<void>("show_main_window"),
  openKnowHow: () => invoke<void>("open_knowhow"),
  checkUpdate: () => invoke<AppSnapshot>("check_for_updates"),
  requestQuit: () => invoke<void>("request_quit"),
  onSnapshot: (handler: (snapshot: AppSnapshot) => void): Promise<UnlistenFn> =>
    listen<AppSnapshot>("app-snapshot", (event) => handler(event.payload)),
};
