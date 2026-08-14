"use client";

import { CheckCircle2, LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import styles from "../marketing.module.css";

type LeadKind = "pilot" | "demo" | "pricing";

export function LeadForm({ kind }: { kind: LeadKind }) {
  const [state, setState] = useState<"idle" | "submitting" | "accepted">("idle");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("submitting");
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const tokenResponse = await fetch("/api/leads", { credentials: "same-origin", cache: "no-store" });
      const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { csrfToken?: string; error?: string };
      if (!tokenResponse.ok || !tokenBody.csrfToken) throw new Error(tokenBody.error ?? "The request form is temporarily unavailable.");
      const response = await fetch("/api/leads", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": tokenBody.csrfToken },
        body: JSON.stringify({
          kind,
          name: form.get("name"),
          email: form.get("email"),
          organization: form.get("organization"),
          role: form.get("role"),
          teamSize: Number(form.get("teamSize")),
          country: form.get("country"),
          workflow: form.get("workflow"),
          ordinaryDataOnly: form.get("ordinaryDataOnly") === "on",
          website: form.get("website"),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "We could not accept the request.");
      setState("accepted");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We could not accept the request.");
      setState("idle");
    }
  }

  if (state === "accepted") {
    return (
      <div className={styles.formSuccess} role="status">
        <CheckCircle2 aria-hidden="true" />
        <h2>Request received</h2>
        <p>We will reply by email.</p>
      </div>
    );
  }

  return (
    <form className={styles.leadForm} onSubmit={submit} aria-busy={state === "submitting"}>
      <div className={styles.formGrid}>
        <label><span>Name</span><input name="name" autoComplete="name" minLength={2} maxLength={128} required /></label>
        <label><span>Work email</span><input name="email" type="email" autoComplete="email" maxLength={320} required /></label>
        <label><span>Organization</span><input name="organization" autoComplete="organization" minLength={2} maxLength={160} required /></label>
        <label><span>Your role</span><input name="role" autoComplete="organization-title" minLength={2} maxLength={120} required /></label>
        <label><span>Team size</span><input name="teamSize" type="number" inputMode="numeric" min={1} max={10000} required /></label>
        <label><span>Country</span><input name="country" autoComplete="country-name" minLength={2} maxLength={80} required /></label>
      </div>
      <label><span>Workflow you want to improve</span><input name="workflow" minLength={2} maxLength={240} placeholder="For example: employee onboarding" required /></label>
      <label className={styles.checkbox}>
        <input name="ordinaryDataOnly" type="checkbox" required />
        <span>I confirm the proposed use excludes credentials, secrets, payments, health data, national IDs, and other sensitive or special-category data.</span>
      </label>
      <input className={styles.honeypot} name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
      {error ? <p className={styles.formError} role="alert">{error}</p> : null}
      <button className={styles.primary} type="submit" disabled={state === "submitting"}>
        {state === "submitting" ? <><LoaderCircle className={styles.spin} /> Sending request</> : "Send request"}
      </button>
      <small>Submitting this form does not create an account. We use these details only to reply.</small>
    </form>
  );
}
