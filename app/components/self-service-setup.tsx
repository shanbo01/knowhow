"use client";

import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  LoaderCircle,
  LogOut,
  MailPlus,
  Palette,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ProductBrand } from "./product-brand";

export type SelfServiceSetupDraft = {
  organizationName?: string;
  legalName?: string;
  country?: string;
  workspaceName?: string;
  accentColor?: string;
  inviteEmail?: string;
};

type SetupStep = 0 | 1 | 2 | 3;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_ACCENT = "#e85d24";

function cleanDraft(draft: SelfServiceSetupDraft): SelfServiceSetupDraft {
  const values = Object.entries(draft)
    .map(([key, value]) => [key, value?.trim()] as const)
    .filter((entry): entry is [string, string] => Boolean(entry[1]));
  return Object.fromEntries(values) as SelfServiceSetupDraft;
}

function initialStep(draft: SelfServiceSetupDraft): SetupStep {
  if (!draft.organizationName?.trim()) return 0;
  if (!draft.workspaceName?.trim()) return 1;
  return 2;
}

export function SelfServiceSetup({
  viewerName,
  draft: storedDraft = {},
  busy,
  error,
  onSave,
  onComplete,
  onSignOut,
}: {
  viewerName: string;
  draft?: SelfServiceSetupDraft | null;
  busy: boolean;
  error?: string;
  onSave: (draft: SelfServiceSetupDraft) => Promise<unknown>;
  onComplete: (draft: SelfServiceSetupDraft) => Promise<unknown>;
  onSignOut: () => Promise<void> | void;
}) {
  const initialDraft = useMemo(
    () => ({ accentColor: DEFAULT_ACCENT, ...storedDraft }),
    [storedDraft],
  );
  const [draft, setDraft] = useState<SelfServiceSetupDraft>(initialDraft);
  const [step, setStep] = useState<SetupStep>(() => initialStep(initialDraft));
  const [localError, setLocalError] = useState("");

  const steps = [
    { label: "Organization", icon: Building2 },
    { label: "Workspace", icon: Palette },
    { label: "Teammate", icon: UsersRound },
    { label: "Review", icon: ShieldCheck },
  ] as const;

  function update<K extends keyof SelfServiceSetupDraft>(
    key: K,
    value: SelfServiceSetupDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setLocalError("");
  }

  function validateCurrentStep() {
    if (step === 0 && (draft.organizationName?.trim().length ?? 0) < 2) {
      return "Enter the organization name your team will recognize.";
    }
    if (step === 1 && (draft.workspaceName?.trim().length ?? 0) < 2) {
      return "Enter a name for your first workspace.";
    }
    if (
      step === 2 &&
      draft.inviteEmail?.trim() &&
      !EMAIL_PATTERN.test(draft.inviteEmail.trim().toLowerCase())
    ) {
      return "Enter a valid teammate email or leave it blank for now.";
    }
    return "";
  }

  async function continueSetup() {
    const validationError = validateCurrentStep();
    if (validationError) {
      setLocalError(validationError);
      return;
    }
    await onSave(cleanDraft(draft));
    setStep((current) => Math.min(3, current + 1) as SetupStep);
  }

  async function finishLater() {
    const cleaned = cleanDraft(draft);
    if (Object.keys(cleaned).length > 1) await onSave(cleaned);
    await onSignOut();
  }

  async function completeSetup() {
    const organizationName = draft.organizationName?.trim();
    const workspaceName = draft.workspaceName?.trim();
    if (!organizationName || !workspaceName) {
      setLocalError("Organization and workspace names are required.");
      return;
    }
    await onComplete(cleanDraft(draft));
  }

  return (
    <main className="self-service-shell">
      <header className="self-service-header">
        <Link className="auth-brand" href="/">
          <ProductBrand />
        </Link>
        <button
          className="self-service-quiet-action"
          type="button"
          disabled={busy}
          onClick={() => void finishLater()}
        >
          <LogOut aria-hidden="true" /> Save &amp; finish later
        </button>
      </header>

      <div className="self-service-layout">
        <aside className="self-service-intro">
          <p className="auth-eyebrow">14-day trial</p>
          <h1>Build the home for your team&apos;s know-how.</h1>
          <p>
            Welcome, {viewerName || "there"}. Two short setup choices create an
            organization and workspace that you own.
          </p>
          <div className="self-service-assurance">
            <ShieldCheck aria-hidden="true" />
            <span>
              <strong>Authenticator optional</strong>
              <small>
                Turn it on later from Account security if you want a second
                step at sign-in.
              </small>
            </span>
          </div>
          <div className="self-service-assurance">
            <CalendarDays aria-hidden="true" />
            <span>
              <strong>No payment details</strong>
              <small>
                Your trial begins only when setup completes. We never
                auto-charge.
              </small>
            </span>
          </div>
        </aside>

        <section className="self-service-card" aria-labelledby="setup-heading">
          <ol className="self-service-steps" aria-label="Setup progress">
            {steps.map((item, index) => {
              const Icon = item.icon;
              const completed = index < step;
              const active = index === step;
              return (
                <li
                  key={item.label}
                  className={active ? "is-active" : completed ? "is-done" : ""}
                  aria-current={active ? "step" : undefined}
                >
                  <span>{completed ? <Check /> : <Icon />}</span>
                  <small>{item.label}</small>
                </li>
              );
            })}
          </ol>

          {step === 0 ? (
            <div className="self-service-panel">
              <p className="auth-eyebrow">Step 1 of 4</p>
              <h2 id="setup-heading">Tell us about your organization</h2>
              <p>
                This is the company space your workspaces live in. Legal details
                can wait.
              </p>
              <label className="self-service-field">
                <span>Organization name</span>
                <input
                  autoFocus
                  value={draft.organizationName ?? ""}
                  onChange={(event) =>
                    update("organizationName", event.target.value)
                  }
                  placeholder="Acme Operations"
                  autoComplete="organization"
                />
              </label>
              <div className="self-service-field-grid">
                <label className="self-service-field">
                  <span>
                    Legal name <small>Optional</small>
                  </span>
                  <input
                    value={draft.legalName ?? ""}
                    onChange={(event) =>
                      update("legalName", event.target.value)
                    }
                    placeholder="Acme Operations LLC"
                  />
                </label>
                <label className="self-service-field">
                  <span>
                    Country code <small>Optional</small>
                  </span>
                  <input
                    value={draft.country ?? ""}
                    onChange={(event) => update("country", event.target.value)}
                    placeholder="QA"
                    autoComplete="country"
                    maxLength={2}
                  />
                </label>
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="self-service-panel">
              <p className="auth-eyebrow">Step 2 of 4</p>
              <h2 id="setup-heading">Name your first workspace</h2>
              <p>
                A workspace keeps guides, members, approvals, and analytics
                together. More workspaces can be added later when your plan
                allows.
              </p>
              <label className="self-service-field">
                <span>Workspace name</span>
                <input
                  autoFocus
                  value={draft.workspaceName ?? ""}
                  onChange={(event) =>
                    update("workspaceName", event.target.value)
                  }
                  placeholder="Operations playbooks"
                />
              </label>
              <label className="self-service-color-field">
                <span
                  className="self-service-color-preview"
                  style={{
                    backgroundColor: draft.accentColor || DEFAULT_ACCENT,
                  }}
                  aria-hidden="true"
                />
                <span>
                  <strong>Workspace accent</strong>
                  <small>Used for navigation and guide highlights.</small>
                </span>
                <input
                  type="color"
                  aria-label="Workspace accent color"
                  value={draft.accentColor || DEFAULT_ACCENT}
                  onChange={(event) =>
                    update("accentColor", event.target.value)
                  }
                />
              </label>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="self-service-panel">
              <p className="auth-eyebrow">Step 3 of 4</p>
              <h2 id="setup-heading">Bring one teammate—or skip for now</h2>
              <p>
                We can prepare a single-use viewer invitation so you can prove
                the full publish-and-complete journey with another person.
              </p>
              <label className="self-service-field">
                <span>
                  Teammate email <small>Optional</small>
                </span>
                <input
                  autoFocus
                  type="email"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={draft.inviteEmail ?? ""}
                  onChange={(event) =>
                    update("inviteEmail", event.target.value)
                  }
                  placeholder="teammate@company.com"
                  autoComplete="off"
                />
              </label>
              <div className="self-service-note">
                <MailPlus aria-hidden="true" />
                <p>
                  The invitation is bound to the exact email address, expires,
                  and can be revoked. It never grants organization
                  administration.
                </p>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="self-service-panel">
              <p className="auth-eyebrow">Step 4 of 4</p>
              <h2 id="setup-heading">Ready to create your workspace</h2>
              <p>
                Confirm the details below. Setup is atomic: either every
                protected record is created, or none are.
              </p>
              <dl className="self-service-review">
                <div>
                  <dt>Organization</dt>
                  <dd>{draft.organizationName}</dd>
                </div>
                <div>
                  <dt>Workspace</dt>
                  <dd>{draft.workspaceName}</dd>
                </div>
                <div>
                  <dt>Trial</dt>
                  <dd>14 days · no payment method</dd>
                </div>
                <div>
                  <dt>Initial teammate</dt>
                  <dd>{draft.inviteEmail?.trim() || "Skipped for now"}</dd>
                </div>
              </dl>
              <div className="self-service-ready">
                <CheckCircle2 aria-hidden="true" />
                <span>
                  <strong>
                    You become the owner and workspace administrator.
                  </strong>
                  <small>
                    You can add authenticator protection later from Account
                    security.
                  </small>
                </span>
              </div>
            </div>
          ) : null}

          <div
            className="self-service-message"
            role={localError || error ? "alert" : "status"}
            aria-live="polite"
          >
            {localError || error || "Your progress is saved between sessions."}
          </div>

          <div className="self-service-actions">
            {step > 0 ? (
              <button
                className="self-service-secondary"
                type="button"
                disabled={busy}
                onClick={() => setStep((step - 1) as SetupStep)}
              >
                <ArrowLeft /> Back
              </button>
            ) : (
              <span />
            )}
            {step < 3 ? (
              <button
                className="self-service-primary"
                type="button"
                disabled={busy}
                onClick={() => void continueSetup()}
              >
                {busy ? <LoaderCircle className="auth-spin" /> : null}
                {step === 2 && !draft.inviteEmail?.trim()
                  ? "Skip & review"
                  : "Save & continue"}
                <ArrowRight />
              </button>
            ) : (
              <button
                className="self-service-primary"
                type="button"
                disabled={busy}
                onClick={() => void completeSetup()}
              >
                {busy ? (
                  <LoaderCircle className="auth-spin" />
                ) : (
                  <ShieldCheck />
                )}
                Create organization
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
