"use client";

import { ArrowRight, LoaderCircle, MailCheck } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { requestPasswordRecovery } from "../../lib/auth-client";
import { AuthSurface } from "../components/auth-gate";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await requestPasswordRecovery(
        email.trim().toLowerCase(),
        `${window.location.origin}/reset-password`,
      );
      setSent(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "We could not send a reset email.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthSurface
      eyebrow="Account recovery"
      title="Reset the password for your KnowHow account."
      description="Enter the email you use to sign in. If an account exists, we will send a reset link."
      labelledBy="forgot-heading"
    >
      <div className="auth-card">
        <div className="auth-card-heading">
          <p className="auth-eyebrow">Forgot password</p>
          <h2 id="forgot-heading">
            {sent ? "Check your email" : "Send a reset link"}
          </h2>
          <p>
            {sent
              ? "If that address has a KnowHow account, a reset link is on its way."
              : "We never include your password in email."}
          </p>
        </div>
        {sent ? (
          <Link className="auth-primary-button" href="/login">
            Back to sign in <ArrowRight aria-hidden="true" />
          </Link>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <div className="auth-field">
              <label htmlFor="forgot-email">Work email</label>
              <div className="auth-input-wrap">
                <MailCheck aria-hidden="true" />
                <input
                  id="forgot-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>
            </div>
            {error ? (
              <p className="auth-form-message" role="alert">
                {error}
              </p>
            ) : null}
            <button
              className="auth-primary-button"
              type="submit"
              disabled={busy}
            >
              <span>{busy ? "Sending…" : "Send reset link"}</span>
              {busy ? (
                <LoaderCircle className="auth-spin" aria-hidden="true" />
              ) : (
                <ArrowRight aria-hidden="true" />
              )}
            </button>
          </form>
        )}
        <p className="auth-card-footnote">
          <Link href="/login">Return to sign in</Link>
        </p>
      </div>
    </AuthSurface>
  );
}
