"use client";

import {
  ArrowRight,
  CheckCircle2,
  MailCheck,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ProductBrand } from "./product-brand";

export type BackendState = "checking" | "connected" | "failed";

export type AuthGateProps = {
  backendState: BackendState;
  backendMessage?: string;
  busy: boolean;
  error?: string;
  onRetryBackend: () => void;
  onSignIn: (email: string, password: string) => Promise<void> | void;
  onSignUp: (
    name: string,
    email: string,
    password: string,
  ) => Promise<void> | void;
  allowSignUp?: boolean;
  publicSignUp?: boolean;
};

export type WorkspaceSetupProps = {
  userName: string;
  busy: boolean;
  error?: string;
  onCreate: (name: string) => Promise<void> | void;
  onSignOut: () => void;
};

type AuthMode = "sign-in" | "sign-up";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const backendCopy: Record<
  BackendState,
  { label: string; defaultMessage: string }
> = {
  checking: {
    label: "Connecting",
    defaultMessage: "Verifying the secure workspace connection.",
  },
  connected: {
    label: "Connected",
    defaultMessage: "Your workspace is ready for secure sign-in.",
  },
  failed: {
    label: "Connection issue",
    defaultMessage: "KnowHow could not reach the workspace service.",
  },
};

function normaliseEmail(value: string) {
  return value.trim().toLowerCase();
}

export function AuthGate({
  backendState,
  backendMessage,
  busy,
  error,
  onRetryBackend,
  onSignIn,
  onSignUp,
  allowSignUp = false,
  publicSignUp = false,
}: AuthGateProps) {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string>();

  const status = backendCopy[backendState];
  const isSignUp = allowSignUp && mode === "sign-up";
  const controlsDisabled = busy || backendState !== "connected";
  const visibleError = localError ?? error;

  function selectMode(nextMode: AuthMode) {
    setMode(nextMode);
    setLocalError(undefined);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(undefined);

    const cleanName = name.trim();
    const cleanEmail = normaliseEmail(email);

    if (isSignUp && cleanName.length < 2) {
      setLocalError("Enter your name to create an account.");
      return;
    }

    if (!EMAIL_PATTERN.test(cleanEmail)) {
      setLocalError("Enter a valid work email address.");
      return;
    }

    if (password.length < 12) {
      setLocalError("Password must be at least 12 characters.");
      return;
    }

    try {
      if (isSignUp) {
        await onSignUp(cleanName, cleanEmail, password);
      } else {
        await onSignIn(cleanEmail, password);
      }
    } catch (submissionError) {
      setLocalError(
        submissionError instanceof Error
          ? submissionError.message
          : "We could not complete that request. Try again.",
      );
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-labelledby="auth-brand-title">
        <Link className="auth-brand" href="/" aria-label="KnowHow home">
          <ProductBrand id="auth-brand-title" />
        </Link>

        <div className="auth-intro-copy">
          <p className="auth-eyebrow">Privacy-first SOP workspace</p>
          <h1>Capture the work. Share only what each team should see.</h1>
          <p>
            Turn real workflows into governed, versioned guides without sending
            unredacted screenshots to the cloud.
          </p>
        </div>

        <div className="auth-trust-note">
          <ShieldCheck aria-hidden="true" />
          <span>Access is limited to authenticated workspace members.</span>
        </div>
      </section>

      <section className="auth-panel" aria-labelledby="auth-heading">
        <div className="auth-card">
          <div
            className={`auth-backend-status auth-backend-status-${backendState}`}
            role="status"
            aria-live="polite"
          >
            <span className="auth-status-icon" aria-hidden="true">
              {backendState === "checking" ? (
                <LoaderCircle className="auth-spin" />
              ) : backendState === "connected" ? (
                <CheckCircle2 />
              ) : (
                <RefreshCw />
              )}
            </span>
            <span className="auth-status-copy">
              <strong>{status.label}</strong>
              <span>{backendMessage ?? status.defaultMessage}</span>
            </span>
            {backendState === "failed" ? (
              <button
                className="auth-retry-button"
                type="button"
                onClick={onRetryBackend}
                disabled={busy}
              >
                Retry
              </button>
            ) : null}
          </div>

          <div className="auth-card-heading">
            <p className="auth-eyebrow">
              {isSignUp ? "Create your account" : "Welcome back"}
            </p>
            <h2 id="auth-heading">
              {isSignUp
                ? publicSignUp
                  ? "Create your KnowHow account"
                  : "Create your invited account"
                : "Sign in to KnowHow"}
            </h2>
            <p>
              {isSignUp
                ? publicSignUp
                  ? "Set up your secure account and verify your email. Workspace access is granted separately by an administrator."
                  : "Set up your secure account, verify your email, then redeem the access issued to you."
                : "Use your work account to continue to your SOP workspace."}
            </p>
          </div>

          <div className="auth-mode-switch" aria-label="Account access">
            <button
              className={
                mode === "sign-in"
                  ? "auth-mode-button auth-mode-button-active"
                  : "auth-mode-button"
              }
              type="button"
              aria-pressed={mode === "sign-in"}
              onClick={() => selectMode("sign-in")}
              disabled={busy}
            >
              Sign in
            </button>
            {allowSignUp ? (
              <button
                className={
                  mode === "sign-up"
                    ? "auth-mode-button auth-mode-button-active"
                    : "auth-mode-button"
                }
                type="button"
                aria-pressed={mode === "sign-up"}
                onClick={() => selectMode("sign-up")}
                disabled={busy}
              >
                {publicSignUp ? "Create account" : "Create invited account"}
              </button>
            ) : null}
          </div>

          <form
            className="auth-form"
            onSubmit={handleSubmit}
            aria-busy={busy}
            noValidate
          >
            {isSignUp ? (
              <div className="auth-field">
                <label htmlFor="auth-name">Your name</label>
                <input
                  id="auth-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={controlsDisabled}
                  required
                />
              </div>
            ) : null}

            <div className="auth-field">
              <label htmlFor="auth-email">Work email</label>
              <input
                id="auth-email"
                name="email"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoComplete="email"
                spellCheck={false}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={controlsDisabled}
                required
              />
            </div>

            <div className="auth-field">
              <div className="auth-label-row">
                <label htmlFor="auth-password">Password</label>
                {isSignUp ? <span>12 characters minimum</span> : null}
              </div>
              <input
                id="auth-password"
                name="password"
                type="password"
                minLength={12}
                autoComplete={isSignUp ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={controlsDisabled}
                required
                aria-describedby={
                  visibleError ? "auth-form-error" : undefined
                }
              />
            </div>

            <div
              id="auth-form-error"
              className="auth-form-message"
              role={visibleError ? "alert" : "status"}
              aria-live="polite"
            >
              {visibleError ?? "\u00a0"}
            </div>

            <button
              className="auth-primary-button"
              type="submit"
              disabled={controlsDisabled}
            >
              <span>
                {busy
                  ? "Please wait\u2026"
                  : isSignUp
                    ? "Create account"
                    : "Sign in"}
              </span>
              {busy ? (
                <LoaderCircle className="auth-spin" aria-hidden="true" />
              ) : (
                <ArrowRight aria-hidden="true" />
              )}
            </button>
          </form>

          <p className="auth-card-footnote">
            {allowSignUp
              ? publicSignUp
                ? "Creating an account does not grant automatic workspace or guide access."
                : "This invitation creates an account, not automatic guide access."
              : "KnowHow pilots are invitation-only. Request access from your organization owner."}
          </p>
        </div>
      </section>
    </main>
  );
}

export function MfaGate({
  busy,
  error,
  factor,
  onVerify,
  onRestart,
  onUseFactor,
  restartLabel = "Return to sign in",
  overlay = false,
}: {
  busy: boolean;
  error?: string;
  factor: "totp" | "recoveryCode";
  onVerify: (code: string) => void | Promise<void>;
  onRestart: () => void | Promise<void>;
  onUseFactor?: (factor: "totp" | "recoveryCode") => void | Promise<void>;
  restartLabel?: string;
  overlay?: boolean;
}) {
  const [code, setCode] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = code.trim();
    if (normalized.length < 6) return;
    await onVerify(normalized);
  }

  return (
    <main className={`auth-shell${overlay ? " auth-shell-overlay" : ""}`}>
      <section className="auth-intro" aria-labelledby="mfa-brand-title">
        <div className="auth-brand"><ProductBrand id="mfa-brand-title" /></div>
        <div className="auth-intro-copy">
          <p className="auth-eyebrow">Protected access</p>
          <h1>Confirm it is really you.</h1>
          <p>Administrative and exceptional access requires a current second factor.</p>
        </div>
        <div className="auth-trust-note"><ShieldCheck /><span>The code is verified by Appwrite and is never stored by KnowHow.</span></div>
      </section>
      <section className="auth-panel" aria-labelledby="mfa-heading">
        <div className="auth-card">
          <div className="auth-card-heading">
            <p className="auth-eyebrow">Multi-factor authentication</p>
            <h2 id="mfa-heading">{factor === "totp" ? "Enter your authenticator code" : "Enter a recovery code"}</h2>
          </div>
          <form className="auth-form" onSubmit={submit}>
            <div className="auth-field">
              <label htmlFor="mfa-code">Authentication code</label>
              <input
                id="mfa-code"
                autoComplete="one-time-code"
                inputMode={factor === "totp" ? "numeric" : "text"}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                disabled={busy}
                autoFocus
              />
            </div>
            {error ? <p className="auth-form-message" role="alert">{error}</p> : null}
            <button className="auth-primary-button" type="submit" disabled={busy || code.trim().length < 6}>
              {busy ? <LoaderCircle className="auth-spin" /> : <ShieldCheck />}
              Verify
            </button>
          </form>
          <button className="auth-secondary-button" type="button" onClick={onRestart} disabled={busy}>
            {restartLabel}
          </button>
          {onUseFactor ? (
            <button className="text-button" type="button" disabled={busy} onClick={() => onUseFactor(factor === "totp" ? "recoveryCode" : "totp")}>
              {factor === "totp" ? "Use a recovery code" : "Use authenticator instead"}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

export function MfaEnrollmentGate({
  busy,
  error,
  secret,
  qrCodeDataUrl,
  recoveryCodes,
  onBegin,
  onComplete,
  onAcknowledge,
  onSignOut,
}: {
  busy: boolean;
  error?: string;
  secret?: string;
  qrCodeDataUrl?: string;
  recoveryCodes?: string[];
  onBegin: () => void | Promise<void>;
  onComplete: (otp: string) => void | Promise<void>;
  onAcknowledge: () => void | Promise<void>;
  onSignOut: () => void | Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [confirmedSaved, setConfirmedSaved] = useState(false);
  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-labelledby="mfa-enroll-brand">
        <div className="auth-brand"><ProductBrand id="mfa-enroll-brand" /></div>
        <div className="auth-intro-copy"><p className="auth-eyebrow">Administrator protection</p><h1>Secure privileged access with an authenticator.</h1><p>Platform and workspace administrators must use a time-based one-time password. KnowHow never stores the secret or recovery codes.</p></div>
        <div className="auth-trust-note"><ShieldCheck /><span>Finish setup before accepting an administrator appointment or opening administrative data.</span></div>
      </section>
      <section className="auth-panel" aria-labelledby="mfa-enroll-heading">
        <div className="auth-card">
          {!secret && !recoveryCodes ? (
            <>
              <div className="auth-card-heading"><p className="auth-eyebrow">Required setup</p><h2 id="mfa-enroll-heading">Add an authenticator app</h2><p>Use any standards-compatible TOTP authenticator.</p></div>
              {error ? <p className="auth-form-message" role="alert">{error}</p> : null}
              <button className="auth-primary-button" type="button" disabled={busy} onClick={onBegin}>{busy ? <LoaderCircle className="auth-spin" /> : <ShieldCheck />} Begin secure setup</button>
            </>
          ) : recoveryCodes ? (
            <>
              <div className="auth-card-heading"><p className="auth-eyebrow">Show once</p><h2 id="mfa-enroll-heading">Save your recovery codes</h2><p>Each code works once. Store them outside KnowHow; they cannot be shown again.</p></div>
              <ol className="mfa-recovery-codes" aria-label="Recovery codes">{recoveryCodes.map((item) => <li key={item}><code>{item}</code></li>)}</ol>
              <label className="choice-row emphasized"><input type="checkbox" checked={confirmedSaved} onChange={(event) => setConfirmedSaved(event.target.checked)} /><span><strong>I saved these codes securely</strong><small>They will disappear after continuing.</small></span></label>
              <button className="auth-primary-button" type="button" disabled={busy || !confirmedSaved} onClick={onAcknowledge}>{busy ? <LoaderCircle className="auth-spin" /> : <CheckCircle2 />} Continue and verify</button>
            </>
          ) : (
            <>
              <div className="auth-card-heading"><p className="auth-eyebrow">Authenticator setup</p><h2 id="mfa-enroll-heading">Scan or enter the setup key</h2><p>Then enter the six-digit code generated by your app.</p></div>
              {/* A local data URL must never be sent through the image optimizer. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {qrCodeDataUrl ? <img className="mfa-qr" src={qrCodeDataUrl} alt="Authenticator setup QR code" width={240} height={240} /> : null}
              <div className="auth-field"><label htmlFor="mfa-secret">Manual setup key</label><input id="mfa-secret" readOnly value={secret} onFocus={(event) => event.currentTarget.select()} /></div>
              <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void onComplete(code.trim()); }}>
                <div className="auth-field"><label htmlFor="mfa-enroll-code">Six-digit code</label><input id="mfa-enroll-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></div>
                {error ? <p className="auth-form-message" role="alert">{error}</p> : null}
                <button className="auth-primary-button" type="submit" disabled={busy || code.length !== 6}>{busy ? <LoaderCircle className="auth-spin" /> : <ShieldCheck />} Verify authenticator</button>
              </form>
            </>
          )}
          <button className="text-button" type="button" disabled={busy} onClick={onSignOut}>Sign out</button>
        </div>
      </section>
    </main>
  );
}

export function VerificationGate({
  email,
  busy,
  sent,
  error,
  onSend,
  onRefresh,
  onSignOut,
}: {
  email: string;
  busy: boolean;
  sent: boolean;
  error?: string;
  onSend: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onSignOut: () => void | Promise<void>;
}) {
  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-labelledby="verify-brand-title">
        <div className="auth-brand">
          <ProductBrand id="verify-brand-title" />
        </div>
        <div className="auth-intro-copy">
          <p className="auth-eyebrow">Account protection</p>
          <h1>Verify the address that controls your access.</h1>
          <p>
            Email verification confirms account ownership. A signed invitation
            or administrator appointment still decides what that account can access.
          </p>
        </div>
        <div className="auth-trust-note">
          <ShieldCheck aria-hidden="true" />
          <span>No workspace data is available until verification succeeds.</span>
        </div>
      </section>
      <section className="auth-panel" aria-labelledby="verify-title">
        <div className="auth-card verify-card">
          <span className="verify-icon" aria-hidden="true"><MailCheck /></span>
          <div className="auth-card-heading">
            <p className="auth-eyebrow">Check your inbox</p>
            <h2 id="verify-title">Verify your work email</h2>
            <p>
              We need to confirm <strong>{email}</strong> before KnowHow can redeem
              the invitation or administrator appointment issued to you.
            </p>
          </div>
          {sent ? (
            <p className="success-banner" role="status">
              Verification email sent. Open the link, then return here.
            </p>
          ) : null}
          {error ? <p className="auth-form-message" role="alert">{error}</p> : null}
          <button className="auth-primary-button" type="button" onClick={onRefresh} disabled={busy}>
            {busy ? <LoaderCircle className="auth-spin" /> : <RefreshCw />}
            I have verified my email
          </button>
          <button className="auth-secondary-button" type="button" onClick={onSend} disabled={busy}>
            Send verification email
          </button>
          <button className="text-button" type="button" onClick={onSignOut} disabled={busy}>
            Use another account
          </button>
        </div>
      </section>
    </main>
  );
}

export function WorkspaceSetup({
  userName,
  busy,
  error,
  onCreate,
  onSignOut,
}: WorkspaceSetupProps) {
  const [workspaceName, setWorkspaceName] = useState("");
  const [localError, setLocalError] = useState<string>();
  const visibleError = localError ?? error;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(undefined);

    const cleanName = workspaceName.trim();
    if (cleanName.length < 2) {
      setLocalError("Enter a workspace name with at least 2 characters.");
      return;
    }

    try {
      await onCreate(cleanName);
    } catch (submissionError) {
      setLocalError(
        submissionError instanceof Error
          ? submissionError.message
          : "We could not create the workspace. Try again.",
      );
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-labelledby="auth-brand-title">
        <Link className="auth-brand" href="/" aria-label="KnowHow home">
          <ProductBrand id="auth-brand-title" />
        </Link>

        <div className="auth-intro-copy">
          <p className="auth-eyebrow">One final step</p>
          <h1>Give your team a clear place to operate.</h1>
          <p>
            Your workspace keeps guides, approvals, and restricted knowledge
            available to the right people.
          </p>
        </div>

        <div className="auth-trust-note">
          <ShieldCheck aria-hidden="true" />
          <span>You can invite additional team members after setup.</span>
        </div>
      </section>

      <section className="auth-panel" aria-labelledby="auth-workspace-heading">
        <div className="auth-card">
          <div className="auth-card-heading">
            <p className="auth-eyebrow">Workspace setup</p>
            <h2 id="auth-workspace-heading">
              {userName ? `Welcome, ${userName}` : "Welcome to KnowHow"}
            </h2>
            <p>
              Choose a recognizable name, such as your company or IT team name.
            </p>
          </div>

          <form
            className="auth-form"
            onSubmit={handleSubmit}
            aria-busy={busy}
            noValidate
          >
            <div className="auth-field">
              <label htmlFor="auth-workspace-name">Workspace name</label>
              <input
                id="auth-workspace-name"
                name="workspaceName"
                type="text"
                autoComplete="organization"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                disabled={busy}
                required
                autoFocus
                aria-describedby={
                  visibleError ? "auth-workspace-error" : "auth-workspace-hint"
                }
              />
              <span id="auth-workspace-hint" className="auth-field-hint">
                Your team will see this name in KnowHow.
              </span>
            </div>

            <div
              id="auth-workspace-error"
              className="auth-form-message"
              role={visibleError ? "alert" : "status"}
              aria-live="polite"
            >
              {visibleError ?? "\u00a0"}
            </div>

            <button
              className="auth-primary-button"
              type="submit"
              disabled={busy}
            >
              <span>{busy ? "Creating workspace\u2026" : "Create workspace"}</span>
              {busy ? (
                <LoaderCircle className="auth-spin" aria-hidden="true" />
              ) : (
                <ArrowRight aria-hidden="true" />
              )}
            </button>
          </form>

          <button
            className="auth-secondary-button"
            type="button"
            onClick={onSignOut}
            disabled={busy}
          >
            Sign out
          </button>
        </div>
      </section>
    </main>
  );
}
