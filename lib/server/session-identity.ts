import "server-only";

import { AppwriteException } from "node-appwrite";
import { appwriteSessionCookieName, getAppwriteServerConfig } from "./appwrite-config";
import { createSessionAppwrite } from "./appwrite-clients";
import { HttpError, readCookie } from "./http-security";

export type AuthenticatedIdentity = {
  userId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
};

export function sessionSecret(request: Request) {
  const config = getAppwriteServerConfig();
  const secret = readCookie(request, appwriteSessionCookieName(config.projectId));
  if (!secret || secret.length > 8_192) {
    throw new HttpError(401, "AUTH_REQUIRED", "Sign in to continue.");
  }
  return secret;
}

function unavailable(error: unknown) {
  return error instanceof AppwriteException && error.code >= 500;
}

export async function getSessionIdentity(request: Request): Promise<AuthenticatedIdentity> {
  try {
    const { account } = createSessionAppwrite(sessionSecret(request));
    const user = await account.get();
    return {
      userId: user.$id,
      email: user.email.trim().toLowerCase(),
      name: user.name.trim() || user.email,
      emailVerified: user.emailVerification,
      mfaEnabled: user.mfa,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (
      error instanceof AppwriteException &&
      (error.code === 401 || error.code === 403 || error.type === "user_more_factors_required")
    ) {
      throw new HttpError(401, "AUTH_REQUIRED", "Sign in to continue.", { cause: error });
    }
    if (unavailable(error)) {
      throw new HttpError(503, "IDENTITY_UNAVAILABLE", "Identity verification is temporarily unavailable.", {
        cause: error,
      });
    }
    throw error;
  }
}

export async function requireVerifiedSession(request: Request) {
  const identity = await getSessionIdentity(request);
  if (!identity.emailVerified) {
    throw new HttpError(403, "EMAIL_NOT_VERIFIED", "Verify your email before accessing KnowHow.");
  }
  return identity;
}

export async function requireRecentTotp(request: Request, maximumAgeSeconds = 600) {
  const secret = sessionSecret(request);
  const { account } = createSessionAppwrite(secret);
  const session = await account.getSession({ sessionId: "current" });
  const updatedAt = Date.parse(session.mfaUpdatedAt || "");
  const recent = Number.isFinite(updatedAt) && Date.now() - updatedAt <= maximumAgeSeconds * 1_000;
  if (!session.factors.includes("totp") || !recent) {
    throw new HttpError(403, "TOTP_REAUTH_REQUIRED", "Confirm a current authenticator code to continue.");
  }
}

