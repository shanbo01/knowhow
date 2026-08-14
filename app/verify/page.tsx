"use client";

import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  completeEmailVerification,
  getAuthSession,
  sendEmailVerification,
} from "../../lib/auth-client";
import { ProductBrand } from "../components/product-brand";

type State = "checking" | "verified" | "failed" | "incomplete";

export default function VerifyEmailPage() {
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState("Confirming the verification link…");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const userId = params.get("userId");
      const secret = params.get("secret");
      if (!userId || !secret) {
        setState("incomplete");
        setMessage(
          "This verification link is incomplete. Sign in to request a new email.",
        );
        return;
      }
      completeEmailVerification(userId, secret)
        .then(() => {
          setState("verified");
          setMessage(
            "Your email is verified. Continue to create your organization or join a workspace you were invited to.",
          );
        })
        .catch(async () => {
          const user = await getAuthSession().catch(() => null);
          if (user?.emailVerification) {
            setState("verified");
            setMessage(
              "Your email is already verified. Continue to KnowHow to resume setup or redeem any access issued to you.",
            );
            return;
          }
          setState("failed");
          setMessage(
            "This verification link is invalid, expired, or has already been used. Return to KnowHow to request a new email.",
          );
        });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  async function resend() {
    setBusy(true);
    try {
      const user = await getAuthSession();
      if (!user) {
        window.location.assign("/app");
        return;
      }
      await sendEmailVerification(`${window.location.origin}/verify`);
      setMessage("A new verification email is on its way.");
    } catch {
      setMessage("Sign in to request a new verification email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="opening-screen verify-page">
      <ProductBrand markOnly className="opening-product-brand" />
      {state === "checking" ? <LoaderCircle className="spin" /> : null}
      {state === "verified" ? (
        <CheckCircle2 className="verify-result success" />
      ) : null}
      {state === "failed" || state === "incomplete" ? (
        <CircleAlert className="verify-result failed" />
      ) : null}
      <h1>
        {state === "verified"
          ? "Email verified"
          : state === "failed" || state === "incomplete"
            ? "Verification needed"
            : "Verifying email"}
      </h1>
      <p>{message}</p>
      {state !== "checking" ? (
        <div className="recovery-actions">
          <Link className="button primary" href="/app">
            Continue to KnowHow
          </Link>
          {state === "incomplete" || state === "failed" ? (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void resend()}
            >
              {busy ? "Sending…" : "Request a new email"}
            </button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
