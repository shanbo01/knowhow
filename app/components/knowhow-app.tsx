"use client";

import {
  Building2,
  CalendarClock,
  CheckCircle2,
  LoaderCircle,
  LogOut,
  Mail,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AuthGate,
  MfaEnrollmentGate,
  MfaGate,
  VerificationGate,
  type BackendState,
} from "./auth-gate";
import {
  AssignAdminDialog,
  OrganizationView,
  PlatformProvisioningDialog,
  PlatformView,
  KnowHowWorkspaceApp,
  SupportRequestDialog,
} from "./knowhow-workspace-app";
import { ProductBrand } from "./product-brand";
import {
  clearApiCredential,
  knowhowApi,
  knowhowCommand,
  registerReauthenticationHandler,
} from "../../lib/knowhow-client";
import {
  authHealth,
  beginMfaChallenge,
  beginMfaEnrollment,
  completeMfaChallenge,
  completeMfaEnrollment,
  getAuthSession,
  getMfaRequirement,
  sendEmailVerification,
  signInWithPassword,
  signOutSession,
  signUp as signUpAccount,
  type SessionUser,
} from "../../lib/auth-client";
import type { NavigationGuard } from "../../lib/navigation-guard";
import type {
  BootstrapResponse,
  OrganizationAdministration,
  OrganizationRole,
  PlatformProvisioningResult,
  PlatformWorkspace,
  WorkspaceRole,
} from "../../lib/knowhow-types";
import {
  guideEditorHref,
  guideHref,
  parseAppRoute,
  routeWorkspaceSlug,
  workspaceHref,
  type AppRoute,
} from "../../lib/workspace-routes";

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

const PENDING_INVITE_KEY = "knowhow-pending-invite";

function locationKeyFromWindow() {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}`;
}

function rememberInviteFromLocation() {
  if (typeof window === "undefined") return null;
  const token = new URLSearchParams(window.location.search).get("invite");
  if (token) window.sessionStorage.setItem(PENDING_INVITE_KEY, token);
  return token ?? window.sessionStorage.getItem(PENDING_INVITE_KEY);
}

function OpeningKnowHow() {
  return (
    <main className="opening-screen" aria-live="polite">
      <ProductBrand markOnly className="opening-product-brand" />
      <LoaderCircle className="spin" aria-hidden="true" />
      <h1>Opening KnowHow</h1>
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
          <ProductBrand compact />
        </Link>
      </header>
      <section className="onboarding-card">
        <p className="eyebrow">Administrator appointment</p>
        <h1>Become a workspace administrator</h1>
        <p className="lede">
          A KnowHow platform administrator appointed <strong>{email}</strong> as
          the administrator of a client workspace. Accepting adds you as that
          workspace&apos;s administrator and is recorded in its audit history.
          This appointment is single-use and expires within 14 days.
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={onDismiss}
          >
            Not now
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy}
            onClick={() => void onAccept()}
          >
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
      <ProductBrand markOnly className="opening-product-brand" />
      <h1>KnowHow could not open your workspace</h1>
      <p>{message || "The workspace service is temporarily unavailable."}</p>
      <div className="recovery-actions">
        <button
          className="button primary"
          type="button"
          disabled={busy}
          onClick={() => void onRetry()}
        >
          {busy ? <LoaderCircle className="spin" /> : null} Retry workspace
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={busy}
          onClick={() => void onSignOut()}
        >
          <LogOut /> Sign out
        </button>
      </div>
    </main>
  );
}

function SubscriptionRecovery({
  recovery,
  busy,
  error,
  onRevokeDevices,
  onRetry,
  onSignOut,
}: {
  recovery: NonNullable<BootstrapResponse["recovery"]>;
  busy: boolean;
  error: string;
  onRevokeDevices: () => Promise<void>;
  onRetry: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const state = recovery.workspace.subscription;
  return (
    <main className="onboarding-shell">
      <header className="onboarding-header">
        <Link className="brand-lockup" href="/">
          <ProductBrand compact />
        </Link>
        <button className="button ghost" type="button" onClick={onSignOut}>
          <LogOut /> Sign out
        </button>
      </header>
      <section className="onboarding-card recovery-card" role="status">
        <p className="eyebrow">Subscription recovery</p>
        <h1>{recovery.workspace.name}</h1>
        <div className="recovery-status">
          <CalendarClock />
          <span>
            <strong>
              {state?.access === "deletion_pending"
                ? "Deletion approval pending"
                : state?.access === "deleting"
                  ? "Deletion in progress"
                  : "Workspace suspended"}
            </strong>
            <small>
              {state?.deletionEligibleAt
                ? `Deletion eligibility: ${new Date(state.deletionEligibleAt).toLocaleDateString()}`
                : "Contact KnowHow for lifecycle details."}
            </small>
          </span>
        </div>
        <p className="lede">{recovery.message}</p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="recovery-actions">
          {recovery.contactEnabled ? (
            <Link className="button primary" href="/contact">
              <Mail /> Contact KnowHow
            </Link>
          ) : null}
          {recovery.extensionActionsEnabled ? (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void onRevokeDevices()}
            >
              <Unplug /> Revoke my extension devices
            </button>
          ) : null}
          <button
            className="button ghost"
            type="button"
            disabled={busy}
            onClick={() => void onRetry()}
          >
            {busy ? <LoaderCircle className="spin" /> : null} Refresh status
          </button>
        </div>
      </section>
    </main>
  );
}

function WorkspaceOnboarding({
  viewerName,
  canCreateWorkspace,
  platform,
  organizations,
  busy,
  error,
  onSaveProvisioning,
  onCompleteProvisioning,
  onAppointOrganizationMember,
  onUpdateOrganizationMember,
  onSaveOrganizationDomains,
  onSetWorkspaceStatus,
  onAssignAdministrator,
  onRequestSupport,
  onExtendSubscription,
  onConvertSubscription,
  onApproveDeletion,
  onRevokeAppointment,
  onSignOut,
}: {
  viewerName: string;
  canCreateWorkspace: boolean;
  platform?: NonNullable<BootstrapResponse["platform"]>;
  organizations: OrganizationAdministration[];
  busy: boolean;
  error: string;
  onSaveProvisioning: (
    runId: string | null,
    step: number,
    data: Record<string, unknown>,
  ) => Promise<{
    runId: string;
    currentStep: number;
    completedSteps: number[];
  }>;
  onCompleteProvisioning: (
    runId: string,
  ) => Promise<PlatformProvisioningResult>;
  onAppointOrganizationMember: (
    organizationId: string,
    email: string,
    roles: OrganizationRole[],
    anchorWorkspaceId: string,
  ) => Promise<{
    appointmentId: string;
    appointmentToken: string;
    expiresAt: string;
  }>;
  onUpdateOrganizationMember: (
    organizationId: string,
    memberId: string,
    roles: OrganizationRole[],
    status: "active" | "revoked",
  ) => Promise<unknown>;
  onSaveOrganizationDomains: (
    organizationId: string,
    domains: string[],
  ) => Promise<unknown>;
  onSetWorkspaceStatus: (
    workspaceId: string,
    status: "active" | "suspended" | "archived",
  ) => Promise<void>;
  onAssignAdministrator: (workspaceId: string, email: string) => Promise<void>;
  onRequestSupport: (
    workspaceId: string,
    requestedRole: WorkspaceRole,
    reason: string,
    requestedDurationHours: number,
  ) => Promise<void>;
  onExtendSubscription: (
    workspaceId: string,
    expiresAt: string,
    graceDays: number,
    retentionDays: number,
  ) => Promise<unknown>;
  onConvertSubscription: (
    workspaceId: string,
    manualReference: string,
    expiresAt: string | null,
  ) => Promise<unknown>;
  onApproveDeletion: (caseId: string, confirmation: string) => Promise<unknown>;
  onRevokeAppointment: (appointmentId: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [provisioningOpen, setProvisioningOpen] = useState(false);
  const [assigningWorkspace, setAssigningWorkspace] =
    useState<PlatformWorkspace | null>(null);
  const [requestingWorkspace, setRequestingWorkspace] =
    useState<PlatformWorkspace | null>(null);

  return (
    <main className="onboarding-shell">
      <header className="onboarding-header">
        <Link className="brand-lockup" href="/">
          <ProductBrand compact />
        </Link>
        <button className="button ghost" type="button" onClick={onSignOut}>
          <LogOut /> Sign out
        </button>
      </header>
      <section className="onboarding-card">
        <p className="eyebrow">Verified account</p>
        <h1>Welcome, {viewerName || "there"}</h1>
        <p className="lede">
          KnowHow pilots are invitation-only. Redeem a signed invitation or
          administrator appointment issued to your exact verified email
          address. Every credential is single-use, expires, and is audited.
        </p>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        {canCreateWorkspace ? (
          <div className="create-workspace-form">
            <div className="section-heading compact">
              <div>
                <h2>Provision a controlled pilot organization</h2>
                <p>
                  The resumable six-step workflow requires private branding,
                  explicit workspace administrators, pilot limits, and two
                  organization owners.
                </p>
              </div>
            </div>
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => setProvisioningOpen(true)}
            >
              <Building2 /> Provision organization
            </button>
          </div>
        ) : null}
        <div className="access-guidance">
          <h2>Need access to another workspace?</h2>
          <p>
            Ask a workspace administrator to issue a signed invitation to your
            exact email address. Domain matching never grants access.
          </p>
        </div>
      </section>
      {organizations.map((organization) => (
        <section
          className="onboarding-platform"
          aria-label={`${organization.displayName} organization administration`}
          key={organization.id}
        >
          <OrganizationView
            organization={organization}
            busy={busy}
            onAppoint={(email, roles, anchorWorkspaceId) =>
              onAppointOrganizationMember(
                organization.id,
                email,
                roles,
                anchorWorkspaceId,
              )
            }
            onUpdate={(memberId, roles, status) =>
              onUpdateOrganizationMember(
                organization.id,
                memberId,
                roles,
                status,
              )
            }
            onSaveDomains={(domains) =>
              onSaveOrganizationDomains(organization.id, domains)
            }
            onRevokeAppointment={onRevokeAppointment}
          />
        </section>
      ))}
      {platform ? (
        <section
          className="onboarding-platform"
          aria-label="Platform administration"
        >
          <PlatformView
            platform={platform}
            busy={busy}
            onProvision={() => setProvisioningOpen(true)}
            onStatus={(workspaceId, status) => {
              if (
                !window.confirm(
                  `${status === "active" ? "Restore" : status === "suspended" ? "Suspend" : "Archive"} this workspace?`,
                )
              )
                return;
              void onSetWorkspaceStatus(workspaceId, status).catch(
                () => undefined,
              );
            }}
            onAssign={setAssigningWorkspace}
            onRequestSupport={setRequestingWorkspace}
            onExtendSubscription={onExtendSubscription}
            onConvertSubscription={onConvertSubscription}
            onApproveDeletion={onApproveDeletion}
            onRevokeAppointment={(appointment) => {
              if (
                window.confirm(
                  `Revoke the administrator appointment for ${appointment.email}?`,
                )
              )
                void onRevokeAppointment(appointment.id).catch(() => undefined);
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
            await onRequestSupport(
              requestingWorkspace.id,
              requestedRole,
              reason,
              requestedDurationHours,
            );
            setRequestingWorkspace(null);
          }}
        />
      ) : null}
      {provisioningOpen && platform ? (
        <PlatformProvisioningDialog
          busy={busy}
          initialRun={platform.provisioningRuns[0]}
          onClose={() => setProvisioningOpen(false)}
          onSave={onSaveProvisioning}
          onComplete={onCompleteProvisioning}
        />
      ) : null}
    </main>
  );
}

export default function Home() {
  const publicSignUp =
    process.env.NEXT_PUBLIC_KNOWHOW_PUBLIC_SIGNUP_ENABLED === "1";
  const [backendState, setBackendState] = useState<BackendState>("checking");
  const [backendMessage, setBackendMessage] = useState("");
  const [locationKey, setLocationKey] = useState("/");
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verificationSent, setVerificationSent] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [signupCredential, setSignupCredential] = useState<{
    kind: "invite" | "appointment";
    token: string;
  } | null>(null);
  const [mfaPrompt, setMfaPrompt] = useState<{
    challengeId: string;
    factor: "totp" | "recoveryCode";
    purpose?: "signin" | "reauthentication";
  } | null>(null);
  const [reauthenticationBusy, setReauthenticationBusy] = useState(false);
  const [mfaFactors, setMfaFactors] = useState<Array<"totp" | "recoveryCode">>(
    [],
  );
  const [mfaEnrollment, setMfaEnrollment] = useState<{
    secret?: string;
    qrCodeDataUrl?: string;
    recoveryCodes?: string[];
  } | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [appointmentToken, setAppointmentToken] = useState<string | null>(null);
  const inviteAttempted = useRef<string | null>(null);
  const locationKeyRef = useRef(locationKey);
  const navigationGuardRef = useRef<NavigationGuard | null>(null);
  const reauthenticationResolver = useRef<{
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);

  const route = useMemo<AppRoute>(() => {
    const location = new URL(locationKey, "https://knowhow.local");
    return parseAppRoute(location.pathname, location.search);
  }, [locationKey]);

  useEffect(() => {
    return registerReauthenticationHandler(async () => {
      const challenge = await beginMfaChallenge("totp");
      if (!challenge.challengeId) {
        throw new Error("KnowHow could not start privileged verification.");
      }
      setError("");
      setReauthenticationBusy(false);
      setMfaFactors(["totp"]);
      setMfaPrompt({
        challengeId: challenge.challengeId,
        factor: "totp",
        purpose: "reauthentication",
      });
      await new Promise<void>((resolve, reject) => {
        reauthenticationResolver.current = { resolve, reject };
      });
    });
  }, []);

  const commitLocation = useCallback((nextLocation: string) => {
    locationKeyRef.current = nextLocation;
    setLocationKey(nextLocation);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const navigate = useCallback(
    (href: string, options: { replace?: boolean } = {}) => {
      if (typeof window === "undefined") return;
      if (href === locationKeyRef.current) return;
      const proceed = () => {
        window.history[options.replace ? "replaceState" : "pushState"](
          {},
          "",
          href,
        );
        commitLocation(locationKeyFromWindow());
      };
      const guard = navigationGuardRef.current;
      if (guard?.shouldBlock()) {
        guard.requestConfirmation({ href, proceed });
        return;
      }
      proceed();
    },
    [commitLocation],
  );

  const registerNavigationGuard = useCallback(
    (guard: NavigationGuard | null) => {
      navigationGuardRef.current = guard;
    },
    [],
  );

  useEffect(() => {
    const updateLocation = () => {
      const nextLocation = locationKeyFromWindow();
      const currentLocation = locationKeyRef.current;
      if (nextLocation === currentLocation) return;
      const proceed = () => {
        window.history.pushState({}, "", nextLocation);
        commitLocation(locationKeyFromWindow());
      };
      const guard = navigationGuardRef.current;
      if (guard?.shouldBlock()) {
        // Browser back/forward has already changed the URL. Restore the
        // current editor route before rendering the custom confirmation.
        window.history.pushState({}, "", currentLocation);
        guard.requestConfirmation({ href: nextLocation, proceed });
        return;
      }
      commitLocation(nextLocation);
    };
    updateLocation();
    window.addEventListener("popstate", updateLocation);
    return () => window.removeEventListener("popstate", updateLocation);
  }, [commitLocation]);

  const appointmentFromLocation = useCallback(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("appointment");
  }, []);

  const checkBackend = useCallback(async () => {
    setBackendState("checking");
    setBackendMessage("Verifying the identity service.");
    try {
      await authHealth();
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
    const next = await knowhowApi<BootstrapResponse>(`/api/knowhow${query}`);
    setBootstrap(next);
    const selected =
      next.activeWorkspace?.workspace.id ?? next.workspaces[0]?.id ?? "";
    setActiveWorkspaceId(selected);
    return next;
  }, []);

  const openWorkspace = useCallback(
    async (workspaceId: string, replace = false) => {
      const next = await loadBootstrap(workspaceId);
      const workspace = next.activeWorkspace?.workspace;
      if (workspace) navigate(workspaceHref(workspace.slug), { replace });
      return next;
    },
    [loadBootstrap, navigate],
  );

  const requireMfaEnrollment = useCallback(async (identity: SessionUser) => {
    if (!identity.emailVerification) return false;
    const requirement = await getMfaRequirement();
    if (requirement.required && !requirement.enabled) {
      setMfaEnrollment({});
      return true;
    }
    return false;
  }, []);

  const restore = useCallback(async () => {
    setBooting(true);
    setError("");
    await checkBackend();
    const invite = rememberInviteFromLocation();
    const appointment = appointmentFromLocation();
    setAppointmentToken(appointment);
    setSignupCredential(
      invite
        ? { kind: "invite", token: invite }
        : appointment
          ? { kind: "appointment", token: appointment }
          : null,
    );
    const nextUser = await getAuthSession().catch(() => null);
    if (!nextUser) {
      setUser(null);
      setBootstrap(null);
      setBooting(false);
      return;
    }
    setUser(nextUser);
    try {
      if (
        nextUser.emailVerification &&
        !(await requireMfaEnrollment(nextUser))
      ) {
        await loadBootstrap();
      }
    } catch (nextError) {
      setBootstrap(null);
      setError(errorMessage(nextError));
    } finally {
      setBooting(false);
    }
  }, [
    appointmentFromLocation,
    checkBackend,
    loadBootstrap,
    requireMfaEnrollment,
  ]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void restore());
    return () => window.cancelAnimationFrame(frame);
  }, [restore]);

  useEffect(() => {
    if (!user?.emailVerification || !bootstrap || appointmentToken) return;
    const frame = window.requestAnimationFrame(() => {
      const activeWorkspace = bootstrap.activeWorkspace?.workspace;
      const fallback =
        activeWorkspace?.status === "active" ? activeWorkspace : undefined;
      const params = new URLSearchParams(window.location.search);

      if (route.kind === "root") {
        // Invitation and appointment tokens must stay on the root route until
        // their one-time flows have completed.
        if (params.has("invite") || params.has("appointment")) return;
        const requestedWorkspaceId = params.get("workspaceId");
        const requestedWorkspace = requestedWorkspaceId
          ? bootstrap.workspaces.find(
              (workspace) =>
                workspace.id === requestedWorkspaceId &&
                workspace.status === "active",
            )
          : fallback;
        if (!requestedWorkspace) return;
        if (activeWorkspace?.id !== requestedWorkspace.id) {
          void loadBootstrap(requestedWorkspace.id).catch((nextError) =>
            setError(errorMessage(nextError)),
          );
          return;
        }
        const guideId = params.get("guide");
        if (guideId) {
          const href =
            params.get("edit") === "1"
              ? guideEditorHref(requestedWorkspace.slug, guideId)
              : guideHref(requestedWorkspace.slug, guideId, "published");
          navigate(href, { replace: true });
          return;
        }
        navigate(workspaceHref(requestedWorkspace.slug), { replace: true });
        return;
      }

      if (route.kind === "invalid") {
        setError("The requested workspace is unavailable.");
        if (fallback) navigate(workspaceHref(fallback.slug), { replace: true });
        return;
      }

      const requestedSlug = routeWorkspaceSlug(route);
      if (!requestedSlug) return;
      const matches = bootstrap.workspaces.filter(
        (workspace) =>
          workspace.slug === requestedSlug && workspace.status === "active",
      );
      if (matches.length !== 1) {
        setError("The requested workspace is unavailable.");
        if (fallback && fallback.slug !== requestedSlug) {
          navigate(workspaceHref(fallback.slug), { replace: true });
        }
        return;
      }
      if (activeWorkspace?.id !== matches[0].id) {
        void loadBootstrap(matches[0].id).catch((nextError) =>
          setError(errorMessage(nextError)),
        );
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [appointmentToken, bootstrap, loadBootstrap, navigate, route, user]);

  useEffect(() => {
    if (!user?.emailVerification || !bootstrap) return;
    const token = rememberInviteFromLocation();
    if (!token || inviteAttempted.current === token) return;
    inviteAttempted.current = token;
    setBusy(true);
    knowhowCommand<{ workspaceId: string }>("redeemInvite", { token })
      .then(async ({ workspaceId }) => {
        window.sessionStorage.removeItem(PENDING_INVITE_KEY);
        await openWorkspace(workspaceId, true);
      })
      .catch((nextError) => setError(errorMessage(nextError)))
      .finally(() => setBusy(false));
  }, [bootstrap, openWorkspace, user]);

  const signIn = async (email: string, password: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await signInWithPassword(email, password);
      clearApiCredential();
      if (result.mfaRequired) {
        const factor = result.factors?.includes("totp")
          ? "totp"
          : "recoveryCode";
        setMfaFactors(
          (result.factors ?? []).filter(
            (item): item is "totp" | "recoveryCode" =>
              item === "totp" || item === "recoveryCode",
          ),
        );
        const challenge = await beginMfaChallenge(factor);
        if (!challenge.challengeId)
          throw new Error("KnowHow could not start multi-factor verification.");
        setMfaPrompt({ challengeId: challenge.challengeId, factor });
        return;
      }
      const nextUser = result.user ?? (await getAuthSession());
      if (!nextUser)
        throw new Error("The secure session could not be restored.");
      setUser(nextUser);
      if (
        nextUser.emailVerification &&
        !(await requireMfaEnrollment(nextUser))
      ) {
        try {
          await loadBootstrap();
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
      if (!signupCredential && !publicSignUp)
        throw new Error(
          "A current invitation is required to create an account.",
        );
      await signUpAccount({
        name,
        email,
        password,
        ...(signupCredential
          ? {
              credentialKind: signupCredential.kind,
              credential: signupCredential.token,
            }
          : {}),
      });
      clearApiCredential();
      const nextUser = await getAuthSession();
      if (!nextUser)
        throw new Error("The secure session could not be restored.");
      setUser(nextUser);
      try {
        await sendEmailVerification(`${window.location.origin}/verify`);
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
      await signOutSession();
    } finally {
      reauthenticationResolver.current?.reject(
        new Error("Privileged verification was cancelled."),
      );
      reauthenticationResolver.current = null;
      clearApiCredential();
      setUser(null);
      setBootstrap(null);
      setMfaEnrollment(null);
      setMfaPrompt(null);
      navigate("/", { replace: true });
      setBusy(false);
    }
  };

  const refreshVerification = async () => {
    setBusy(true);
    setError("");
    try {
      const nextUser = await getAuthSession();
      if (!nextUser)
        throw new Error("Your session has expired. Sign in again.");
      setUser(nextUser);
      if (
        nextUser.emailVerification &&
        !(await requireMfaEnrollment(nextUser))
      ) {
        await loadBootstrap();
      } else
        setError(
          "The email is not verified yet. Open the link in your inbox first.",
        );
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
      await sendEmailVerification(`${window.location.origin}/verify`);
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
      await openWorkspace(workspaceId);
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
      await knowhowCommand("setWorkspaceStatus", {
        targetWorkspaceId: workspaceId,
        status,
      });
      await loadBootstrap(activeWorkspaceId || undefined);
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const assignPlatformWorkspaceAdministrator = async (
    workspaceId: string,
    email: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      await knowhowCommand("assignWorkspaceAdministrator", {
        targetWorkspaceId: workspaceId,
        email,
      });
      await loadBootstrap(activeWorkspaceId || undefined);
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
      await knowhowCommand("requestSupportAccess", {
        workspaceId,
        requestedRole,
        reason,
        requestedDurationHours,
      });
      await loadBootstrap(activeWorkspaceId || undefined);
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const extendPlatformSubscription = async (
    workspaceId: string,
    expiresAt: string,
    graceDays: number,
    retentionDays: number,
  ) => {
    setBusy(true);
    setError("");
    try {
      const result = await knowhowCommand("extendSubscription", {
        targetWorkspaceId: workspaceId,
        expiresAt,
        graceDays,
        retentionDays,
      });
      await loadBootstrap(activeWorkspaceId || undefined);
      return result;
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const convertPlatformSubscription = async (
    workspaceId: string,
    manualReference: string,
    expiresAt: string | null,
  ) => {
    setBusy(true);
    setError("");
    try {
      const result = await knowhowCommand("convertSubscription", {
        targetWorkspaceId: workspaceId,
        manualReference,
        expiresAt,
      });
      await loadBootstrap(activeWorkspaceId || undefined);
      return result;
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const approvePlatformDeletion = async (
    caseId: string,
    confirmation: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      const result = await knowhowCommand("approveDeletionCase", {
        caseId,
        confirmation,
      });
      await loadBootstrap(activeWorkspaceId || undefined);
      return result;
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
      await knowhowCommand("revokeAppointment", { appointmentId });
      await loadBootstrap(activeWorkspaceId || undefined);
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
      const result = await knowhowCommand<{
        workspaceId: string;
        workspaceAccessGranted?: boolean;
      }>("acceptAppointment", {
        token: appointmentToken,
      });
      setAppointmentToken(null);
      if (result.workspaceAccessGranted === false) {
        await loadBootstrap();
        navigate("/", { replace: true });
      } else {
        await openWorkspace(result.workspaceId, true);
      }
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };

  const dismissAppointment = () => {
    setAppointmentToken(null);
    setError("");
    navigate("/", { replace: true });
  };

  if (booting) return <OpeningKnowHow />;

  if (mfaEnrollment) {
    return (
      <MfaEnrollmentGate
        busy={busy}
        error={error}
        secret={mfaEnrollment.secret}
        qrCodeDataUrl={mfaEnrollment.qrCodeDataUrl}
        recoveryCodes={mfaEnrollment.recoveryCodes}
        onBegin={async () => {
          setBusy(true);
          setError("");
          try {
            const setup = await beginMfaEnrollment();
            if (setup.enabled && setup.resumed) {
              if (setup.recoveryCodes?.length) {
                setMfaEnrollment({ recoveryCodes: setup.recoveryCodes });
                return;
              }
              const challenge = await beginMfaChallenge("totp");
              if (!challenge.challengeId) {
                throw new Error(
                  "Multi-factor verification could not be started.",
                );
              }
              setMfaFactors(["totp", "recoveryCode"]);
              setMfaEnrollment(null);
              setMfaPrompt({
                challengeId: challenge.challengeId,
                factor: "totp",
              });
              return;
            }
            if (!setup.secret || !setup.qrCodeDataUrl) {
              throw new Error("Authenticator setup could not be started.");
            }
            setMfaEnrollment({
              secret: setup.secret,
              qrCodeDataUrl: setup.qrCodeDataUrl,
            });
          } catch (nextError) {
            setError(errorMessage(nextError));
          } finally {
            setBusy(false);
          }
        }}
        onComplete={async (code) => {
          setBusy(true);
          setError("");
          try {
            const setup = await completeMfaEnrollment(code);
            if (!setup.recoveryCodes?.length) {
              throw new Error("Recovery codes could not be generated.");
            }
            setMfaEnrollment({ recoveryCodes: setup.recoveryCodes });
          } catch (nextError) {
            setError(errorMessage(nextError));
          } finally {
            setBusy(false);
          }
        }}
        onAcknowledge={async () => {
          setBusy(true);
          setError("");
          try {
            const challenge = await beginMfaChallenge("totp");
            if (!challenge.challengeId) {
              throw new Error(
                "Multi-factor verification could not be started.",
              );
            }
            setMfaFactors(["totp", "recoveryCode"]);
            setMfaEnrollment(null);
            setMfaPrompt({
              challengeId: challenge.challengeId,
              factor: "totp",
            });
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

  async function verifyMfaPrompt(code: string) {
    if (!mfaPrompt) return;
    const reauthentication = mfaPrompt.purpose === "reauthentication";
    if (reauthentication) setReauthenticationBusy(true);
    else setBusy(true);
    setError("");
    try {
      const result = await completeMfaChallenge(mfaPrompt.challengeId, code);
      if (reauthentication) {
        const resolver = reauthenticationResolver.current;
        reauthenticationResolver.current = null;
        setMfaPrompt(null);
        resolver?.resolve();
        return;
      }
      const nextUser = result.user ?? (await getAuthSession());
      if (!nextUser)
        throw new Error("The secure session could not be restored.");
      setUser(nextUser);
      setMfaPrompt(null);
      if (nextUser.emailVerification) await loadBootstrap();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      if (reauthentication) setReauthenticationBusy(false);
      else setBusy(false);
    }
  }

  async function restartMfaPrompt() {
    if (mfaPrompt?.purpose === "reauthentication") {
      reauthenticationResolver.current?.reject(
        new Error("Privileged verification was cancelled."),
      );
      reauthenticationResolver.current = null;
      setMfaPrompt(null);
      setError("");
      return;
    }
    await signOutSession().catch(() => undefined);
    setMfaPrompt(null);
    setUser(null);
    setError("");
  }

  async function switchMfaFactor(factor: "totp" | "recoveryCode") {
    if (!mfaPrompt) return;
    setBusy(true);
    setError("");
    try {
      const challenge = await beginMfaChallenge(factor);
      if (!challenge.challengeId) {
        throw new Error("Multi-factor verification could not be started.");
      }
      setMfaPrompt({
        challengeId: challenge.challengeId,
        factor,
        purpose: mfaPrompt.purpose,
      });
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  const mfaGate = mfaPrompt ? (
    <MfaGate
      busy={
        mfaPrompt.purpose === "reauthentication" ? reauthenticationBusy : busy
      }
      error={error}
      factor={mfaPrompt.factor}
      overlay={mfaPrompt.purpose === "reauthentication"}
      restartLabel={
        mfaPrompt.purpose === "reauthentication"
          ? "Cancel and return"
          : "Return to sign in"
      }
      onVerify={verifyMfaPrompt}
      onRestart={restartMfaPrompt}
      onUseFactor={
        mfaFactors.includes(
          mfaPrompt.factor === "totp" ? "recoveryCode" : "totp",
        )
          ? switchMfaFactor
          : undefined
      }
    />
  ) : null;

  if (mfaPrompt && mfaPrompt.purpose !== "reauthentication") {
    return mfaGate;
  }
  const reauthenticationGate =
    mfaPrompt?.purpose === "reauthentication" ? mfaGate : null;

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
        allowSignUp={publicSignUp || Boolean(signupCredential)}
        publicSignUp={publicSignUp}
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
            await loadBootstrap();
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
      <>
        <AppointmentPrompt
          email={user.email}
          busy={busy}
          error={error}
          onAccept={acceptAppointment}
          onDismiss={dismissAppointment}
        />
        {reauthenticationGate}
      </>
    );
  }

  if (bootstrap.recovery) {
    return (
      <SubscriptionRecovery
        recovery={bootstrap.recovery}
        busy={busy}
        error={error}
        onRevokeDevices={async () => {
          setBusy(true);
          setError("");
          try {
            await knowhowCommand("revokeCaptureDevices", {
              workspaceId: bootstrap.recovery!.workspace.id,
            });
          } catch (nextError) {
            setError(errorMessage(nextError));
          } finally {
            setBusy(false);
          }
        }}
        onRetry={async () => {
          setBusy(true);
          try {
            await loadBootstrap();
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

  if (!bootstrap.activeWorkspace) {
    return (
      <>
        <WorkspaceOnboarding
          viewerName={bootstrap.viewer.name}
          canCreateWorkspace={bootstrap.viewer.platformAdministrator}
          platform={bootstrap.platform}
          organizations={bootstrap.organizations ?? []}
          busy={busy}
          error={error}
          onSaveProvisioning={async (runId, step, data) => {
            setBusy(true);
            setError("");
            try {
              const result = await knowhowCommand<{
                runId: string;
                currentStep: number;
                completedSteps: number[];
              }>("saveProvisioningRun", {
                ...(runId ? { runId } : {}),
                step,
                data,
              });
              await loadBootstrap(activeWorkspaceId || undefined);
              return result;
            } catch (nextError) {
              setError(errorMessage(nextError));
              throw nextError;
            } finally {
              setBusy(false);
            }
          }}
          onCompleteProvisioning={async (runId) => {
            setBusy(true);
            setError("");
            try {
              const result = await knowhowCommand<PlatformProvisioningResult>(
                "completeProvisioningRun",
                { runId },
              );
              await loadBootstrap(activeWorkspaceId || undefined);
              return result;
            } catch (nextError) {
              setError(errorMessage(nextError));
              throw nextError;
            } finally {
              setBusy(false);
            }
          }}
          onAppointOrganizationMember={async (
            organizationId,
            email,
            roles,
            anchorWorkspaceId,
          ) => {
            setBusy(true);
            setError("");
            try {
              const result = await knowhowCommand<{
                appointmentId: string;
                appointmentToken: string;
                expiresAt: string;
              }>("appointOrganizationMember", {
                organizationId,
                email,
                roles,
                anchorWorkspaceId,
              });
              await loadBootstrap(activeWorkspaceId || undefined);
              return result;
            } catch (nextError) {
              setError(errorMessage(nextError));
              throw nextError;
            } finally {
              setBusy(false);
            }
          }}
          onUpdateOrganizationMember={async (
            organizationId,
            memberId,
            roles,
            status,
          ) => {
            setBusy(true);
            setError("");
            try {
              const result = await knowhowCommand("updateOrganizationMember", {
                organizationId,
                memberId,
                roles,
                status,
              });
              await loadBootstrap(activeWorkspaceId || undefined);
              return result;
            } catch (nextError) {
              setError(errorMessage(nextError));
              throw nextError;
            } finally {
              setBusy(false);
            }
          }}
          onSaveOrganizationDomains={async (organizationId, domains) => {
            setBusy(true);
            setError("");
            try {
              const result = await knowhowCommand("updateOrganizationDomains", {
                organizationId,
                domains,
              });
              await loadBootstrap(activeWorkspaceId || undefined);
              return result;
            } catch (nextError) {
              setError(errorMessage(nextError));
              throw nextError;
            } finally {
              setBusy(false);
            }
          }}
          onSetWorkspaceStatus={setPlatformWorkspaceStatus}
          onAssignAdministrator={assignPlatformWorkspaceAdministrator}
          onRequestSupport={requestSupportAccess}
          onExtendSubscription={extendPlatformSubscription}
          onConvertSubscription={convertPlatformSubscription}
          onApproveDeletion={approvePlatformDeletion}
          onRevokeAppointment={revokePlatformAppointment}
          onSignOut={signOut}
        />
        {reauthenticationGate}
      </>
    );
  }

  const activeWorkspace = bootstrap.activeWorkspace.workspace;
  const requestedWorkspaceSlug = routeWorkspaceSlug(route);
  const requestedWorkspace = requestedWorkspaceSlug
    ? bootstrap.workspaces.filter(
        (workspace) =>
          workspace.slug === requestedWorkspaceSlug &&
          workspace.status === "active",
      )
    : [];
  if (
    requestedWorkspaceSlug &&
    (requestedWorkspace.length !== 1 ||
      requestedWorkspace[0].id !== activeWorkspace.id)
  ) {
    return <OpeningKnowHow />;
  }
  const workspaceRoute: AppRoute =
    route.kind === "root" || route.kind === "invalid"
      ? {
          kind: "workspace-section",
          workspaceSlug: activeWorkspace.slug,
          section: "overview",
        }
      : route;

  return (
    <>
      <KnowHowWorkspaceApp
        key={activeWorkspaceId}
        data={bootstrap}
        activeWorkspaceId={activeWorkspaceId}
        route={workspaceRoute}
        busy={busy}
        globalError={error}
        onSelectWorkspace={selectWorkspace}
        onRefresh={() => loadBootstrap(activeWorkspaceId)}
        onSignOut={signOut}
        onBusyChange={setBusy}
        onError={setError}
        onNavigate={navigate}
        onRegisterNavigationGuard={registerNavigationGuard}
      />
      {reauthenticationGate}
    </>
  );
}
