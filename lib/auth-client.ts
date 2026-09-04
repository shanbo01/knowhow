import { knowhowApi } from "./knowhow-client";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  emailVerification: boolean;
  mfa: boolean;
};

type AuthResponse = {
  user?: SessionUser;
  mfaRequired?: boolean;
  factors?: string[];
  challengeId?: string;
  recoveryCodes?: string[];
  required?: boolean;
  enabled?: boolean;
  resumed?: boolean;
  // Sign-up reports whether it managed to send the verification email, so the
  // caller can show the resend prompt instead of assuming one arrived.
  verificationSent?: boolean;
  /** The previous recovery codes were replaced and no longer work. */
  replacedRecoveryCodes?: boolean;
  secret?: string;
  uri?: string;
  qrCodeDataUrl?: string;
  error?: string;
};

function csrfToken() {
  if (typeof document === "undefined") return "";
  const prefix = "knowhow_csrf=";
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
}

async function authRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api/auth/${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(csrfToken() ? { "x-csrf-token": csrfToken() } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as AuthResponse;
  if (!response.ok)
    throw new Error(
      body.error ?? `Authentication failed (${response.status}).`,
    );
  return body;
}

export async function authHealth() {
  await authRequest("health");
}

export async function getAuthSession() {
  const response = await fetch("/api/auth/session", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 401) return null;
  const body = (await response.json().catch(() => ({}))) as AuthResponse;
  if (!response.ok)
    throw new Error(body.error ?? "Identity verification failed.");
  return body.user ?? null;
}

export function signInWithPassword(email: string, password: string) {
  return authRequest("sign-in", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function signUp(input: {
  name: string;
  email: string;
  password: string;
  credentialKind?: "invite" | "appointment" | "beta";
  credential?: string;
  // The server refuses a sign-up without this. It is not a formality: the
  // checkbox used to guard the browser alone, so anything calling the API
  // directly created an account having agreed to nothing.
  acceptedTerms: boolean;
}) {
  return authRequest("sign-up", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function signOutSession() {
  return authRequest("sign-out", { method: "POST", body: "{}" });
}

export function sendEmailVerification(url: string) {
  return authRequest("verification", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export function completeEmailVerification(userId: string, secret: string) {
  return authRequest("verification/complete", {
    method: "POST",
    body: JSON.stringify({ userId, secret }),
  });
}

export function requestPasswordRecovery(email: string, url: string) {
  return authRequest("recovery", {
    method: "POST",
    body: JSON.stringify({ email, url }),
  });
}

export function completePasswordRecovery(
  userId: string,
  secret: string,
  password: string,
) {
  return authRequest("recovery/complete", {
    method: "POST",
    body: JSON.stringify({ userId, secret, password }),
  });
}

export function updateAccountPassword(currentPassword: string, password: string) {
  return authRequest("password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, password }),
  });
}

export function updateAccountName(name: string) {
  return authRequest("profile", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function revokeOtherSessions() {
  return authRequest("sessions/revoke-others", {
    method: "POST",
    body: "{}",
  });
}

export function beginMfaChallenge(factor: "totp" | "recoveryCode") {
  return authRequest("mfa/challenge", {
    method: "POST",
    body: JSON.stringify({ factor }),
  });
}

export function completeMfaChallenge(challengeId: string, otp: string) {
  return authRequest("mfa/complete", {
    method: "POST",
    body: JSON.stringify({ challengeId, otp }),
  });
}

export function beginMfaEnrollment() {
  return authRequest("mfa/enroll/start", { method: "POST", body: "{}" });
}

export function completeMfaEnrollment(otp: string) {
  return authRequest("mfa/enroll/complete", {
    method: "POST",
    body: JSON.stringify({ otp }),
  });
}

/**
 * Turns multi-factor sign-in on, once the recovery codes have been saved.
 * Enrollment deliberately stops short of this so that abandoning the codes
 * screen cannot leave an account enforcing a factor it cannot recover.
 */
export function acknowledgeMfaRecoveryCodes() {
  return authRequest("mfa/enroll/acknowledge", { method: "POST", body: "{}" });
}

export function regenerateMfaRecoveryCodes() {
  return knowhowApi<AuthResponse>("/api/auth/mfa/recovery/regenerate", {
    method: "POST",
    body: "{}",
  });
}

export function disableMfa() {
  return authRequest("mfa/disable", { method: "POST", body: "{}" });
}
