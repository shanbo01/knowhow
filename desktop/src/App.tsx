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
  Type,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BrandMarkGlyph } from "./BrandMarkGlyph";
import { desktop } from "./ipc";
import { selectedTarget, targetsForScope, typedTextEnabled } from "./setup";
import Settings from "./Settings";
import { SmartBlurToggles } from "./SmartBlurToggles";
import { updateStatusLabel } from "./update-status";
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
      <BrandMarkGlyph size={18} />
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
      <h1>Finish your private capture</h1>
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
  const galleryTargets = eligibleTargets;
  const target = selectedTarget(eligibleTargets, targetId);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const blurCount = Object.values(settings.smartBlur).filter(Boolean).length;
  const surface = scopeKind === "monitor" ? "displays" : "applications";
  const previewIds = useMemo(() => {
    const prioritized = target
      ? [target, ...galleryTargets.filter((candidate) => candidate.id !== target.id)]
      : galleryTargets;
    return prioritized.filter((candidate) => !candidate.protected).map((candidate) => candidate.id);
  }, [galleryTargets, target]);
  const previewKey = previewIds.join("|");

  useEffect(() => {
    let active = true;
    let loading = false;
    // Derived from the key rather than captured, so the effect re-runs when the
    // set of targets changes and not merely when the array identity does.
    const ids = previewKey ? previewKey.split("|") : [];
    // Every preview opens a Graphics Capture session against one window. The
    // first pass fills the whole gallery so nothing shows a placeholder, but
    // repeating that for twenty open applications every six seconds is a
    // steady drain on the machine the author is trying to record. Later passes
    // keep the selected source live and rotate through the rest, which each
    // tile has already drawn at least once.
    const ROTATING_PREVIEWS = 6;
    let cursor = 0;
    let filled = false;
    function nextBatch() {
      if (!filled) return ids;
      const start = cursor % ids.length;
      const rotating = [...ids.slice(start), ...ids.slice(0, start)].slice(
        0,
        ROTATING_PREVIEWS,
      );
      cursor = start + rotating.length;
      // ids[0] is the selected source, which stays live on every pass.
      return [...new Set([ids[0], ...rotating])];
    }
    async function refreshPreviews() {
      if (!ids.length || loading || document.visibilityState !== "visible") return;
      loading = true;
      try {
        const rows = await desktop.previews(nextBatch());
        if (active) {
          filled = true;
          const refreshed = Object.fromEntries(rows.map((row) => [row.targetId, row.dataUrl]));
          setPreviews((current) => ({ ...current, ...refreshed }));
        }
      } catch {
        // A window can disappear between enumeration and preview capture; the next refresh retries.
      } finally {
        loading = false;
      }
    }
    void refreshPreviews();
    const timer = window.setInterval(() => void refreshPreviews(), 6_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshPreviews();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [previewKey]);

  function chooseScope(kind: CaptureScopeKind) {
    setScopeKind(kind);
    setTargetId("");
  }

  function chooseTarget(nextTarget: CaptureTarget) {
    if (nextTarget.protected) return;
    setTargetId(nextTarget.id);
  }

  function updateSettings(patch: Partial<RecorderSettings>) {
    onSettings({ ...settings, ...patch });
  }

  return (
    <main className="capture-setup">
      <div className="setup-heading">
        <div><p className="eyebrow">New capture</p><h1>Choose an application or display</h1><p className="setup-subtitle">Pick the source KnowHow should follow while you work.</p></div>
        <button className="icon-button" title="Refresh available targets" onClick={onRefreshTargets}>
          <RefreshCw className={busy ? "spin" : ""} />
        </button>
      </div>
      <div className="source-tabs" role="tablist" aria-label="Capture source">
        <button role="tab" aria-selected={surface === "applications"} className={surface === "applications" ? "selected" : ""} onClick={() => chooseScope("application")}><AppWindow /> Applications</button>
        <button role="tab" aria-selected={surface === "displays"} className={surface === "displays" ? "selected" : ""} onClick={() => chooseScope("monitor")}><Monitor /> Displays</button>
      </div>
      <section className="share-gallery" aria-label={surface === "applications" ? "Available applications" : "Available displays"}>
        {galleryTargets.map((candidate, index) => {
          const selected = target?.id === candidate.id;
          const initial = candidate.label.trim().charAt(0).toUpperCase() || "K";
          const preview = previews[candidate.id];
          return (
            <button
              className={`share-tile${selected ? " selected" : ""}${candidate.protected ? " protected" : ""}`}
              disabled={candidate.protected}
              key={candidate.id}
              onClick={() => chooseTarget(candidate)}
            >
              <span className={`share-preview ${candidate.kind}-preview`}>
                {preview ? <img src={preview} alt={`Live preview of ${candidate.label}`} /> : candidate.kind === "monitor" ? <><span className="screen-number">{index + 1}</span><i className="screen-taskbar" /></> : <><span className="window-titlebar"><i /><i /><i /></span><span className="app-glyph">{initial}</span><span className="window-lines"><i /><i /><i /></span></>}
                {preview ? <span className="live-badge"><i /> Live</span> : null}
              </span>
              <span className="share-tile-copy"><strong>{candidate.label}</strong><small>{candidate.protected ? "Protected source" : candidate.detail || (scopeKind === "monitor" ? "Display" : "Ready to capture")}</small></span>
              <span className="selection-check"><Check /></span>
            </button>
          );
        })}
        {!galleryTargets.length ? <div className="share-empty">{surface === "applications" ? <AppWindow /> : <Monitor />}<strong>No {surface} found</strong><small>{surface === "applications" ? "Open an application, then refresh." : "Reconnect the display, then refresh."}</small></div> : null}
      </section>
      <p className="scope-explainer">{scopeKind === "application" ? "KnowHow follows every window opened by the selected application." : "KnowHow records actions performed on the selected display."}</p>
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
          <span><strong>Live Smart Blur</strong><small>{blurCount ? `${blurCount} ${blurCount === 1 ? "rule" : "rules"} applied before every step is saved` : "Off by default · password masks stay on"}</small></span>
          <ChevronDown className={blurOpen ? "open" : ""} />
        </button>
        {blurOpen ? (
          <SmartBlurToggles
            settings={settings.smartBlur}
            onChange={(smartBlur) => updateSettings({ smartBlur })}
          />
        ) : null}
      </section>
      <button
        className="primary-button start-button"
        disabled={busy || !target}
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
  const [updateError, setUpdateError] = useState("");
  const [view, setView] = useState<"capture" | "settings">("capture");

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
    return () => { active = false; dispose?.(); };
  }, []);

  // Device approval is the only state this poll advances. Running it for the
  // whole session re-serialized the snapshot and re-rendered the window every
  // two seconds for an answer that could not change.
  const authorizing = snapshot?.connection.status === "authorizing";
  useEffect(() => {
    if (!authorizing) return;
    const poll = window.setInterval(() => {
      void desktop.pollAuthorization().then(setSnapshot).catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(poll);
  }, [authorizing]);

  async function run(action: () => Promise<AppSnapshot>) {
    setBusy(true); setError("");
    try { setSnapshot(await action()); }
    catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  // Deliberately not routed through run(): in a local/dev build with no
  // signing key configured, check_for_updates always rejects, and the
  // coordinator already emits an honest "error" update status via the
  // snapshot event before that rejection happens. Popping the shared global
  // error banner on top of that inline status would just be noise for an
  // expected, everyday condition in a dev build — the rejection's own
  // message is kept locally instead, for the inline status text.
  async function checkUpdate() {
    setBusy(true);
    setUpdateError("");
    try { setSnapshot(await desktop.checkUpdate()); }
    catch (nextError) { setUpdateError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true); setError("");
    try {
      setSnapshot(await desktop.disconnect());
      setView("capture");
    }
    catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  function updateRecorderSettings(settings: RecorderSettings) {
    setSnapshot((current) => (current ? { ...current, settings } : current));
    void desktop.settings(settings).catch((nextError) => setError(errorMessage(nextError)));
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
      {view === "settings" ? (
        <Settings
          snapshot={snapshot}
          busy={busy}
          updateError={updateError}
          onClose={() => setView("capture")}
          onSettings={updateRecorderSettings}
          onDisconnect={() => void disconnect()}
          onCheckUpdate={() => void checkUpdate()}
        />
      ) : !connected ? (
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
          onSettings={updateRecorderSettings}
          onStart={(scopeKind, target, settings) => void run(() => desktop.start({ scopeKind, targetId: target?.id, targetLabel: target?.label ?? "All displays", captureTypedText: settings.captureTypedText, smartBlur: settings.smartBlur }))}
        />
      )}
      <footer className="app-footer">
        <button onClick={() => void desktop.openKnowHow()}><Globe2 /> Open KnowHow</button>
        <button
          onClick={() => void checkUpdate()}
          disabled={busy || snapshot.update.status === "checking"}
          title={updateStatusLabel(snapshot.update, updateError)}
        >
          {snapshot.update.status === "checking" ? <LoaderCircle className="spin" /> : <RefreshCw />}
          Updates
          {snapshot.update.status === "available" ? <i className="update-dot" aria-hidden="true" /> : null}
        </button>
        <button title="Recorder settings" onClick={() => setView("settings")}><Settings2 /> Settings</button>
        <span>v{snapshot.version}</span>
      </footer>
    </div>
  );
}
