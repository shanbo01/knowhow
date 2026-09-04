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
  ShieldCheck,
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

  // Two questions, both of which the product genuinely cannot guess. The
  // accent colour and the first teammate used to be asked here, before anyone
  // had seen a guide: both are settings with sensible defaults, reachable from
  // inside the product once there is something to apply them to.
  const steps = [
    { label: "Names", icon: Building2 },
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
    if (step === 0) {
      if ((draft.organizationName?.trim().length ?? 0) < 2) {
        return "Enter the organization name your team will recognize.";
      }
      if ((draft.workspaceName?.trim().length ?? 0) < 2) {
        return "Enter a name for your first workspace.";
      }
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
    setStep((current) => Math.min(1, current + 1) as SetupStep);
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
            Welcome, {viewerName || "there"}. Name the organization and its
            first workspace, and they are yours.
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
              <p className="auth-eyebrow">Step 1 of 2</p>
              <h2 id="setup-heading">Name your organization and workspace</h2>
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
              <label className="self-service-field">
                <span>Workspace name</span>
                <input
                  value={draft.workspaceName ?? ""}
                  onChange={(event) =>
                    update("workspaceName", event.target.value)
                  }
                  placeholder="Operations playbooks"
                />
                <small>
                  A workspace keeps guides, members and approvals together. You
                  can add more later.
                </small>
              </label>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="self-service-panel">
              <p className="auth-eyebrow">Step 2 of 2</p>
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
            {step < 1 ? (
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
