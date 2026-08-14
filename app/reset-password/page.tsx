"use client";

import { ArrowRight, KeyRound, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { completePasswordRecovery } from "../../lib/auth-client";
import { AuthSurface } from "../components/auth-gate";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const secret = searchParams.get("secret") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(
    userId && secret ? "" : "This reset link is incomplete. Request a new one.",
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await completePasswordRecovery(userId, secret, password);
      setDone(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "This reset link is invalid or expired.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthSurface
      eyebrow="Account recovery"
      title="Choose a new password for KnowHow."
      description="After you save it, sign in with the same email you used before."
      labelledBy="reset-heading"
    >
      <div className="auth-card">
        <div className="auth-card-heading">
          <p className="auth-eyebrow">Reset password</p>
          <h2 id="reset-heading">
            {done ? "Password updated" : "Set a new password"}
          </h2>
          <p>
            {done
              ? "You can sign in with your new password."
              : "Use at least 8 characters."}
          </p>
        </div>
        {done ? (
          <Link className="auth-primary-button" href="/login">
            Sign in <ArrowRight aria-hidden="true" />
          </Link>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <div className="auth-field">
              <label htmlFor="reset-password">New password</label>
              <div className="auth-input-wrap">
                <KeyRound aria-hidden="true" />
                <input
                  id="reset-password"
                  name="password"
                  type="password"
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>
            </div>
            <div className="auth-field">
              <label htmlFor="reset-confirm">Confirm password</label>
              <div className="auth-input-wrap">
                <KeyRound aria-hidden="true" />
                <input
                  id="reset-confirm"
                  name="confirm"
                  type="password"
                  minLength={8}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
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
              disabled={busy || !userId || !secret}
            >
              <span>{busy ? "Saving…" : "Save password"}</span>
              {busy ? (
                <LoaderCircle className="auth-spin" aria-hidden="true" />
              ) : (
                <ArrowRight aria-hidden="true" />
              )}
            </button>
          </form>
        )}
        <p className="auth-card-footnote">
          <Link href="/forgot-password">Request a new reset link</Link>
        </p>
      </div>
    </AuthSurface>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="opening-screen">
          <LoaderCircle className="spin" />
          <h1>Reset password</h1>
          <p>Loading the reset form.</p>
        </main>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
