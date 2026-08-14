import "server-only";

import { HttpError } from "./http-security";

export type RegistrationMode = "disabled" | "private_beta" | "open";
export type SignupAdmission = "signed_credential" | "beta" | "open";

const REGISTRATION_MODES = new Set<RegistrationMode>([
  "disabled",
  "private_beta",
  "open",
]);

export function registrationMode(
  environment?: { KNOWHOW_REGISTRATION_MODE?: string },
): RegistrationMode {
  const configured = (environment ?? process.env).KNOWHOW_REGISTRATION_MODE?.trim();
  if (!configured) return "disabled";
  if (!REGISTRATION_MODES.has(configured as RegistrationMode)) {
    throw new HttpError(
      500,
      "REGISTRATION_MODE_INVALID",
      "Registration is unavailable.",
      { expose: false },
    );
  }
  return configured as RegistrationMode;
}

export function signupAdmission(input: {
  mode: RegistrationMode;
  credentialKind?: unknown;
  hasCredential: boolean;
}): SignupAdmission {
  if (
    (input.credentialKind === "invite" ||
      input.credentialKind === "appointment") &&
    input.hasCredential
  ) {
    return "signed_credential";
  }
  if (input.mode === "disabled") {
    throw new HttpError(
      403,
      "REGISTRATION_DISABLED",
      "Account registration currently requires an invitation or administrator appointment.",
    );
  }
  if (input.mode === "private_beta") {
    if (input.credentialKind === "beta" && input.hasCredential) return "beta";
    throw new HttpError(
      403,
      "BETA_ACCESS_REQUIRED",
      "A current private-beta access code is required to create an account.",
    );
  }
  if (input.credentialKind === "beta" && input.hasCredential) return "beta";
  if (input.credentialKind === undefined && !input.hasCredential) return "open";
  throw new HttpError(
    400,
    "SIGNUP_CREDENTIAL_INVALID",
    "The signup credential is invalid.",
  );
}
