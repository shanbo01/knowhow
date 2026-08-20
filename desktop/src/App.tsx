import {
  AppWindow,
  Check,
  ChevronDown,
  CircleAlert,
  Globe2,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  MousePointer2,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { desktop } from "./ipc";
import { selectedTarget, targetsForScope, typedTextEnabled } from "./setup";
import type {
  AppSnapshot,
  CaptureScopeKind,
  CaptureTarget,
  RecorderSettings,
  SmartBlurSettings,
} from "./types";

const DEFAULT_BLUR: SmartBlurSettings = {
  emails: false,
  phoneNumbers: false,
  financialNumbers: false,
  identifiers: false,
  formFields: false,
  images: false,
  tableRows: false,
  longText: false,
};

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Something went wrong.";
}

function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span>K</span><i />
    </span>
  );
}

function ConnectedHeader({ snapshot }: { snapshot: AppSnapshot }) {
  const connected =
    snapshot.connection.status === "connected" ? snapshot.connection : null;
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <Mark />
        <div><strong>KnowHow Capture</strong><small>Windows recorder</small></div>
      </div>
      {connected ? (
        <span className="connection-chip"><i /> {connected.workspaceName}</span>
      ) : null}
    </header>
  );
}

function ConnectionScreen({
  snapshot,
  busy,
  onConnect,
}: {
  snapshot: AppSnapshot;
  busy: boolean;
  onConnect: () => void;
}) {
  const authorizing = snapshot.connection.status === "authorizing";
  const blockedMessage = snapshot.connection.status === "blocked" ? snapshot.connection.message : null;
  const blocked = blockedMessage !== null;
  return (
    <main className="connection-screen">
      <div className="connection-visual">
        <span><Laptop /></span><i /><span><Globe2 /></span>
      </div>
      <p className="eyebrow">One-time setup</p>
      <h1>{blocked ? "KnowHow Capture needs attention" : authorizing ? "Approve this device in your browser" : "Connect to KnowHow"}</h1>
      <p>
        {blocked
          ? blockedMessage
          : authorizing
          ? "Choose a workspace and approve the named device. This window connects automatically—there is no code to copy."
          : "Use your signed-in browser to choose a workspace and approve this Windows device."}
      </p>
      <button className="primary-button" disabled={busy || blocked} onClick={onConnect}>
        {busy || authorizing ? <LoaderCircle className="spin" /> : <ShieldCheck />}
        {authorizing ? "Open approval again" : "Connect securely"}
      </button>
      <div className="trust-strip">
        <span><LockKeyhole /> No password enters the app</span>
        <span><ShieldCheck /> Revocable device access</span>
      </div>
    </main>
  );
}

function RecoveryScreen({
  snapshot,
  busy,
  onFinish,
  onDiscard,
}: {
  snapshot: AppSnapshot;
  busy: boolean;
  onFinish: () => void;
  onDiscard: () => void;
}) {
  return (
    <main className="recovery-screen">
      <span className="recovery-icon"><RefreshCw /></span>
      <p className="eyebrow">Recovered safely</p>
      <h1>Finish your encrypted capture</h1>
      <p>{snapshot.recorder.statusMessage ?? "This unfinished capture stayed encrypted on this device."}</p>
      <div className="recovery-summary">
        <span><strong>{snapshot.recorder.steps.length}</strong> steps</span>
        <span><strong>{snapshot.recorder.scopeLabel}</strong> scope</span>
      </div>
      <button className="primary-button" disabled={busy || snapshot.recorder.steps.length === 0} onClick={onFinish}>
        {busy ? <LoaderCircle className="spin" /> : <Check />} Finish and open editor
      </button>
      <button className="recovery-discard" disabled={busy} onClick={onDiscard}>Discard encrypted capture</button>
    </main>
  );
}

const SCOPE_OPTIONS: Array<{
  kind: CaptureScopeKind;
  title: string;
  description: string;
  icon: typeof AppWindow;
}> = [
  {
    kind: "application",
    title: "Application",
    description: "Follow foreground windows from one app",
    icon: AppWindow,
  },
  {
    kind: "window",
    title: "Window",
    description: "One window and its owned dialogs",
    icon: Square,
  },
  {
    kind: "monitor",
    title: "Monitor",
    description: "Actions on one physical display",
    icon: Monitor,
  },
  {
    kind: "all-displays",
    title: "All displays",
    description: "Store the display containing each action",
    icon: Laptop,
  },
];

function CaptureSetup({
  snapshot,
  targets,
  busy,
  onRefreshTargets,
  onStart,
  onSettings,
}: {
  snapshot: AppSnapshot;
  targets: CaptureTarget[];
  busy: boolean;
  onRefreshTargets: () => void;
  onStart: (
    scopeKind: CaptureScopeKind,
    target: CaptureTarget | null,
    settings: RecorderSettings,
  ) => void;
  onSettings: (settings: RecorderSettings) => void;
}) {
  const [scopeKind, setScopeKind] = useState<CaptureScopeKind>("application");
  const [targetId, setTargetId] = useState("");
  const [blurOpen, setBlurOpen] = useState(false);
  const settings = snapshot.settings ?? {
    captureTypedText: false,
    desktopTypedTextPolicy: "allowed" as const,
    smartBlur: DEFAULT_BLUR,
  };
  const eligibleTargets = useMemo(
    () => targetsForScope(targets, scopeKind),
    [scopeKind, targets],
  );
  const target =
    scopeKind === "all-displays"
      ? null
      : selectedTarget(eligibleTargets, targetId);
  const blurCount = Object.values(settings.smartBlur).filter(Boolean).length;

  function updateSettings(patch: Partial<RecorderSettings>) {
    onSettings({ ...settings, ...patch });
  }

  return (
    <main className="capture-setup">
      <div className="setup-heading">
        <div><p className="eyebrow">New capture</p><h1>What should KnowHow follow?</h1></div>
        <button className="icon-button" title="Refresh available targets" onClick={onRefreshTargets}>
          <RefreshCw className={busy ? "spin" : ""} />
        </button>
      </div>
      <div className="scope-grid">
        {SCOPE_OPTIONS.map(({ kind, title, description, icon: Icon }) => (
          <button
            className={`scope-card${scopeKind === kind ? " selected" : ""}`}
            key={kind}
            onClick={() => setScopeKind(kind)}
          >
            <span><Icon /></span><strong>{title}</strong><small>{description}</small>
            {scopeKind === kind ? <i><Check /></i> : null}
          </button>
        ))}
      </div>
      {scopeKind !== "all-displays" ? (
        <label className="target-picker">
          <span>{scopeKind === "monitor" ? "Choose a monitor" : `Choose ${scopeKind === "application" ? "an application" : "a window"}`}</span>
          <select value={target?.id ?? ""} onChange={(event) => setTargetId(event.target.value)}>
            {eligibleTargets.length ? eligibleTargets.map((target) => (
              <option value={target.id} disabled={target.protected} key={target.id}>
                {target.label}{target.detail ? ` — ${target.detail}` : ""}{target.protected ? " (protected)" : ""}
              </option>
            )) : <option value="">No eligible targets</option>}
          </select>
        </label>
      ) : (
        <div className="all-displays-note"><Monitor /> Each step keeps only the display or window where the action happened.</div>
      )}
      <label className={`feature-toggle prominent${settings.desktopTypedTextPolicy === "disabled" ? " disabled" : ""}`}>
        <span className="feature-icon"><Type /></span>
        <span><strong>Capture typed text</strong><small>Exact text from confirmed non-password fields. Password and uncertain fields stay semantic.</small></span>
        <input
          type="checkbox"
          checked={typedTextEnabled(settings)}
          disabled={settings.desktopTypedTextPolicy === "disabled"}
          onChange={(event) => updateSettings({ captureTypedText: event.target.checked })}
        />
        <i />
      </label>
      <section className="blur-panel">
        <button className="blur-panel-trigger" onClick={() => setBlurOpen((open) => !open)}>
          <span className="feature-icon"><Sparkles /></span>
          <span><strong>Smart Blur</strong><small>{blurCount ? `${blurCount} optional ${blurCount === 1 ? "rule" : "rules"} on` : "Off by default · password masks stay on"}</small></span>
          <ChevronDown className={blurOpen ? "open" : ""} />
        </button>
        {blurOpen ? (
          <div className="blur-options">
            {(
              [
                ["emails", "Email addresses"],
                ["phoneNumbers", "Phone numbers"],
                ["financialNumbers", "Financial numbers"],
                ["identifiers", "Long identifiers"],
                ["formFields", "Form fields"],
                ["images", "Images"],
                ["tableRows", "Table rows"],
                ["longText", "Long text regions"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={settings.smartBlur[key]}
                  onChange={(event) =>
                    updateSettings({
                      smartBlur: { ...settings.smartBlur, [key]: event.target.checked },
                    })
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        ) : null}
      </section>
      <button
        className="primary-button start-button"
        disabled={busy || (scopeKind !== "all-displays" && !target)}
        onClick={() => onStart(scopeKind, target, settings)}
      >
        <MousePointer2 /> Start capture <kbd>3 sec</kbd>
      </button>
      <p className="setup-footnote"><ShieldCheck /> KnowHow windows and protected surfaces are excluded before any screenshot is saved.</p>
    </main>
  );
}

function Countdown({ snapshot, onCancel }: { snapshot: AppSnapshot; onCancel: () => void }) {
  return (
    <main className="countdown-screen">
      <span className="countdown-number">{snapshot.recorder.countdownRemaining ?? 3}</span>
      <p>Get ready to perform the workflow</p>
      <strong>{snapshot.recorder.scopeLabel}</strong>
      <button className="secondary-button" onClick={onCancel}>Cancel</button>
    </main>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [targets, setTargets] = useState<CaptureTarget[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshTargets = useCallback(async () => {
    setBusy(true);
    try { setTargets(await desktop.targets()); }
    catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([desktop.snapshot(), desktop.targets()])
      .then(([nextSnapshot, nextTargets]) => {
        if (!active) return;
        setSnapshot(nextSnapshot);
        setTargets(nextTargets);
      })
      .catch((nextError) => {
        if (active) setError(errorMessage(nextError));
      });
    let dispose: (() => void) | undefined;
    void desktop.onSnapshot(setSnapshot).then((unlisten) => { dispose = unlisten; });
    const poll = window.setInterval(() => {
      void desktop.pollAuthorization().then(setSnapshot).catch(() => undefined);
    }, 2_000);
    return () => { active = false; dispose?.(); window.clearInterval(poll); };
  }, []);

  async function run(action: () => Promise<AppSnapshot>) {
    setBusy(true); setError("");
    try { setSnapshot(await action()); }
    catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  if (!snapshot) {
    return <main className="opening"><Mark /><LoaderCircle className="spin" /><p>Opening KnowHow Capture</p>{error ? <span>{error}</span> : null}</main>;
  }

  const connected = snapshot.connection.status === "connected";
  const recorder = snapshot.recorder;
  return (
    <div className="app-shell">
      <ConnectedHeader snapshot={snapshot} />
      {error ? <div className="error-banner"><CircleAlert /><span>{error}</span><button onClick={() => setError("")}>×</button></div> : null}
      {!connected ? (
        <ConnectionScreen snapshot={snapshot} busy={busy} onConnect={() => void run(async () => { await desktop.authorize(); return desktop.snapshot(); })} />
      ) : recorder.status === "countdown" ? (
        <Countdown snapshot={snapshot} onCancel={() => void run(desktop.cancelCountdown)} />
      ) : recorder.status === "recovery" ? (
        <RecoveryScreen
          snapshot={snapshot}
          busy={busy}
          onFinish={() => void run(desktop.finish)}
          onDiscard={() => void run(desktop.discard)}
        />
      ) : recorder.status === "recording" || recorder.status === "paused" || recorder.status === "finishing" || recorder.status === "uploading" ? (
        <main className="recording-in-main"><LoaderCircle className="spin" /><h1>Capture controls are in the floating recorder</h1><p>You can close this window. KnowHow keeps recording from the tray.</p></main>
      ) : (
        <CaptureSetup
          snapshot={snapshot}
          targets={targets}
          busy={busy}
          onRefreshTargets={() => void refreshTargets()}
          onSettings={(settings) => { setSnapshot({ ...snapshot, settings }); void desktop.settings(settings).catch((nextError) => setError(errorMessage(nextError))); }}
          onStart={(scopeKind, target, settings) => void run(() => desktop.start({ scopeKind, targetId: target?.id, targetLabel: target?.label ?? "All displays", captureTypedText: settings.captureTypedText, smartBlur: settings.smartBlur }))}
        />
      )}
      <footer className="app-footer"><button onClick={() => void desktop.openKnowHow()}><Globe2 /> Open KnowHow</button><button onClick={() => void desktop.checkUpdate()}><RefreshCw /> Updates</button><button title="Recorder settings"><Settings2 /> Settings</button><span>v{snapshot.version}</span></footer>
    </div>
  );
}
