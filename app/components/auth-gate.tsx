"use client";

import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  MailCheck,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
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
    betaCode?: string,
    acceptedTerms?: boolean,
  ) => Promise<void> | void;
  allowSignUp?: boolean;
  publicSignUp?: boolean;
  privateBetaSignUp?: boolean;
  initialMode?: AuthMode;
  credentialContext?: {
    kind: "invite" | "appointment" | "beta";
    email?: string;
  };
};

type AuthMode = "sign-in" | "sign-up";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const backendCopy: Record<
  BackendState,
  { label: string; defaultMessage: string }
> = {
  checking: {
    label: "Connecting",
    defaultMessage: "Checking the connection.",
  },
  connected: {
    label: "Connected",
    defaultMessage: "Ready to sign in.",
  },
  failed: {
    label: "Connection issue",
    defaultMessage: "KnowHow could not reach the workspace service.",
  },
};

function normaliseEmail(value: string) {
  return value.trim().toLowerCase();
}

function AuthTrustList() {
  return (
    <ul className="auth-proof-list" aria-label="KnowHow access safeguards">
      <li>
        <CheckCircle2 /> Verified identities
      </li>
      <li>
        <CheckCircle2 /> Workspace-scoped access
      </li>
      <li>
        <CheckCircle2 /> Audited administrator actions
      </li>
    </ul>
  );
}

export function AuthSurface({
  eyebrow,
  title,
  description,
  children,
  labelledBy,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  labelledBy: string;
}) {
  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-labelledby={`${labelledBy}-brand`}>
        <Link className="auth-brand" href="/" aria-label="KnowHow home">
          <ProductBrand id={`${labelledBy}-brand`} />
        </Link>
        <div className="auth-intro-copy">
          <p className="auth-eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <AuthTrustList />
        <div className="auth-trust-note">
          <ShieldCheck aria-hidden="true" />
          <span>
            Verified email, private workspaces, and optional authenticator
            protection.
          </span>
        </div>
      </section>
      <section className="auth-panel" aria-labelledby={labelledBy}>
        {children}
      </section>
    </main>
  );
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
  privateBetaSignUp = false,
  initialMode = "sign-in",
  credentialContext,
}: AuthGateProps) {
  const [selectedMode, setSelectedMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(credentialContext?.email ?? "");
  const [password, setPassword] = useState("");
  const [betaCode, setBetaCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [localError, setLocalError] = useState<string>();

  const status = backendCopy[backendState];
  const mode = allowSignUp ? selectedMode : "sign-in";
  const isSignUp = mode === "sign-up";
  const isBetaSignup =
    credentialContext?.kind === "beta" ||
    (privateBetaSignUp && !credentialContext);
  const requiresBetaCode = isSignUp && privateBetaSignUp && !credentialContext;
  const controlsDisabled = busy || backendState !== "connected";
  const visibleError = localError ?? error;

  function selectMode(nextMode: AuthMode) {
    setSelectedMode(nextMode);
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

    if (password.length < 8) {
      setLocalError("Password must be at least 8 characters.");
      return;
    }

    if (isSignUp && !acceptedTerms) {
      setLocalError("Confirm the Terms and Privacy notice to create an account.");
      return;
    }

    const cleanBetaCode = betaCode.trim();
    if (
      requiresBetaCode &&
      !/^khbeta1\.[^.\s]+\.[^.\s]+$/.test(cleanBetaCode)
    ) {
      setLocalError(
        "Enter the complete private-beta access code you received.",
      );
      return;
    }

    try {
      if (isSignUp) {
        await onSignUp(
          cleanName,
          cleanEmail,
          password,
          requiresBetaCode ? cleanBetaCode : undefined,
          acceptedTerms,
        );
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
    <AuthSurface
      eyebrow="KnowHow access"
      title="Operational knowledge, kept under control."
      description="Capture the way work gets done, refine it with the people who own it, and give every teammate one trusted place to follow it."
      labelledBy="auth-heading"
    >
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

        {credentialContext ? (
          <div className="auth-context-banner">
            <KeyRound />
            <span>
              <strong>
                {credentialContext.kind === "appointment"
                  ? "Administrator appointment detected"
                  : credentialContext.kind === "beta"
                    ? "Private-beta access confirmed"
                    : "Workspace invitation detected"}
              </strong>
              <small>
                {credentialContext.email
                  ? `Continue with ${credentialContext.email}.`
                  : credentialContext.kind === "beta"
                    ? "Create the account that will own your first organization and workspace."
                    : "Sign in or create the account this access link was issued to."}
              </small>
            </span>
          </div>
        ) : null}

        <div className="auth-card-heading">
          <p className="auth-eyebrow">
            {isSignUp ? "Create your account" : "Welcome back"}
          </p>
          <h2 id="auth-heading">
            {isSignUp
              ? credentialContext?.kind === "beta"
                ? "Start your workspace"
                : isBetaSignup
                  ? "Create your KnowHow account"
                  : publicSignUp
                    ? "Create your KnowHow account"
                    : "Create your invited account"
              : "Sign in to KnowHow"}
          </h2>
          <p>
            {isSignUp
              ? credentialContext?.kind === "beta"
                ? "Set up your account and verify your email. Organization setup starts right after."
                : isBetaSignup
                  ? "Create a secure account. After email verification, KnowHow will guide you through your organization and first workspace."
                  : publicSignUp
                    ? "Set up your account, verify your email, then create your first organization and workspace."
                    : "Set up your account, verify your email, then redeem the access issued to you."
              : "Use your work account to continue to your workspace."}
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
              {credentialContext && credentialContext.kind !== "beta"
                ? "Create invited account"
                : "Create account"}
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
              <div className="auth-input-wrap">
                <UserRound aria-hidden="true" />
                <input
                  id="auth-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setLocalError(undefined);
                  }}
                  disabled={controlsDisabled}
                  required
                />
              </div>
            </div>
          ) : null}

          {requiresBetaCode ? (
            <div className="auth-field">
              <div className="auth-label-row">
                <label htmlFor="auth-beta-code">Private-beta access code</label>
                <span>Issued by KnowHow</span>
              </div>
              <div className="auth-input-wrap">
                <KeyRound aria-hidden="true" />
                <input
                  id="auth-beta-code"
                  name="beta-code"
                  type="text"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  value={betaCode}
                  onChange={(event) => {
                    setBetaCode(event.target.value);
                    setLocalError(undefined);
                  }}
                  placeholder="khbeta1.\u2026"
                  disabled={controlsDisabled}
                  required
                />
              </div>
            </div>
          ) : null}

          <div className="auth-field">
            <label htmlFor="auth-email">Work email</label>
            <div className="auth-input-wrap">
              <MailCheck aria-hidden="true" />
              <input
                id="auth-email"
                name="email"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoComplete="email"
                spellCheck={false}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setLocalError(undefined);
                }}
                disabled={controlsDisabled}
                required
              />
            </div>
          </div>

          <div className="auth-field">
            <div className="auth-label-row">
              <label htmlFor="auth-password">Password</label>
              {isSignUp ? (
                <span>8 characters minimum</span>
              ) : (
                <Link className="auth-forgot-link" href="/forgot-password">
                  Forgot password?
                </Link>
              )}
            </div>
            <div className="auth-input-wrap">
              <KeyRound aria-hidden="true" />
              <input
                id="auth-password"
                name="password"
                type={showPassword ? "text" : "password"}
                minLength={8}
                autoComplete={isSignUp ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setLocalError(undefined);
                }}
                disabled={controlsDisabled}
                required
                aria-describedby={visibleError ? "auth-form-error" : undefined}
              />
              <button
                className="auth-password-toggle"
                type="button"
                aria-label={
                  showPassword ? "Conceal typed entry" : "Reveal typed entry"
                }
                aria-pressed={showPassword}
                onClick={() => setShowPassword((visible) => !visible)}
                disabled={controlsDisabled}
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </button>
            </div>
          </div>

          {isSignUp ? (
            <label className="auth-terms-row">
              <input
                type="checkbox"
                checked={acceptedTerms}
                onChange={(event) => setAcceptedTerms(event.target.checked)}
                disabled={controlsDisabled}
                required
              />
              <span>
                I agree to the{" "}
                <Link href="/terms" target="_blank" rel="noreferrer">
                  Terms
                </Link>{" "}
                and{" "}
                <Link href="/privacy" target="_blank" rel="noreferrer">
                  Privacy notice
                </Link>
                .
              </span>
            </label>
          ) : null}

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
          {isSignUp
            ? credentialContext?.kind === "beta"
              ? "This access code is consumed when your account is created."
              : allowSignUp
                ? credentialContext
                  ? "This invitation creates an account. Workspace access still follows the invitation."
                  : publicSignUp
                    ? "After you verify your email, you can create your organization and invite teammates."
                    : privateBetaSignUp
                      ? "A current access code is required to create an account."
                      : "This invitation creates an account. Workspace access still follows the invitation."
                : "Need an account? Ask a teammate for an invitation, or contact KnowHow."
            : allowSignUp
              ? "Need an account? Create one, then verify your email."
              : "Need an account? Ask a teammate for an invitation, or contact KnowHow."}
        </p>
      </div>
    </AuthSurface>
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
        <div className="auth-brand">
          <ProductBrand id="mfa-brand-title" />
        </div>
        <div className="auth-intro-copy">
          <p className="auth-eyebrow">Protected access</p>
          <h1>Confirm it is really you.</h1>
          <p>
            Administrative and exceptional access requires a current second
            factor.
          </p>
        </div>
        <div className="auth-trust-note">
          <ShieldCheck />
          <span>
            The code stays on this device. KnowHow never stores it.
          </span>
        </div>
      </section>
      <section className="auth-panel" aria-labelledby="mfa-heading">
        <div className="auth-card">
          <div className="auth-card-heading">
            <p className="auth-eyebrow">Multi-factor authentication</p>
            <h2 id="mfa-heading">
              {factor === "totp"
                ? "Enter your authenticator code"
                : "Enter a recovery code"}
            </h2>
          </div>
          <form className="auth-form" onSubmit={submit}>
            <div className="auth-field">
              <label htmlFor="mfa-code">Authentication code</label>
              <input
                id="mfa-code"
                autoComplete="one-time-code"
                inputMode={factor === "totp" ? "numeric" : "text"}
                value={code}
                maxLength={factor === "totp" ? 6 : 64}
                onChange={(event) =>
                  setCode(
                    factor === "totp"
                      ? event.target.value.replace(/\D/g, "").slice(0, 6)
                      : event.target.value.trimStart().toUpperCase(),
                  )
                }
                disabled={busy}
                autoFocus
              />
            </div>
            {error ? (
              <p className="auth-form-message" role="alert">
                {error}
              </p>
            ) : null}
            <button
              className="auth-primary-button"
              type="submit"
              disabled={busy || code.trim().length < 6}
            >
              {busy ? <LoaderCircle className="auth-spin" /> : <ShieldCheck />}
              Verify
            </button>
          </form>
          <button
            className="auth-secondary-button"
            type="button"
            onClick={onRestart}
            disabled={busy}
          >
            {restartLabel}
          </button>
          {onUseFactor ? (
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setCode("");
                void onUseFactor(factor === "totp" ? "recoveryCode" : "totp");
              }}
            >
              {factor === "totp"
                ? "Use a recovery code"
                : "Use authenticator instead"}
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
  replacedRecoveryCodes,
  onBegin,
  onComplete,
  onAcknowledge,
  onCancel,
  onSignOut,
}: {
  busy: boolean;
  error?: string;
  secret?: string;
  qrCodeDataUrl?: string;
  recoveryCodes?: string[];
  /** These codes replaced an unfinished attempt's set, which no longer works. */
  replacedRecoveryCodes?: boolean;
  onBegin: () => void | Promise<void>;
  onComplete: (otp: string) => void | Promise<void>;
  onAcknowledge: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onSignOut: () => void | Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [confirmedSaved, setConfirmedSaved] = useState(false);
  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-labelledby="mfa-enroll-brand">
        <div className="auth-brand">
          <ProductBrand id="mfa-enroll-brand" />
        </div>
        <div className="auth-intro-copy">
          <p className="auth-eyebrow">Optional protection</p>
          <h1>Add an authenticator if you want extra sign-in protection.</h1>
          <p>
            Authenticator apps are optional. You can turn this on or off later
            from Account security.
          </p>
        </div>
        <div className="auth-trust-note">
          <ShieldCheck />
          <span>
            You can skip this and enable it later from Account security.
          </span>
        </div>
      </section>
      <section className="auth-panel" aria-labelledby="mfa-enroll-heading">
        <div className="auth-card">
          {!secret && !recoveryCodes ? (
            <>
              <div className="auth-card-heading">
                <p className="auth-eyebrow">Optional setup</p>
                <h2 id="mfa-enroll-heading">Add an authenticator app</h2>
                <p>Use any standards-compatible TOTP authenticator.</p>
              </div>
              {error ? (
                <p className="auth-form-message" role="alert">
                  {error}
                </p>
              ) : null}
              <button
                className="auth-primary-button"
                type="button"
                disabled={busy}
                onClick={onBegin}
              >
                {busy ? (
                  <LoaderCircle className="auth-spin" />
                ) : (
                  <ShieldCheck />
                )}{" "}
                Begin secure setup
              </button>
            </>
          ) : recoveryCodes ? (
            <>
              <div className="auth-card-heading">
                <p className="auth-eyebrow">Shown once</p>
                <h2 id="mfa-enroll-heading">Save your recovery codes</h2>
                <p>
                  {replacedRecoveryCodes
                    ? "Your earlier setup was not finished, so these replace the codes from that attempt — those no longer work. Each code below works once."
                    : "These get you in if you lose your authenticator. Each code works once. Store them outside KnowHow."}
                </p>
              </div>
              <ol className="mfa-recovery-codes" aria-label="Recovery codes">
                {recoveryCodes.map((item) => (
                  <li key={item}>
                    <code>{item}</code>
                  </li>
                ))}
              </ol>
              <label className="choice-row emphasized">
                <input
                  type="checkbox"
                  checked={confirmedSaved}
                  onChange={(event) => setConfirmedSaved(event.target.checked)}
                />
                <span>
                  <strong>I saved these codes securely</strong>
                  <small>
                    Multi-factor sign-in switches on when you continue, not
                    before — so nothing is locked until these are safe.
                  </small>
                </span>
              </label>
              <button
                className="auth-primary-button"
                type="button"
                disabled={busy || !confirmedSaved}
                onClick={onAcknowledge}
              >
                {busy ? (
                  <LoaderCircle className="auth-spin" />
                ) : (
                  <CheckCircle2 />
                )}{" "}
                Turn on multi-factor sign-in
              </button>
            </>
          ) : (
            <>
              <div className="auth-card-heading">
                <p className="auth-eyebrow">Authenticator setup</p>
                <h2 id="mfa-enroll-heading">Scan or enter the setup key</h2>
                <p>Then enter the six-digit code generated by your app.</p>
              </div>
              {qrCodeDataUrl ? (
                // A local data URL must never be sent through the image optimizer.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="mfa-qr"
                  src={qrCodeDataUrl}
                  alt="Authenticator setup QR code"
                  width={240}
                  height={240}
                />
              ) : null}
              <div className="auth-field">
                <label htmlFor="mfa-secret">Manual setup key</label>
                <input
                  id="mfa-secret"
                  readOnly
                  value={secret}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </div>
              <form
                className="auth-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onComplete(code.trim());
                }}
              >
                <div className="auth-field">
                  <label htmlFor="mfa-enroll-code">Six-digit code</label>
                  <input
                    id="mfa-enroll-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                  />
                </div>
                {error ? (
                  <p className="auth-form-message" role="alert">
                    {error}
                  </p>
                ) : null}
                <button
                  className="auth-primary-button"
                  type="submit"
                  disabled={busy || code.length !== 6}
                >
                  {busy ? (
                    <LoaderCircle className="auth-spin" />
                  ) : (
                    <ShieldCheck />
                  )}{" "}
                  Verify authenticator
                </button>
              </form>
            </>
          )}
          {onCancel ? (
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => void onCancel()}
            >
              Not now
            </button>
          ) : null}
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </section>
    </main>
  );
}

/**
 * The standing reminder that replaces the verification wall.
 *
 * Verification used to block the whole product, which meant a new account saw
 * nothing until it found an email. It now gates only the actions that reach
 * somebody else — publishing, exporting, and changing who is in the
 * workspace — so this says which ones those are and stays until it is done.
 * Deliberately not dismissible: the person is holding a workspace they cannot
 * yet share.
 */
export function VerificationBanner({
  email,
  busy,
  sent,
  onSend,
  onRefresh,
}: {
  email: string;
  busy: boolean;
  sent: boolean;
  onSend: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
}) {
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(
      () => setCooldown((seconds) => Math.max(0, seconds - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [cooldown]);

  return (
    <div className="verification-banner" role="status">
      <MailCheck aria-hidden="true" />
      <div className="verification-banner-copy">
        <strong>
          {sent
            ? `Verification sent to ${email}`
            : `Verify ${email} to publish, export, or invite anyone`}
        </strong>
        <small>
          Everything else is available now — capture a workflow, write a guide,
          and read what has been shared with you.
        </small>
      </div>
      <div className="verification-banner-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy || cooldown > 0}
          onClick={async () => {
            await onSend();
            setCooldown(30);
          }}
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend email"}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void onRefresh()}
        >
          I&apos;ve verified
        </button>
      </div>
    </div>
  );
}
