"use client";

import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { account } from "../../lib/appwrite";

type State = "checking" | "verified" | "failed";

export default function VerifyEmailPage() {
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState("Confirming the verification link…");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const userId = params.get("userId");
      const secret = params.get("secret");
      if (!userId || !secret) {
        setState("failed");
        setMessage("This verification link is incomplete. Request a new one from Rivet.");
        return;
      }
      account
        .updateVerification({ userId, secret })
        .then(() => {
          setState("verified");
          setMessage("Your email is verified. Rivet can now evaluate invitations and exact-domain eligibility.");
        })
        .catch((error: unknown) => {
          setState("failed");
          setMessage(
            error instanceof Error
              ? error.message
              : "This verification link is invalid or expired.",
          );
        });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <main className="opening-screen verify-page">
      <div className="opening-mark">R</div>
      {state === "checking" ? <LoaderCircle className="spin" /> : null}
      {state === "verified" ? <CheckCircle2 className="verify-result success" /> : null}
      {state === "failed" ? <CircleAlert className="verify-result failed" /> : null}
      <h1>{state === "verified" ? "Email verified" : state === "failed" ? "Verification failed" : "Verifying email"}</h1>
      <p>{message}</p>
      {state !== "checking" ? <Link className="button primary" href="/">Continue to Rivet</Link> : null}
    </main>
  );
}
