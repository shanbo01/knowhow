"use client";

import { ID, type Models } from "appwrite";
import { Building2, CheckCircle2, LoaderCircle, LogOut, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuthGate,
  VerificationGate,
  type BackendState,
} from "./components/auth-gate";
import {
  AssignAdminDialog,
  PlatformView,
  RivetWorkspaceApp,
  SupportRequestDialog,
} from "./components/rivet-workspace-app";
import { account, client } from "../lib/appwrite";
import { clearApiCredential, rivetApi, rivetCommand } from "../lib/rivet-client";
import type { BootstrapResponse, PlatformWorkspace, WorkspaceRole, WorkspaceSummary } from "../lib/rivet-types";

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

const PENDING_INVITE_KEY = "rivet-pending-invite";

function requestedWorkspaceFromLocation() {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("workspaceId") ?? undefined;
}

function rememberInviteFromLocation() {
  if (typeof window === "undefined") return null;
  const token = new URLSearchParams(window.location.search).get("invite");
  if (token) window.sessionStorage.setItem(PENDING_INVITE_KEY, token);
  return token ?? window.sessionStorage.getItem(PENDING_INVITE_KEY);
}

function OpeningRivet() {
  return (
    <main className="opening-screen" aria-live="polite">
      <div className="opening-mark">R</div>
      <LoaderCircle className="spin" aria-hidden="true" />
      <h1>Opening Rivet</h1>
      <p>Verifying Appwrite and restoring your secure session.</p>
    </main>
  );
}

function AppointmentPrompt({
  email,
  busy,
  error,
  onAccept,
  onDismiss,
}: {
  email: string;
  busy: boolean;
  error: string;
  onAccept: () => Promise<void>;
  onDismiss: () => void;
}) {
  return (
    <main className="onboarding-shell">
      <header className="onboarding-header">
        <Link className="brand-lockup" href="/">
          <span className="brand-mark">R</span>
          <span>Rivet</span>
        </Link>
      </header>
      <section className="onboarding-card">
        <p className="eyebrow">Administrator appointment</p>
        <h1>Become a workspace administrator</h1>
        <p className="lede">
          A Rivet platform administrator appointed <strong>{email}</strong> as the administrator
          of a client workspace. Accepting adds you as that workspace&apos;s administrator and is
          recorded in its audit history. This appointment is single-use and expires within 14 days.
        </p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button className="button secondary" type="button" disabled={busy} onClick={onDismiss}>
            Not now
          </button>
          <button className="button primary" type="button" disabled={busy} onClick={() => void onAccept()}>
            {busy ? <LoaderCircle className="spin" /> : <CheckCircle2 />}
            Accept administrator appointment
          </button>
        </div>
      </section>
    </main>
  );
}

function WorkspaceRecovery({
  message,
  busy,
  onRetry,
  onSignOut,
}: {
  message: string;
  busy: boolean;
  onRetry: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  return (
    <main className="opening-screen recovery-screen" role="alert">
      <div className="opening-mark">R</div>
      <h1>Rivet could not open your workspace</h1>
      <p>{message || "The workspace service is temporarily unavailable."}</p>
      <div className="recovery-actions">
        <button className="button primary" type="button" disabled={busy} onClick={() => void onRetry()}>
          {busy ? <LoaderCircle className="spin" /> : null} Retry workspace
        </button>
        <button className="button secondary" type="button" disabled={busy} onClick={() => void onSignOut()}>
          <LogOut /> Sign out
        </button>
      </div>
    </main>
  );
}

function WorkspaceOnboarding({
  viewerName,
  canCreateWorkspace,
  platform,
  eligibleWorkspaces,
  pendingWorkspaceIds,
  busy,
  error,
  onCreate,
  onRequestJoin,
  onSetWorkspaceStatus,
  onAssignAdministrator,
  onRequestSupport,
  onUpdateSettings,
  onRevokeAppointment,
  onSignOut,
}: {
  viewerName: string;
  canCreateWorkspace: boolean;
  platform?: NonNullable<BootstrapResponse["platform"]>;
  eligibleWorkspaces: WorkspaceSummary[];
  pendingWorkspaceIds: string[];
  busy: boolean;
  error: string;
  onCreate: (name: string) => Promise<void>;
  onRequestJoin: (workspaceId: string) => Promise<void>;
  onSetWorkspaceStatus: (workspaceId: string, status: "active" | "suspended" | "archived") => Promise<void>;
  onAssignAdministrator: (workspaceId: string, email: string) => Promise<void>;
  onRequestSupport: (workspaceId: string, requestedRole: WorkspaceRole, reason: string, requestedDurationHours: number) => Promise<void>;
  onUpdateSettings: (limit: number) => Promise<void>;
  onRevokeAppointment: (appointmentId: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [assigningWorkspace, setAssigningWorkspace] = useState<PlatformWorkspace | null>(null);
  const [requestingWorkspace, setRequestingWorkspace] = useState<PlatformWorkspace | null>(null);

  return (
    <main className="onboarding-shell">
      <header className="onboarding-header">
        <Link className="brand-lockup" href="/">
          <span className="brand-mark">R</span>
          <span>Rivet</span>
        </Link>
        <button className="button ghost" type="button" onClick={onSignOut}>
          <LogOut /> Sign out
        </button>
      </header>
      <section className="onboarding-card">
        <p className="eyebrow">Verified account</p>
        <h1>Welcome, {viewerName || "there"}</h1>
        <p className="lede">Create your own workspace, request access to an eligible workspace, or redeem a signed invitation from its administrator. Domain eligibility never grants access by itself.</p>

        {eligibleWorkspaces.length ? (
          <div className="eligible-list">
            <div className="section-heading compact">
              <div>
                <h2>Eligible workspaces</h2>
                <p>Your verified email matches an approved domain.</p>
              </div>
            </div>
            {eligibleWorkspaces.map((workspace) => {
              const pending = pendingWorkspaceIds.includes(workspace.id);
              return (
                <div className="eligible-row" key={workspace.id}>
                  <span className="workspace-avatar"><Building2 /></span>
                  <span>
                    <strong>{workspace.name}</strong>
                    <small>Administrator approval required</small>
                  </span>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={busy || pending}
                    onClick={() => onRequestJoin(workspace.id)}
                  >
                    {pending ? <><CheckCircle2 /> Requested</> : "Request access"}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        {error ? <p className="form-error" role="alert">{error}</p> : null}

        <form
          className="create-workspace-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (name.trim().length < 2) return;
            await onCreate(name.trim());
          }}
        >
          <div className="section-heading compact">
            <div>
              <h2>{canCreateWorkspace ? "Create a workspace for a client" : "Create your own workspace"}</h2>
              <p>You become its first administrator.</p>
            </div>
          </div>
          <label className="field">
            <span>Organization or team name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Northstar Operations"
              disabled={busy}
            />
          </label>
          <button className="button primary" type="submit" disabled={busy || name.trim().length < 2}>
            {busy ? <LoaderCircle className="spin" /> : <Plus />}
            Create workspace
          </button>
        </form>
        <div className="access-guidance"><h2>Need access to another workspace?</h2><p>Ask a workspace administrator for a signed invitation link. They can also approve your exact email domain so you can submit a join request here.</p></div>
      </section>
      {platform ? (
        <section className="onboarding-platform" aria-label="Platform administration">
          <PlatformView
            platform={platform}
            busy={busy}
            onStatus={(workspaceId, status) => {
              if (!window.confirm(`${status === "active" ? "Restore" : status === "suspended" ? "Suspend" : "Archive"} this workspace?`)) return;
              void onSetWorkspaceStatus(workspaceId, status).catch(() => undefined);
            }}
            onAssign={setAssigningWorkspace}
            onRequestSupport={setRequestingWorkspace}
            onUpdateSettings={onUpdateSettings}
            onRevokeAppointment={(appointment) => {
              if (window.confirm(`Revoke the administrator appointment for ${appointment.email}?`)) void onRevokeAppointment(appointment.id).catch(() => undefined);
            }}
          />
        </section>
      ) : null}
      {assigningWorkspace ? (
        <AssignAdminDialog
          workspace={assigningWorkspace}
          busy={busy}
          onClose={() => setAssigningWorkspace(null)}
          onAssign={async (email) => {
            await onAssignAdministrator(assigningWorkspace.id, email);
            setAssigningWorkspace(null);
          }}
        />
      ) : null}
      {requestingWorkspace ? (
        <SupportRequestDialog
          workspace={requestingWorkspace}
          busy={busy}
          onClose={() => setRequestingWorkspace(null)}
          onRequest={async (requestedRole, reason, requestedDurationHours) => {
            await onRequestSupport(requestingWorkspace.id, requestedRole, reason, requestedDurationHours);
            setRequestingWorkspace(null);
          }}
        />
      ) : null}
    </main>
  );
}

export default function Home() {
  const [backendState, setBackendState] = useState<BackendState>("checking");
  const [backendMessage, setBackendMessage] = useState("");
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verificationSent, setVerificationSent] = useState(false);
  const [user, setUser] = useState<Models.User<Models.Preferences> | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [pendingWorkspaceIds, setPendingWorkspaceIds] = useState<string[]>([]);
  const [appointmentToken, setAppointmentToken] = useState<string | null>(null);
  const inviteAttempted = useRef<string | null>(null);

  const appointmentFromLocation = useCallback(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("appointment");
  }, []);

  const checkBackend = useCallback(async () => {
    setBackendState("checking");
    setBackendMessage("Verifying the identity service.");
    try {
      await client.ping();
      setBackendState("connected");
      setBackendMessage("Secure identity service connected.");
      return true;
    } catch (nextError) {
      setBackendState("failed");
      setBackendMessage(errorMessage(nextError));
      return false;
    }
  }, []);

  const loadBootstrap = useCallback(async (workspaceId?: string) => {
    const query = workspaceId
      ? `?workspaceId=${encodeURIComponent(workspaceId)}`
      : "";
    const next = await rivetApi<BootstrapResponse>(`/api/rivet${query}`);
    setBootstrap(next);
    const selected = next.activeWorkspace?.workspace.id ?? next.workspaces[0]?.id ?? "";
    setActiveWorkspaceId(selected);
    return next;
  }, []);

  const restore = useCallback(async () => {
    setBooting(true);
    setError("");
    await checkBackend();
    rememberInviteFromLocation();
    setAppointmentToken(appointmentFromLocation());
    let nextUser: Models.User<Models.Preferences>;
    try {
      nextUser = await account.get();
    } catch {
      setUser(null);
      setBootstrap(null);
      setBooting(false);
      return;
    }
    setUser(nextUser);
    try {
      if (nextUser.emailVerification) {
        await loadBootstrap(requestedWorkspaceFromLocation());
      }
    } catch (nextError) {
      setBootstrap(null);
      setError(errorMessage(nextError));
    } finally {
      setBooting(false);
    }
  }, [appointmentFromLocation, checkBackend, loadBootstrap]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void restore());
    return () => window.cancelAnimationFrame(frame);
  }, [restore]);

  useEffect(() => {
    if (!user?.emailVerification || !bootstrap) return;
    const token = rememberInviteFromLocation();
    if (!token || inviteAttempted.current === token) return;
    inviteAttempted.current = token;
    setBusy(true);
    rivetCommand<{ workspaceId: string }>("redeemInvite", { token })
      .then(async ({ workspaceId }) => {
        window.sessionStorage.removeItem(PENDING_INVITE_KEY);
        window.history.replaceState({}, "", window.location.pathname);
        await loadBootstrap(workspaceId);
      })
      .catch((nextError) => setError(errorMessage(nextError)))
      .finally(() => setBusy(false));
  }, [bootstrap, loadBootstrap, user]);

  const signIn = async (email: string, password: string) => {
    setBusy(true);
    setError("");
    try {
      await account.createEmailPasswordSession({ email, password });
      clearApiCredential();
      const nextUser = await account.get();
      setUser(nextUser);
      if (nextUser.emailVerification) {
        try {
          await loadBootstrap(requestedWorkspaceFromLocation());
        } catch (nextError) {
          setBootstrap(null);
          setError(errorMessage(nextError));
        }
      }
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const signUp = async (name: string, email: string, password: string) => {
    setBusy(true);
    setError("");
    try {
      await account.create({ userId: ID.unique(), email, password, name });
      await account.createEmailPasswordSession({ email, password });
      clearApiCredential();
      const nextUser = await account.get();
      setUser(nextUser);
      try {
        await account.createVerification({ url: `${window.location.origin}/verify` });
        setVerificationSent(true);
      } catch {
        setVerificationSent(false);
      }
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await account.deleteSession({ sessionId: "current" });
    } finally {
      clearApiCredential();
      setUser(null);
      setBootstrap(null);
      setBusy(false);
    }
  };

  const refreshVerification = async () => {
    setBusy(true);
    setError("");
    try {
      const nextUser = await account.get();
      setUser(nextUser);
      if (nextUser.emailVerification) {
        await loadBootstrap(requestedWorkspaceFromLocation());
      }
      else setError("The email is not verified yet. Open the link in your inbox first.");
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };

  const sendVerification = async () => {
    setBusy(true);
    setError("");
    try {
      await account.createVerification({ url: `${window.location.origin}/verify` });
      setVerificationSent(true);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };

  const selectWorkspace = async (workspaceId: string) => {
    setBusy(true);
    setError("");
    try {
      setActiveWorkspaceId(workspaceId);
      await loadBootstrap(workspaceId);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };

  const setPlatformWorkspaceStatus = async (
    workspaceId: string,
    status: "active" | "suspended" | "archived",
  ) => {
    setBusy(true);
    setError("");
    try {
      await rivetCommand("setWorkspaceStatus", { targetWorkspaceId: workspaceId, status });
      await loadBootstrap(requestedWorkspaceFromLocation());
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const assignPlatformWorkspaceAdministrator = async (workspaceId: string, email: string) => {
    setBusy(true);
    setError("");
    try {
      await rivetCommand("assignWorkspaceAdministrator", {
        targetWorkspaceId: workspaceId,
        email,
      });
      await loadBootstrap(requestedWorkspaceFromLocation());
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const requestSupportAccess = async (
    workspaceId: string,
    requestedRole: WorkspaceRole,
    reason: string,
    requestedDurationHours: number,
  ) => {
    setBusy(true);
    setError("");
    try {
      await rivetCommand("requestSupportAccess", {
        workspaceId,
        requestedRole,
        reason,
        requestedDurationHours,
      });
      await loadBootstrap(requestedWorkspaceFromLocation());
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const updatePlatformSettings = async (limit: number) => {
    setBusy(true);
    setError("");
    try {
      await rivetCommand("updatePlatformSettings", { selfServiceWorkspaceLimit: limit });
      await loadBootstrap(requestedWorkspaceFromLocation());
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const revokePlatformAppointment = async (appointmentId: string) => {
    setBusy(true);
    setError("");
    try {
      await rivetCommand("revokeAppointment", { appointmentId });
      await loadBootstrap(requestedWorkspaceFromLocation());
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const acceptAppointment = async () => {
    if (!appointmentToken) return;
    setBusy(true);
    setError("");
    try {
      const result = await rivetCommand<{ workspaceId: string }>("acceptAppointment", {
        token: appointmentToken,
      });
      setAppointmentToken(null);
      window.history.replaceState({}, "", window.location.pathname);
      await loadBootstrap(result.workspaceId);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };

  const dismissAppointment = () => {
    setAppointmentToken(null);
    setError("");
    window.history.replaceState({}, "", window.location.pathname);
  };

  if (booting) return <OpeningRivet />;

  if (!user) {
    return (
      <AuthGate
        backendState={backendState}
        backendMessage={backendMessage}
        busy={busy}
        error={error}
        onRetryBackend={checkBackend}
        onSignIn={signIn}
        onSignUp={signUp}
      />
    );
  }

  if (!user.emailVerification) {
    return (
      <VerificationGate
        email={user.email}
        busy={busy}
        sent={verificationSent}
        error={error}
        onSend={sendVerification}
        onRefresh={refreshVerification}
        onSignOut={signOut}
      />
    );
  }

  if (!bootstrap) {
    return (
      <WorkspaceRecovery
        message={error}
        busy={busy}
        onRetry={async () => {
          setBusy(true);
          setError("");
          try {
            await checkBackend();
            await loadBootstrap(requestedWorkspaceFromLocation());
          } catch (nextError) {
            setError(errorMessage(nextError));
          } finally {
            setBusy(false);
          }
        }}
        onSignOut={signOut}
      />
    );
  }

  if (appointmentToken && user?.emailVerification && bootstrap) {
    return (
      <AppointmentPrompt
        email={user.email}
        busy={busy}
        error={error}
        onAccept={acceptAppointment}
        onDismiss={dismissAppointment}
      />
    );
  }

  if (!bootstrap.activeWorkspace) {
    return (
      <WorkspaceOnboarding
        viewerName={bootstrap.viewer.name}
        canCreateWorkspace={bootstrap.viewer.platformAdministrator}
        platform={bootstrap.platform}
        eligibleWorkspaces={bootstrap.eligibleWorkspaces ?? []}
        pendingWorkspaceIds={pendingWorkspaceIds}
        busy={busy}
        error={error}
        onCreate={async (name) => {
          setBusy(true);
          setError("");
          try {
            const result = await rivetCommand<{ workspaceId: string }>("createWorkspace", { name });
            await loadBootstrap(result.workspaceId);
          } catch (nextError) {
            setError(errorMessage(nextError));
          } finally {
            setBusy(false);
          }
        }}
        onRequestJoin={async (workspaceId) => {
          setBusy(true);
          setError("");
          try {
            await rivetCommand("requestDomainJoin", { workspaceId });
            setPendingWorkspaceIds((items) => [...new Set([...items, workspaceId])]);
          } catch (nextError) {
            setError(errorMessage(nextError));
          } finally {
            setBusy(false);
          }
        }}
        onSetWorkspaceStatus={setPlatformWorkspaceStatus}
        onAssignAdministrator={assignPlatformWorkspaceAdministrator}
        onRequestSupport={requestSupportAccess}
        onUpdateSettings={updatePlatformSettings}
        onRevokeAppointment={revokePlatformAppointment}
        onSignOut={signOut}
      />
    );
  }

  return (
    <RivetWorkspaceApp
      key={activeWorkspaceId}
      data={bootstrap}
      activeWorkspaceId={activeWorkspaceId}
      busy={busy}
      globalError={error}
      onSelectWorkspace={selectWorkspace}
      onRefresh={() => loadBootstrap(activeWorkspaceId)}
      onSignOut={signOut}
      onBusyChange={setBusy}
      onError={setError}
    />
  );
}
