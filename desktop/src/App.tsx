import {
  AppWindow,
  Check,
  CircleAlert,
  Globe2,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Monitor,
  MousePointer2,
  RefreshCw,
  ShieldCheck,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandMarkGlyph } from "./BrandMarkGlyph";
import { desktop } from "./ipc";
import { selectedTarget, targetsForScope, typedTextEnabled } from "./setup";
import { updateStatusLabel } from "./update-status";
import type {
  AppSnapshot,
  CaptureScopeKind,
  CaptureTarget,
  RecorderSettings,
} from "./types";

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

function AppHeader({
  snapshot,
  busy,
  onDisconnect,
}: {
  snapshot: AppSnapshot;
  busy: boolean;
  onDisconnect: () => void;
}) {
  const connected =
    snapshot.connection.status === "connected" ? snapshot.connection : null;
  const idle = snapshot.recorder.status === "idle";
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <Mark />
        <div>
          <strong>KnowHow Capture</strong>
          <small>Windows recorder</small>
        </div>
      </div>
      {connected ? (
        <span className="connection-chip">
          <i /> {connected.workspaceName}
          <button
            className="chip-action"
            disabled={busy || !idle}
            title={
              idle
                ? `Disconnect this device from ${connected.workspaceName}`
                : "Finish or discard the current capture first"
            }
            onClick={onDisconnect}
          >
            <LogOut />
          </button>
        </span>
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
  const blockedMessage =
    snapshot.connection.status === "blocked" ? snapshot.connection.message : null;
  return (
    <main className="connection-screen">
      <div className="connection-visual">
        <span>
          <Laptop />
        </span>
        <i />
        <span>
          <Globe2 />
        </span>
      </div>
      <p className="eyebrow">One-time setup</p>
      <h1>
        {blockedMessage
          ? "KnowHow Capture needs attention"
          : authorizing
            ? "Approve this device in your browser"
            : "Connect to KnowHow"}
      </h1>
      <p>
        {blockedMessage ??
          (authorizing
            ? "Choose a workspace and approve the named device. This window connects automatically—there is no code to copy."
            : "Use your signed-in browser to choose a workspace and approve this Windows device.")}
      </p>
      <button
        className="primary-button"
        disabled={busy || blockedMessage !== null}
        onClick={onConnect}
      >
        {busy || authorizing ? <LoaderCircle className="spin" /> : <ShieldCheck />}
        {authorizing ? "Open approval again" : "Connect securely"}
      </button>
      <div className="trust-strip">
        <span>
          <LockKeyhole /> No password enters the app
        </span>
        <span>
          <ShieldCheck /> Revocable device access
        </span>
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
      <span className="recovery-icon">
        <RefreshCw />
      </span>
      <p className="eyebrow">Recovered safely</p>
      <h1>Finish your private capture</h1>
      <p>
        {snapshot.recorder.statusMessage ??
          "This unfinished capture stayed encrypted on this device."}
      </p>
      <div className="recovery-summary">
        <span>
          <strong>{snapshot.recorder.steps.length}</strong> steps
        </span>
        <span>
          <strong>{snapshot.recorder.scopeLabel}</strong> scope
        </span>
      </div>
      <button
        className="primary-button"
        disabled={busy || snapshot.recorder.steps.length === 0}
        onClick={onFinish}
      >
        {busy ? <LoaderCircle className="spin" /> : <Check />} Finish and open editor
      </button>
      <button className="recovery-discard" disabled={busy} onClick={onDiscard}>
        Discard encrypted capture
      </button>
    </main>
  );
}

// How often the source the author has selected is re-photographed. Only that
// one tile stays live; see the effects below.
const SELECTED_PREVIEW_INTERVAL = 3_000;

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
    target: CaptureTarget,
    settings: RecorderSettings,
  ) => void;
  onSettings: (settings: RecorderSettings) => void;
}) {
  const [scopeKind, setScopeKind] = useState<CaptureScopeKind>("application");
  const [targetId, setTargetId] = useState("");
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const settings = snapshot.settings;
  const eligibleTargets = useMemo(
    () => targetsForScope(targets, scopeKind),
    [scopeKind, targets],
  );
  const target = selectedTarget(eligibleTargets, targetId);
  const applications = scopeKind === "application";

  // Every preview opens a Graphics Capture session against one source. The old
  // recorder re-photographed the whole gallery on a six-second loop, which was
  // a steady drain on the machine the author is trying to record. A tile is
  // filled once, and only the selected source — the one the author is looking
  // at to confirm they picked the right thing — stays live after that.
  const pendingPreviews = useRef(new Set<string>());
  const missingKey = eligibleTargets
    .filter((candidate) => !(candidate.id in previews))
    .map((candidate) => candidate.id)
    .join("|");

  useEffect(() => {
    if (!missingKey) return;
    const missing = missingKey
      .split("|")
      .filter((id) => !pendingPreviews.current.has(id));
    if (!missing.length) return;
    let active = true;
    missing.forEach((id) => pendingPreviews.current.add(id));
    void desktop
      .previews(missing)
      .then((rows) => {
        if (!active) return;
        setPreviews((current) => ({
          ...current,
          ...Object.fromEntries(rows.map((row) => [row.targetId, row.dataUrl])),
        }));
      })
      .catch(() => {
        // A window can close between enumeration and preview capture. The tile
        // keeps its placeholder and Refresh tries again.
      })
      .finally(() => {
        missing.forEach((id) => pendingPreviews.current.delete(id));
      });
    return () => {
      active = false;
    };
  }, [missingKey]);

  const selectedId = target?.id;
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    let inFlight = false;
    async function refreshSelected() {
      if (!selectedId || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const rows = await desktop.previews([selectedId]);
        if (!active || !rows.length) return;
        setPreviews((current) => ({
          ...current,
          ...Object.fromEntries(rows.map((row) => [row.targetId, row.dataUrl])),
        }));
      } catch {
        // Keep showing the last good frame for this source.
      } finally {
        inFlight = false;
      }
    }
    const timer = window.setInterval(
      () => void refreshSelected(),
      SELECTED_PREVIEW_INTERVAL,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedId]);

  function chooseScope(kind: CaptureScopeKind) {
    setScopeKind(kind);
    setTargetId("");
  }

  function refresh() {
    setPreviews({});
    pendingPreviews.current.clear();
    onRefreshTargets();
  }

  return (
    <main className="capture-setup">
      <div className="setup-heading">
        <div>
          <p className="eyebrow">New capture</p>
          <h1>Choose an application or display</h1>
          <p className="setup-subtitle">
            KnowHow records the clicks, typing and shortcuts you perform here.
          </p>
        </div>
        <button
          className="icon-button"
          title="Refresh available sources"
          onClick={refresh}
        >
          <RefreshCw className={busy ? "spin" : ""} />
        </button>
      </div>
      <div className="source-tabs" role="tablist" aria-label="Capture source">
        <button
          role="tab"
          aria-selected={applications}
          className={applications ? "selected" : ""}
          onClick={() => chooseScope("application")}
        >
          <AppWindow /> Applications
        </button>
        <button
          role="tab"
          aria-selected={!applications}
          className={!applications ? "selected" : ""}
          onClick={() => chooseScope("monitor")}
        >
          <Monitor /> Displays
        </button>
      </div>
      <section
        className="share-gallery"
        aria-label={applications ? "Available applications" : "Available displays"}
      >
        {eligibleTargets.map((candidate, index) => {
          const selected = target?.id === candidate.id;
          const preview = previews[candidate.id];
          return (
            <button
              className={`share-tile${selected ? " selected" : ""}`}
              key={candidate.id}
              aria-pressed={selected}
              onClick={() => setTargetId(candidate.id)}
            >
              <span className="share-preview">
                {preview ? (
                  <img src={preview} alt="" />
                ) : (
                  <span className="preview-placeholder">
                    {candidate.kind === "monitor" ? (
                      <span className="screen-number">{index + 1}</span>
                    ) : (
                      <span className="app-glyph">
                        {candidate.label.trim().charAt(0).toUpperCase() || "K"}
                      </span>
                    )}
                  </span>
                )}
              </span>
              <span className="share-tile-copy">
                <strong>{candidate.label}</strong>
                <small>
                  {candidate.detail ||
                    (candidate.kind === "monitor" ? "Display" : "Ready to capture")}
                </small>
              </span>
              <span className="selection-check">
                <Check />
              </span>
            </button>
          );
        })}
        {!eligibleTargets.length ? (
          <div className="share-empty">
            {applications ? <AppWindow /> : <Monitor />}
            <strong>No {applications ? "applications" : "displays"} found</strong>
            <small>
              {applications
                ? "Open an application, then refresh."
                : "Reconnect the display, then refresh."}
            </small>
          </div>
        ) : null}
      </section>
      <p className="scope-explainer">
        {applications
          ? "KnowHow follows every window opened by the selected application."
          : "KnowHow records actions performed on the selected display."}
      </p>
      <label
        className={`feature-toggle${
          settings.desktopTypedTextPolicy === "disabled" ? " disabled" : ""
        }`}
      >
        <span className="feature-icon">
          <Type />
        </span>
        <span>
          <strong>Capture typed text</strong>
          <small>
            {settings.desktopTypedTextPolicy === "disabled"
              ? "Turned off by your workspace. Steps describe what you typed into instead."
              : "Records the exact text from confirmed non-password fields."}
          </small>
        </span>
        <input
          type="checkbox"
          checked={typedTextEnabled(settings)}
          disabled={settings.desktopTypedTextPolicy === "disabled"}
          onChange={(event) =>
            onSettings({ ...settings, captureTypedText: event.target.checked })
          }
        />
        <i />
      </label>
      <button
        className="primary-button start-button"
        disabled={busy || !target}
        onClick={() => target && onStart(scopeKind, target, settings)}
      >
        <MousePointer2 /> Start capture <kbd>3 sec</kbd>
      </button>
    </main>
  );
}

function Countdown({
  snapshot,
  onCancel,
}: {
  snapshot: AppSnapshot;
  onCancel: () => void;
}) {
  return (
    <main className="countdown-screen">
      <span className="countdown-number">
        {snapshot.recorder.countdownRemaining ?? 3}
      </span>
      <p>Get ready to perform the workflow</p>
      <strong>{snapshot.recorder.scopeLabel}</strong>
      <button className="secondary-button" onClick={onCancel}>
        Cancel
      </button>
    </main>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [targets, setTargets] = useState<CaptureTarget[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [updateError, setUpdateError] = useState("");

  const refreshTargets = useCallback(async () => {
    setBusy(true);
    try {
      setTargets(await desktop.targets());
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
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
    void desktop.onSnapshot(setSnapshot).then((unlisten) => {
      dispose = unlisten;
    });
    return () => {
      active = false;
      dispose?.();
    };
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
    setBusy(true);
    setError("");
    try {
      setSnapshot(await action());
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  // Deliberately not routed through run(): in a local/dev build with no
  // signing key configured, check_for_updates always rejects, and the
  // coordinator already emits an honest "error" update status via the
  // snapshot event before that rejection happens. Popping the shared global
  // error banner on top of that inline status would just be noise for an
  // expected, everyday condition in a dev build — the rejection's own
  // message is kept locally instead, for the footer button's tooltip.
  async function checkUpdate() {
    setBusy(true);
    setUpdateError("");
    try {
      setSnapshot(await desktop.checkUpdate());
    } catch (nextError) {
      setUpdateError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot) {
    return (
      <main className="opening">
        <Mark />
        <LoaderCircle className="spin" />
        <p>Opening KnowHow Capture</p>
        {error ? <span>{error}</span> : null}
      </main>
    );
  }

  const connected = snapshot.connection.status === "connected";
  const recorder = snapshot.recorder;
  return (
    <div className="app-shell">
      <AppHeader
        snapshot={snapshot}
        busy={busy}
        onDisconnect={() => void run(desktop.disconnect)}
      />
      {error ? (
        <div className="error-banner">
          <CircleAlert />
          <span>{error}</span>
          <button onClick={() => setError("")}>×</button>
        </div>
      ) : null}
      {!connected ? (
        <ConnectionScreen
          snapshot={snapshot}
          busy={busy}
          onConnect={() =>
            void run(async () => {
              await desktop.authorize();
              return desktop.snapshot();
            })
          }
        />
      ) : recorder.status === "countdown" ? (
        <Countdown snapshot={snapshot} onCancel={() => void run(desktop.cancelCountdown)} />
      ) : recorder.status === "recovery" ? (
        <RecoveryScreen
          snapshot={snapshot}
          busy={busy}
          onFinish={() => void run(desktop.finish)}
          onDiscard={() => void run(desktop.discard)}
        />
      ) : recorder.status !== "idle" ? (
        <main className="recording-in-main">
          <LoaderCircle className="spin" />
          <h1>Capture controls are in the floating recorder</h1>
          <p>You can close this window. KnowHow keeps recording from the tray.</p>
        </main>
      ) : (
        <CaptureSetup
          snapshot={snapshot}
          targets={targets}
          busy={busy}
          onRefreshTargets={() => void refreshTargets()}
          onSettings={(settings) => {
            setSnapshot((current) => (current ? { ...current, settings } : current));
            void desktop
              .settings(settings)
              .catch((nextError) => setError(errorMessage(nextError)));
          }}
          onStart={(scopeKind, target, settings) =>
            void run(() =>
              desktop.start({
                scopeKind,
                targetId: target.id,
                targetLabel: target.label,
                captureTypedText: settings.captureTypedText,
              }),
            )
          }
        />
      )}
      <footer className="app-footer">
        <button onClick={() => void desktop.openKnowHow()}>
          <Globe2 /> Open KnowHow
        </button>
        <button
          onClick={() => void checkUpdate()}
          disabled={busy || snapshot.update.status === "checking"}
          title={updateStatusLabel(snapshot.update, updateError)}
        >
          {snapshot.update.status === "checking" ? (
            <LoaderCircle className="spin" />
          ) : (
            <RefreshCw />
          )}
          Updates
          {snapshot.update.status === "available" ? (
            <i className="update-dot" aria-hidden="true" />
          ) : null}
        </button>
        <span>v{snapshot.version}</span>
      </footer>
    </div>
  );
}
