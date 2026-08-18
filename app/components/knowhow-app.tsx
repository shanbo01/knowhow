"use client";

import {
  ArrowRight,
  Building2,
  CalendarClock,
  CheckCircle2,
  Link2,
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
  OrganizationView,
  PlatformProvisioningDialog,
  KnowHowWorkspaceApp,
} from "./knowhow-workspace-app";
import { PlatformApp } from "./platform/platform-app";
import { ProductBrand } from "./product-brand";
import {
  SelfServiceSetup,
  type SelfServiceSetupDraft,
} from "./self-service-setup";
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
        } from "../../lib/knowhow-types";
import {
  guideEditorHref,
  guideHref,
  parseAppRoute,
  platformHref,
  routeWorkspaceSlug,
  workspaceHref,
  type AppRoute,
} from "../../lib/workspace-routes";

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

const PENDING_INVITE_KEY = "knowhow-pending-invite";
const PENDING_APPOINTMENT_KEY = "knowhow-pending-appointment";
const PENDING_BETA_ACCESS_KEY = "knowhow-pending-beta-access";
const PENDING_SIGNUP_PLAN_KEY = "knowhow-pending-signup-plan";

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

function rememberAppointmentFromLocation() {
  if (typeof window === "undefined") return null;
  const token = new URLSearchParams(window.location.search).get("appointment");
  if (token) window.sessionStorage.setItem(PENDING_APPOINTMENT_KEY, token);
  return token ?? window.sessionStorage.getItem(PENDING_APPOINTMENT_KEY);
}

function rememberSignupPlanFromLocation() {
  if (typeof window === "undefined") return "pro_trial";
  const plan = new URLSearchParams(window.location.search).get("plan");
  if (plan === "free" || plan === "pro_trial") {
    window.sessionStorage.setItem(PENDING_SIGNUP_PLAN_KEY, plan);
    return plan;
  }
  const stored = window.sessionStorage.getItem(PENDING_SIGNUP_PLAN_KEY);
  return stored === "free" || stored === "pro_trial" ? stored : "pro_trial";
}

function rememberBetaAccessFromLocation() {
  if (typeof window === "undefined") return null;
  const token = new URLSearchParams(window.location.search).get("beta");
  if (token) window.sessionStorage.setItem(PENDING_BETA_ACCESS_KEY, token);
  return token ?? window.sessionStorage.getItem(PENDING_BETA_ACCESS_KEY);
}

function credentialEmail(token?: string | null) {
  if (!token || typeof window === "undefined") return undefined;
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(
      window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    ) as { email?: unknown };
    return typeof decoded.email === "string"
      ? decoded.email.trim().toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

function OpeningKnowHow() {
  return (
    <main className="opening-screen" aria-live="polite">
      <ProductBrand markOnly className="opening-product-brand" />
      <LoaderCircle className="spin" aria-hidden="true" />
      <h1>Opening KnowHow</h1>
      <p>Preparing your workspace.</p>
    </main>
  );
}

type CachedProductSession = {
  user: SessionUser;
  bootstrap: BootstrapResponse | null;
  activeWorkspaceId: string;
};

let cachedProductSession: CachedProductSession | null = null;

function AppointmentPrompt({
  signedInEmail,
  appointedEmail,
  busy,
  error,
  onAccept,
  onDismiss,
  onSwitchAccount,
}: {
  signedInEmail: string;
  appointedEmail?: string;
  busy: boolean;
  error: string;
  onAccept: () => Promise<void>;
  onDismiss: () => void;
  onSwitchAccount: () => Promise<void>;
}) {
  const accountMismatch = Boolean(
    appointedEmail &&
    appointedEmail.toLowerCase() !== signedInEmail.toLowerCase(),
  );

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
          A KnowHow platform administrator appointed{" "}
          <strong>{appointedEmail ?? signedInEmail}</strong> as the
          administrator of a client workspace. Accepting adds you as that
          workspace&apos;s administrator and is recorded in its audit history.
          This appointment is single-use and expires within 14 days.
        </p>
        <div
          className={
            accountMismatch
              ? "access-account access-account-mismatch"
              : "access-account"
          }
        >
          <span>Signed in as</span>
          <strong>{signedInEmail}</strong>
          <small>
            {accountMismatch
              ? "This appointment belongs to a different account."
              : "The email matches this appointment."}
          </small>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          {accountMismatch ? (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void onSwitchAccount()}
            >
              Switch account
            </button>
          ) : null}
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
            disabled={busy || accountMismatch}
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
  onNavigate,
  onSaveProvisioning,
  onCompleteProvisioning,
  onAppointOrganizationMember,
  onUpdateOrganizationMember,
  onRevokeAppointment,
  onSignOut,
}: {
  viewerName: string;
  canCreateWorkspace: boolean;
  platform?: NonNullable<BootstrapResponse["platform"]>;
  organizations: OrganizationAdministration[];
  busy: boolean;
  error: string;
  onNavigate: (href: string) => void;
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
    finalStepData: Record<string, unknown>,
  ) => Promise<PlatformProvisioningResult>;
  onAppointOrganizationMember: (
    organizationId: string,
    emails: string[],
    roles: OrganizationRole[],
    anchorWorkspaceId: string,
  ) => Promise<
    Array<{
      email: string;
      appointmentToken: string;
      expiresAt: string;
    }>
  >;
  onUpdateOrganizationMember: (
    organizationId: string,
    memberId: string,
    roles: OrganizationRole[],
    status: "active" | "revoked",
  ) => Promise<unknown>;
  onRevokeAppointment: (appointmentId: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [provisioningOpen, setProvisioningOpen] = useState(false);
  const [provisioningRunId, setProvisioningRunId] = useState<string | undefined>();
  const [accessLink, setAccessLink] = useState("");
  const [accessLinkError, setAccessLinkError] = useState("");

  function redeemAccessLink() {
    setAccessLinkError("");
    try {
      const parsed = new URL(accessLink.trim(), window.location.origin);
      const invite = parsed.searchParams.get("invite");
      const appointment = parsed.searchParams.get("appointment");
      if (!invite && !appointment) {
        setAccessLinkError("Paste a KnowHow invitation or appointment link.");
        return;
      }
      const params = new URLSearchParams();
      if (invite) params.set("invite", invite);
      if (appointment) params.set("appointment", appointment);
      window.location.assign(`/app?${params.toString()}`);
    } catch {
      setAccessLinkError("Paste the complete access link you received.");
    }
  }

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
          Your account is verified. Paste an invitation or appointment link
          issued to this email to join a workspace, or ask a teammate to invite
          you.
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
        <div className="access-guidance access-center">
          <p className="eyebrow">Access center</p>
          <h2>Have an invitation or appointment link?</h2>
          <p>
            Paste it here to continue without signing out. The link must be
            issued to this account&apos;s exact email address.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              redeemAccessLink();
            }}
          >
            <label className="auth-field" htmlFor="access-link">
              <span>Access link</span>
              <div className="auth-input-wrap">
                <Link2 aria-hidden="true" />
                <input
                  id="access-link"
                  type="url"
                  inputMode="url"
                  value={accessLink}
                  onChange={(event) => {
                    setAccessLink(event.target.value);
                    setAccessLinkError("");
                  }}
                  placeholder="https://…/app?invite=…"
                />
              </div>
            </label>
            {accessLinkError ? (
              <p className="form-error" role="alert">
                {accessLinkError}
              </p>
            ) : null}
            <button
              className="button primary"
              type="submit"
              disabled={!accessLink.trim()}
            >
              Redeem access <ArrowRight />
            </button>
          </form>
          <small>
            No link yet? Ask a workspace administrator to invite this exact
            email address.
          </small>
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
            onAppoint={(payload) =>
              onAppointOrganizationMember(
                organization.id,
                payload.emails,
                payload.roles,
                payload.anchorWorkspaceId,
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
            onRevokeAppointment={onRevokeAppointment}
          />
        </section>
      ))}
      {platform ? (
        <section
          className="onboarding-platform"
          aria-label="Platform administration"
        >
          <div className="create-workspace-form">
            <div className="section-heading compact">
              <div>
                <h2>Platform console</h2>
                <p>
                  Operator queues, customer profiles, inbound leads, and
                  commercial controls live in the dedicated console.
                </p>
              </div>
            </div>
            <button
              className="button primary"
              type="button"
              onClick={() => onNavigate(platformHref())}
            >
              Open platform console
            </button>
          </div>
        </section>
      ) : null}
      {provisioningOpen && platform ? (
        <PlatformProvisioningDialog
          busy={busy}
          initialRun={
            provisioningRunId
              ? platform.provisioningRuns.find((run) => run.id === provisioningRunId)
              : platform.provisioningRuns[0]
          }
          onClose={() => {
            setProvisioningOpen(false);
            setProvisioningRunId(undefined);
          }}
          onSave={onSaveProvisioning}
          onComplete={onCompleteProvisioning}
        />
      ) : null}
    </main>
  );
}

export default function Home() {
  const publicSignUp =
    process.env.NEXT_PUBLIC_KNOWHOW_REGISTRATION_MODE === "open";
  const privateBetaSignUp =
    process.env.NEXT_PUBLIC_KNOWHOW_REGISTRATION_MODE === "private_beta";
  const [backendState, setBackendState] = useState<BackendState>("checking");
  const [backendMessage, setBackendMessage] = useState("");
  const [locationKey, setLocationKey] = useState("/");
  const [booting, setBooting] = useState(!cachedProductSession?.user);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verificationSent, setVerificationSent] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(
    cachedProductSession?.user ?? null,
  );
  const [signupCredential, setSignupCredential] = useState<{
    kind: "invite" | "appointment" | "beta";
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
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(
    cachedProductSession?.bootstrap ?? null,
  );
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(
    cachedProductSession?.activeWorkspaceId ?? "",
  );
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

  const appointmentFromLocation = useCallback(
    () => rememberAppointmentFromLocation(),
    [],
  );

  const checkBackend = useCallback(async () => {
    setBackendState("checking");
    setBackendMessage("Checking the connection.");
    try {
      await authHealth();
      setBackendState("connected");
      setBackendMessage("Ready to sign in.");
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
    if (cachedProductSession?.user) {
      cachedProductSession = {
        user: cachedProductSession.user,
        bootstrap: next,
        activeWorkspaceId: selected,
      };
    }
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

  const restore = useCallback(async () => {
    if (!cachedProductSession?.user) setBooting(true);
    setError("");
    await checkBackend();
    const invite = rememberInviteFromLocation();
    const appointment = appointmentFromLocation();
    const betaAccess = rememberBetaAccessFromLocation();
    rememberSignupPlanFromLocation();
    setAppointmentToken(appointment);
    setSignupCredential(
      invite
        ? { kind: "invite", token: invite }
        : appointment
          ? { kind: "appointment", token: appointment }
          : betaAccess
            ? { kind: "beta", token: betaAccess }
            : null,
    );
    const nextUser = await getAuthSession().catch(() => null);
    if (!nextUser) {
      cachedProductSession = null;
      setUser(null);
      setBootstrap(null);
      setBooting(false);
      return;
    }
    setUser(nextUser);
    cachedProductSession = {
      user: nextUser,
      bootstrap: cachedProductSession?.bootstrap ?? null,
      activeWorkspaceId: cachedProductSession?.activeWorkspaceId ?? "",
    };
    try {
      if (nextUser.emailVerification) {
        await loadBootstrap();
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
      if (nextUser.emailVerification) {
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

  const signUp = async (
    name: string,
    email: string,
    password: string,
    betaCode?: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      const suppliedBetaCode = betaCode?.trim();
      const effectiveCredential = suppliedBetaCode
        ? ({ kind: "beta", token: suppliedBetaCode } as const)
        : signupCredential;
      if (!effectiveCredential && !publicSignUp && !privateBetaSignUp)
        throw new Error(
          "Registration is not currently available without an invitation.",
        );
      if (
        effectiveCredential?.kind === "beta" &&
        typeof window !== "undefined"
      ) {
        window.sessionStorage.setItem(
          PENDING_BETA_ACCESS_KEY,
          effectiveCredential.token,
        );
        setSignupCredential(effectiveCredential);
      }
      await signUpAccount({
        name,
        email,
        password,
        ...(effectiveCredential
          ? {
              credentialKind: effectiveCredential.kind,
              credential: effectiveCredential.token,
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
      } catch (verificationError) {
        setVerificationSent(false);
        setError(
          `Your account was created, but the verification email could not be sent. ${errorMessage(verificationError)}`,
        );
      }
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    const pendingInvite =
      typeof window !== "undefined"
        ? window.sessionStorage.getItem(PENDING_INVITE_KEY)
        : null;
    const pendingAppointment =
      appointmentToken ??
      (typeof window !== "undefined"
        ? window.sessionStorage.getItem(PENDING_APPOINTMENT_KEY)
        : null);
    const pendingBetaAccess =
      typeof window !== "undefined"
        ? window.sessionStorage.getItem(PENDING_BETA_ACCESS_KEY)
        : null;
    setBusy(true);
    try {
      await signOutSession();
    } finally {
      reauthenticationResolver.current?.reject(
        new Error("Privileged verification was cancelled."),
      );
      reauthenticationResolver.current = null;
      clearApiCredential();
      cachedProductSession = null;
      setUser(null);
      setBootstrap(null);
      setMfaEnrollment(null);
      setMfaPrompt(null);
      navigate(
        pendingAppointment
          ? `/app?appointment=${encodeURIComponent(pendingAppointment)}&mode=sign-in`
          : pendingInvite
            ? `/app?invite=${encodeURIComponent(pendingInvite)}&mode=sign-in`
            : pendingBetaAccess
              ? `/app?beta=${encodeURIComponent(pendingBetaAccess)}&mode=sign-in`
              : "/",
        { replace: true },
      );
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
      if (nextUser.emailVerification) {
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
      window.sessionStorage.removeItem(PENDING_APPOINTMENT_KEY);
      setAppointmentToken(null);
      setSignupCredential(null);
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
        onCancel={() => {
          setMfaEnrollment(null);
          setError("");
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
        allowSignUp={
          publicSignUp || privateBetaSignUp || Boolean(signupCredential)
        }
        publicSignUp={publicSignUp}
        privateBetaSignUp={privateBetaSignUp}
        initialMode={
          new URL(locationKey, "https://knowhow.local").searchParams.get(
            "mode",
          ) === "sign-up"
            ? "sign-up"
            : "sign-in"
        }
        credentialContext={
          signupCredential
            ? {
                kind: signupCredential.kind,
                email:
                  signupCredential.kind === "beta"
                    ? undefined
                    : credentialEmail(signupCredential.token),
              }
            : undefined
        }
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
          signedInEmail={user.email}
          appointedEmail={credentialEmail(appointmentToken)}
          busy={busy}
          error={error}
          onAccept={acceptAppointment}
          onDismiss={dismissAppointment}
          onSwitchAccount={signOut}
        />
        {reauthenticationGate}
      </>
    );
  }

  if (
    route.kind === "platform" &&
    bootstrap.viewer.platformAdministrator &&
    bootstrap.platform
  ) {
    return (
      <>
        <PlatformApp
          viewer={bootstrap.viewer}
          platform={bootstrap.platform}
          route={route}
          activeWorkspaceSlug={bootstrap.activeWorkspace?.workspace.slug}
          onNavigate={navigate}
          onRefresh={() => loadBootstrap(activeWorkspaceId || undefined)}
          onSignOut={signOut}
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
    if (publicSignUp || bootstrap.viewer.betaAdmission) {
      return (
        <>
          <SelfServiceSetup
            viewerName={bootstrap.viewer.name}
            draft={bootstrap.viewer.selfServiceSetup?.draft}
            busy={busy}
            error={error}
            onSave={async (draft: SelfServiceSetupDraft) => {
              setBusy(true);
              setError("");
              try {
                const result = await knowhowCommand(
                  "saveSelfServiceSetup",
                  draft,
                );
                await loadBootstrap();
                return result;
              } catch (nextError) {
                setError(errorMessage(nextError));
                throw nextError;
              } finally {
                setBusy(false);
              }
            }}
            onComplete={async (draft: SelfServiceSetupDraft) => {
              setBusy(true);
              setError("");
              try {
                const result = await knowhowCommand<{
                  workspaceId: string;
                  workspaceSlug: string;
                }>("completeSelfServiceSetup", {
                  ...draft,
                  plan: rememberSignupPlanFromLocation(),
                });
                if (typeof window !== "undefined") {
                  window.sessionStorage.removeItem(PENDING_BETA_ACCESS_KEY);
                  window.sessionStorage.removeItem(PENDING_SIGNUP_PLAN_KEY);
                }
                setSignupCredential(null);
                await openWorkspace(result.workspaceId, true);
                return result;
              } catch (nextError) {
                setError(errorMessage(nextError));
                throw nextError;
              } finally {
                setBusy(false);
              }
            }}
            onSignOut={signOut}
          />
          {reauthenticationGate}
        </>
      );
    }
    return (
      <>
        <WorkspaceOnboarding
          viewerName={bootstrap.viewer.name}
          canCreateWorkspace={Boolean(
            bootstrap.viewer.platformRoles?.some((role) =>
              ["owner", "operations"].includes(role),
            ),
          )}
          platform={bootstrap.platform}
          organizations={bootstrap.organizations ?? []}
          busy={busy}
          error={error}
          onNavigate={navigate}
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
          onCompleteProvisioning={async (runId, finalStepData) => {
            setBusy(true);
            setError("");
            try {
              const result = await knowhowCommand<PlatformProvisioningResult>(
                "completeProvisioningRun",
                { runId, finalStepData },
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
            emails,
            roles,
            anchorWorkspaceId,
          ) => {
            setBusy(true);
            setError("");
            const created: Array<{
              email: string;
              appointmentToken: string;
              expiresAt: string;
            }> = [];
            try {
              for (const email of emails) {
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
                created.push({
                  email,
                  appointmentToken: result.appointmentToken,
                  expiresAt: result.expiresAt,
                });
              }
              await loadBootstrap(activeWorkspaceId || undefined);
              return created;
            } catch (nextError) {
              setError(errorMessage(nextError));
              if (created.length) {
                await loadBootstrap(activeWorkspaceId || undefined);
                return created;
              }
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
          onRevokeAppointment={revokePlatformAppointment}
          onSignOut={signOut}
        />
        {reauthenticationGate}
      </>
    );
  }

  const activeWorkspace = bootstrap.activeWorkspace.workspace;
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
        onRequestMfaEnrollment={() => setMfaEnrollment({})}
      />
      {reauthenticationGate}
    </>
  );
}
