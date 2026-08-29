"use client";

import {
  CheckCircle2,
  LaptopMinimal,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KnowHowApiError,
  knowhowApi,
  knowhowCommand,
} from "../../../../lib/knowhow-client";
import type {
  BootstrapResponse,
  WorkspaceSummary,
} from "../../../../lib/knowhow-types";

const RETURN_TO_KEY = "knowhow:return-to-after-auth";

type AuthorizationDetails = {
  authorizationId: string;
  status:
    | "authorization_pending"
    | "authorization_approved"
    | "authorization_denied"
    | "expired";
  expiresAt: string;
  workspace: { id: string; name: string };
  device: {
    id: string;
    name: string;
    architecture: "x64" | "arm64";
    version: string;
  };
};

function eligible(workspace: WorkspaceSummary) {
  return (
    workspace.accessKind === "membership" &&
    workspace.status === "active" &&
    workspace.desktopCaptureEnabled &&
    workspace.subscription?.access === "active" &&
    (workspace.roles.includes("administrator") ||
      workspace.roles.includes("creator"))
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "KnowHow could not load this device authorization.";
}

export default function DesktopAuthorizationClient({
  authorizationId,
}: {
  authorizationId: string;
}) {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [details, setDetails] = useState<AuthorizationDetails | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ready" | "approving" | "approved" | "denied" | "error"
  >("loading");
  const [error, setError] = useState("");

  const workspaces = useMemo(
    () => bootstrap?.workspaces.filter(eligible) ?? [],
    [bootstrap],
  );

  const returnToSignIn = useCallback(() => {
    const returnTo = `/desktop/authorize/${encodeURIComponent(authorizationId)}`;
    window.sessionStorage.setItem(RETURN_TO_KEY, returnTo);
    window.location.assign("/app?mode=sign-in");
  }, [authorizationId]);

  const inspect = useCallback(
    async (targetWorkspaceId: string) => {
      setError("");
      setStatus("loading");
      try {
        const next = await knowhowCommand<AuthorizationDetails>(
          "inspectDesktopAuthorization",
          { workspaceId: targetWorkspaceId, authorizationId },
        );
        setDetails(next);
        setStatus(
          next.status === "authorization_approved"
            ? "approved"
            : next.status === "authorization_denied"
              ? "denied"
              : "ready",
        );
      } catch (nextError) {
        if (nextError instanceof KnowHowApiError && nextError.status === 401) {
          returnToSignIn();
          return;
        }
        setError(errorMessage(nextError));
        setStatus("error");
      }
    },
    [authorizationId, returnToSignIn],
  );

  useEffect(() => {
    let active = true;
    knowhowApi<BootstrapResponse>("/api/knowhow")
      .then((next) => {
        if (!active) return;
        setBootstrap(next);
        const preferred =
          (next.activeWorkspace && eligible(next.activeWorkspace.workspace)
            ? next.activeWorkspace.workspace
            : next.workspaces.find(eligible)) ?? null;
        if (!preferred) {
          setError(
            "An active Pro workspace where you are a creator or administrator is required to connect KnowHow Capture.",
          );
          setStatus("error");
          return;
        }
        setWorkspaceId(preferred.id);
        void inspect(preferred.id);
      })
      .catch((nextError) => {
        if (!active) return;
        if (nextError instanceof KnowHowApiError && nextError.status === 401) {
          returnToSignIn();
          return;
        }
        setError(errorMessage(nextError));
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [inspect, returnToSignIn]);

  async function decide(decision: "approve" | "deny") {
    if (!workspaceId) return;
    setStatus(decision === "approve" ? "approving" : "loading");
    setError("");
    try {
      await knowhowCommand(
        decision === "approve"
          ? "approveDesktopAuthorization"
          : "denyDesktopAuthorization",
        { workspaceId, authorizationId },
      );
      setStatus(decision === "approve" ? "approved" : "denied");
    } catch (nextError) {
      setError(errorMessage(nextError));
      setStatus("error");
    }
  }

  const expired = details?.status === "expired";

  return (
    <main className="desktop-authorization-page">
      <Link className="desktop-authorization-brand" href="/" aria-label="KnowHow home">
        <span>KH</span>
        <strong>KnowHow</strong>
      </Link>
      <section className="desktop-authorization-card" aria-live="polite">
        {status === "loading" && !details ? (
          <div className="desktop-authorization-state">
            <LoaderCircle className="spin" />
            <h1>Checking this device</h1>
            <p>Confirming your signed-in workspace and authorization request.</p>
          </div>
        ) : status === "approved" ? (
          <div className="desktop-authorization-state success">
            <CheckCircle2 />
            <p className="eyebrow">Device connected</p>
            <h1>Return to KnowHow Capture</h1>
            <p>
              {details?.device.name ?? "This Windows device"} will connect
              automatically. You can close this tab.
            </p>
            <Link className="button primary" href="/app">
              Open KnowHow
            </Link>
          </div>
        ) : status === "denied" ? (
          <div className="desktop-authorization-state denied">
            <XCircle />
            <p className="eyebrow">Connection declined</p>
            <h1>This device was not connected</h1>
            <p>Return to the desktop app if you want to start a new request.</p>
          </div>
        ) : expired ? (
          <div className="desktop-authorization-state denied">
            <XCircle />
            <p className="eyebrow">Request expired</p>
            <h1>Start again in KnowHow Capture</h1>
            <p>Device requests expire after ten minutes for your protection.</p>
          </div>
        ) : details ? (
          <>
            <div className="desktop-authorization-heading">
              <span className="desktop-device-icon">
                <LaptopMinimal />
              </span>
              <div>
                <p className="eyebrow">Windows desktop capture</p>
                <h1>Connect this device?</h1>
                <p>
                  Approve the named device only if you opened KnowHow Capture
                  yourself.
                </p>
              </div>
            </div>
            <dl className="desktop-device-details">
              <div>
                <dt>Device</dt>
                <dd>{details.device.name}</dd>
              </div>
              <div>
                <dt>App</dt>
                <dd>KnowHow Capture {details.device.version}</dd>
              </div>
              <div>
                <dt>Architecture</dt>
                <dd>{details.device.architecture.toUpperCase()}</dd>
              </div>
            </dl>
            <label className="desktop-workspace-picker">
              <span>Connect to workspace</span>
              <select
                value={workspaceId}
                disabled={status === "approving"}
                onChange={(event) => {
                  const next = event.target.value;
                  setWorkspaceId(next);
                  void inspect(next);
                }}
              >
                {workspaces.map((workspace) => (
                  <option value={workspace.id} key={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="desktop-authorization-safeguards">
              <p>
                <ShieldCheck /> Capture is limited by your role, workspace
                policy, and device credential.
              </p>
              <p>
                <LockKeyhole /> Passwords, secure Windows surfaces, raw keys,
                and clipboard contents are never captured.
              </p>
            </div>
            {error ? <p className="form-error">{error}</p> : null}
            <div className="desktop-authorization-actions">
              <button
                className="button ghost"
                type="button"
                disabled={status === "approving"}
                onClick={() => void decide("deny")}
              >
                Not this device
              </button>
              <button
                className="button primary"
                type="button"
                disabled={status === "approving"}
                onClick={() => void decide("approve")}
              >
                {status === "approving" ? (
                  <>
                    <LoaderCircle className="spin" /> Connecting
                  </>
                ) : (
                  "Connect this device"
                )}
              </button>
            </div>
          </>
        ) : (
          <div className="desktop-authorization-state denied">
            <XCircle />
            <h1>Connection unavailable</h1>
            <p>{error}</p>
            <button className="button secondary" onClick={() => window.location.reload()}>
              Try again
            </button>
          </div>
        )}
      </section>
      <p className="desktop-authorization-footer">
        No password, copied code, browser cookie, or custom protocol is sent to
        the desktop app.
      </p>
    </main>
  );
}
