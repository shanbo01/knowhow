import {
  CircleAlert,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Sparkles,
  Type,
  X,
} from "lucide-react";
import { useState } from "react";
import { SmartBlurToggles } from "./SmartBlurToggles";
import { updateStatusLabel } from "./update-status";
import type { AppSnapshot, RecorderSettings } from "./types";

export default function Settings({
  snapshot,
  busy,
  updateError,
  onClose,
  onSettings,
  onDisconnect,
  onCheckUpdate,
}: {
  snapshot: AppSnapshot;
  busy: boolean;
  updateError: string;
  onClose: () => void;
  onSettings: (settings: RecorderSettings) => void;
  onDisconnect: () => void;
  onCheckUpdate: () => void;
}) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const connection = snapshot.connection;
  const settings = snapshot.settings;
  const inCapture = snapshot.recorder.status !== "idle";

  function updateSettings(patch: Partial<RecorderSettings>) {
    onSettings({ ...settings, ...patch });
  }

  return (
    <main className="settings-screen">
      <div className="setup-heading">
        <div>
          <p className="eyebrow">Recorder settings</p>
          <h1>Settings</h1>
        </div>
        <button className="icon-button" title="Close settings" onClick={onClose}>
          <X />
        </button>
      </div>

      <section className="settings-card">
        <h2>Workspace</h2>
        {connection.status === "connected" ? (
          <>
            <p className="settings-row">
              <span>Connected workspace</span>
              <strong>{connection.workspaceName}</strong>
            </p>
            {confirmDisconnect ? (
              <p className="settings-confirm">
                <span>Disconnect this device from {connection.workspaceName}?</span>
                <button className="settings-ghost-button" onClick={() => setConfirmDisconnect(false)}>
                  Cancel
                </button>
                <button
                  className="settings-danger-button"
                  disabled={busy || inCapture}
                  onClick={() => { setConfirmDisconnect(false); onDisconnect(); }}
                >
                  Disconnect
                </button>
              </p>
            ) : (
              <button
                className="settings-danger-button"
                disabled={busy || inCapture}
                title={inCapture ? "Finish or discard the current capture first" : undefined}
                onClick={() => setConfirmDisconnect(true)}
              >
                <LogOut /> Disconnect
              </button>
            )}
          </>
        ) : (
          <p className="settings-row"><span>Not connected to a workspace.</span></p>
        )}
      </section>

      <section className="settings-card">
        <h2><Sparkles /> Live Smart Blur defaults</h2>
        <p className="settings-hint">
          Applied before every step is saved, on every capture, unless changed for a specific
          session from the capture screen. Password fields and uncertain form fields are always
          masked regardless of these toggles.
        </p>
        <SmartBlurToggles
          settings={settings.smartBlur}
          onChange={(smartBlur) => updateSettings({ smartBlur })}
        />
      </section>

      <section className="settings-card">
        <h2><Type /> Typed text capture</h2>
        <p className="settings-row">
          <span>Workspace policy</span>
          <strong>
            {settings.desktopTypedTextPolicy === "allowed" ? "Allowed" : "Disabled"}
          </strong>
        </p>
        <p className="settings-hint">
          Set by the connected workspace, not from this device. When disabled, KnowHow records
          semantic instructions instead of exact typed text.
        </p>
      </section>

      <section className="settings-card">
        <h2>About</h2>
        <p className="settings-row">
          <span>Version</span>
          <strong>{snapshot.version}</strong>
        </p>
        <p className="settings-update-status">
          {snapshot.update.status === "checking" ? <LoaderCircle className="spin" /> : null}
          {snapshot.update.status === "error" ? <CircleAlert /> : null}
          {updateStatusLabel(snapshot.update, updateError)}
        </p>
        <button
          className="settings-ghost-button"
          disabled={busy || snapshot.update.status === "checking"}
          onClick={onCheckUpdate}
        >
          <RefreshCw /> Check for updates
        </button>
      </section>
    </main>
  );
}
