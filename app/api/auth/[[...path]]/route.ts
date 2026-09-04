import {
  AppwriteException,
  AuthenticationFactor,
  AuthenticatorType,
  ID,
  Query,
} from "node-appwrite";
import QRCode from "qrcode";
import { appwriteSessionCookieName } from "@/lib/server/appwrite-config";
import { createAdminAppwrite, createSessionAppwrite } from "@/lib/server/appwrite-clients";
import {
  CSRF_COOKIE_NAME,
  HttpError,
  assertCookieMutationRequest,
  assertTrustedOrigin,
  jsonResponse,
  readJsonObject,
  requestPublicOrigin,
  toErrorResponse,
} from "@/lib/server/http-security";
import { sessionSecret } from "@/lib/server/session-identity";
import { assertSignupCredential } from "@/lib/server/signup-credentials";
import {
  correlationId,
  createRequestServices,
  requestFingerprint,
  withRequestId,
} from "@/lib/server/request-services";
import { requireRecentTotp } from "@/lib/server/session-identity";
import { issueRecoveryCodes } from "@/lib/server/mfa-recovery";
import { consumeFixedWindows } from "@/lib/server/rate-limit-service";
import { recordHttpFailure } from "@/lib/server/telemetry";
import { BetaAccessService } from "@/lib/server/beta-access-service";
import {
  registrationMode,
  signupAdmission,
} from "@/lib/server/registration-mode";

/**
 * The revision of the Terms and Privacy notice a sign-up agrees to. Bump this
 * when the published text changes materially, so an accepted-at timestamp says
 * what was accepted rather than only when.
 */
const TERMS_VERSION = "2026-09-02";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path?: string[] }> };

function routePath(context: Context) {
  return context.params.then(({ path }) => (path ?? []).join("/"));
}

function allowedOrigins() {
  return (process.env.KNOWHOW_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function text(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "string") throw new HttpError(400, "INPUT_INVALID", `${label} is required.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new HttpError(400, "INPUT_INVALID", `${label} is invalid.`);
  }
  return normalized;
}

function serializeUser(user: {
  $id: string;
  email: string;
  name: string;
  emailVerification: boolean;
  mfa: boolean;
}) {
  return {
    id: user.$id,
    email: user.email,
    name: user.name,
    emailVerification: user.emailVerification,
    mfa: user.mfa,
  };
}

function secureRequest(request: Request) {
  return requestPublicOrigin(request).startsWith("https://") || process.env.KNOWHOW_ENVIRONMENT === "production" || process.env.KNOWHOW_ENVIRONMENT === "staging";
}

function appendSessionCookies(response: Response, request: Request, projectId: string, secret: string, expire: string) {
  const secure = secureRequest(request) ? "; Secure" : "";
  response.headers.append(
    "set-cookie",
    `${appwriteSessionCookieName(projectId)}=${encodeURIComponent(secret)}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expire).toUTCString()}${secure}`,
  );
  const csrf = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  response.headers.append(
    "set-cookie",
    `${CSRF_COOKIE_NAME}=${csrf}; Path=/; SameSite=Strict; Expires=${new Date(expire).toUTCString()}${secure}`,
  );
}

function clearSessionCookies(response: Response, request: Request, projectId: string) {
  const secure = secureRequest(request) ? "; Secure" : "";
  response.headers.append("set-cookie", `${appwriteSessionCookieName(projectId)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  response.headers.append("set-cookie", `${CSRF_COOKIE_NAME}=; Path=/; SameSite=Strict; Max-Age=0${secure}`);
}

function authJson(body: unknown, requestId: string, init?: ResponseInit) {
  return withRequestId(jsonResponse(body, init), requestId);
}

function translate(error: unknown) {
  if (error instanceof HttpError) return error;
  if (error instanceof AppwriteException) {
    if (error.type === "user_more_factors_required") {
      return new HttpError(401, "MFA_REQUIRED", "Complete multi-factor authentication to continue.", { cause: error });
    }
    if (error.type === "user_invalid_token") {
      return new HttpError(401, "AUTH_CODE_INVALID", "The authentication code is invalid or expired.", { cause: error });
    }
    if (error.code === 401) return new HttpError(401, "AUTH_INVALID", "The email or password is incorrect.", { cause: error });
    if (error.code === 409) return new HttpError(409, "ACCOUNT_EXISTS", "An account already exists for this email.", { cause: error });
    if (error.code === 429) return new HttpError(429, "RATE_LIMITED", "Too many attempts. Try again later.", { cause: error });
    if (error.code >= 500) return new HttpError(503, "IDENTITY_UNAVAILABLE", "Identity service is temporarily unavailable.", { cause: error });
    return new HttpError(400, "IDENTITY_REQUEST_FAILED", error.message, { cause: error });
  }
  return error;
}

export async function GET(request: Request, context: Context) {
  const requestId = correlationId(request);
  try {
    const path = await routePath(context);
    if (path === "health") {
      const { users, store } = createRequestServices();
      await consumeFixedWindows(store, [{ scope: "auth.health", subject: requestFingerprint(request), limit: 60, windowSeconds: 60 }]);
      await users.list({ queries: [Query.limit(1)], total: false });
      return authJson({ ok: true, requestId }, requestId);
    }
    if (path === "session") {
      const { account } = createSessionAppwrite(sessionSecret(request));
      const user = await account.get();
      return authJson({ user: serializeUser(user), requestId }, requestId);
    }
    if (path === "mfa/requirement") {
      const { account } = createSessionAppwrite(sessionSecret(request));
      const user = await account.get();
      const factors = await account.listMFAFactors();
      return authJson({
        required: false,
        enabled: user.mfa,
        factors,
        requestId,
      }, requestId);
    }
    throw new HttpError(404, "AUTH_ROUTE_NOT_FOUND", "Authentication route not found.");
  } catch (error) {
    return withRequestId(toErrorResponse(translate(error), requestId), requestId);
  }
}

export async function POST(request: Request, context: Context) {
  const requestId = correlationId(request);
  try {
    const path = await routePath(context);
    assertTrustedOrigin(request, allowedOrigins());
    const body = await readJsonObject(request, 32_768);
    const { store } = createRequestServices();
    const fingerprint = requestFingerprint(request);
    const policy = path === "sign-in"
      ? { limit: 12, windowSeconds: 900 }
      : path === "sign-up"
        ? { limit: 6, windowSeconds: 3_600 }
        : path === "recovery" || path === "recovery/complete"
          ? { limit: 8, windowSeconds: 3_600 }
        : path === "mfa/complete"
          ? { limit: 20, windowSeconds: 600 }
          : { limit: 60, windowSeconds: 600 };
    await consumeFixedWindows(store, [{ scope: `auth.${path.replaceAll("/", ".").slice(0, 60)}`, subject: fingerprint, ...policy }]);

    if (path === "sign-in") {
      const email = text(body.email, "Email", 5, 320).toLowerCase();
      await consumeFixedWindows(store, [{ scope: "auth.sign-in.email", subject: email, limit: 8, windowSeconds: 900 }]);
      const password = text(body.password, "Password", 8, 1_024);
      const { account, config } = createAdminAppwrite();
      const session = await account.createEmailPasswordSession({ email, password });
      const response = authJson({ requestId }, requestId);
      appendSessionCookies(response, request, config.projectId, session.secret, session.expire);
      const scoped = createSessionAppwrite(session.secret);
      try {
        const user = await scoped.account.get();
        return authJson(
          { user: serializeUser(user), requestId },
          requestId,
          { headers: response.headers },
        );
      } catch (error) {
        if (error instanceof AppwriteException && error.type === "user_more_factors_required") {
          const factors = await scoped.account.listMFAFactors();
          return authJson(
            {
              mfaRequired: true,
              factors: [
                ...(factors.totp ? ["totp"] : []),
                ...(factors.recoveryCode ? ["recoveryCode"] : []),
              ],
              requestId,
            },
            requestId,
            { headers: response.headers },
          );
        }
        throw error;
      }
    }

    if (path === "sign-up") {
      const name = text(body.name, "Name", 2, 128);
      const email = text(body.email, "Email", 5, 320).toLowerCase();
      // The sign-up form has a Terms checkbox, but it only ever guarded the
      // browser: anything calling this endpoint directly created an account
      // without agreeing to anything, and nothing recorded that a person had.
      // Acceptance is a precondition here, and is written to the account below
      // so there is a record of which version was agreed and when.
      if (body.acceptedTerms !== true) {
        throw new HttpError(
          400,
          "TERMS_NOT_ACCEPTED",
          "Accept the Terms and Privacy notice to create an account.",
        );
      }
      await consumeFixedWindows(store, [{ scope: "auth.sign-up.email", subject: email, limit: 3, windowSeconds: 3_600 }]);
      const password = text(body.password, "Password", 8, 1_024);
      const credentialKind = body.credentialKind;
      const credential = typeof body.credential === "string" ? body.credential.trim() : "";
      const admission = signupAdmission({
        mode: registrationMode(),
        credentialKind,
        hasCredential: credential.length > 0,
      });
      const betaAccess = new BetaAccessService(store);
      let betaReservation: Awaited<ReturnType<BetaAccessService["reserve"]>> | null = null;
      if (admission === "signed_credential") {
        if (credential.length < 20 || credential.length > 8_192) {
          throw new HttpError(403, "INVITATION_REQUIRED", "A current invitation is required to create an account.");
        }
        if (credentialKind !== "invite" && credentialKind !== "appointment") {
          throw new HttpError(400, "SIGNUP_CREDENTIAL_INVALID", "The signup credential is invalid.");
        }
        await assertSignupCredential({ kind: credentialKind, token: credential, email });
      } else if (admission === "beta") {
        if (credential.length < 20 || credential.length > 128) {
          throw new HttpError(
            403,
            "BETA_ACCESS_REQUIRED",
            "A current private-beta access code is required to create an account.",
          );
        }
        betaReservation = await betaAccess.reserve({
          code: credential,
          email,
          requestId,
        });
      }
      const { users, account, config } = createAdminAppwrite();
      const userId = ID.unique();
      let userCreated = false;
      try {
        await users.create({ userId, email, password, name });
        userCreated = true;
        if (betaReservation) {
          await betaAccess.consume({
            reservationId: betaReservation.reservationId,
            email,
            userId,
            requestId,
          });
        }
      } catch (error) {
        if (userCreated) {
          await users.delete({ userId }).catch(() => undefined);
        }
        if (betaReservation) {
          await betaAccess
            .release({
              reservationId: betaReservation.reservationId,
              email,
              reason: "signup_failed",
              requestId,
            })
            .catch(() => undefined);
        }
        throw error;
      }
      // Record what was agreed to, not merely that something was. Preferences
      // travel with the account, so this survives without a schema change.
      await users
        .updatePrefs({
          userId,
          prefs: {
            termsAcceptedAt: new Date().toISOString(),
            termsVersion: TERMS_VERSION,
          },
        })
        .catch(() => undefined);

      const session = await account.createEmailPasswordSession({ email, password });

      // Send the verification email here rather than leaving the browser to ask
      // for it in a second request. That request could fail, or never be made —
      // by an API client, or a tab closed a moment too early — and the account
      // was then stranded unverified with nothing in the inbox to explain it.
      let verificationSent = false;
      try {
        await createSessionAppwrite(session.secret).account.createVerification({
          url: `${requestPublicOrigin(request)}/verify`,
        });
        verificationSent = true;
      } catch (error) {
        // The account exists and is usable; the person can ask again from the
        // banner. Failing the whole sign-up over an unsent email would be worse.
        recordHttpFailure(error, {
          requestId,
          errorCode: "VERIFICATION_SEND_FAILED",
          status: 500,
          operation: "auth.sign-up.verification",
        });
      }

      const response = authJson({ created: true, verificationSent, requestId }, requestId);
      appendSessionCookies(response, request, config.projectId, session.secret, session.expire);
      return response;
    }

    if (path === "recovery") {
      const email = text(body.email, "Email", 5, 320).toLowerCase();
      await consumeFixedWindows(store, [
        { scope: "auth.recovery.email", subject: email, limit: 3, windowSeconds: 3_600 },
      ]);
      const url = text(body.url, "Recovery URL", 10, 2_048);
      const parsed = new URL(url);
      if (parsed.origin !== requestPublicOrigin(request) || parsed.pathname !== "/reset-password") {
        throw new HttpError(400, "RECOVERY_URL_INVALID", "The recovery URL is invalid.");
      }
      const { account } = createAdminAppwrite();
      try {
        await account.createRecovery({ email, url });
      } catch (error) {
        if (
          !(
            error instanceof AppwriteException &&
            (error.code === 404 || error.code === 400 || error.type === "user_not_found")
          )
        ) {
          throw error;
        }
      }
      return authJson({ sent: true, requestId }, requestId);
    }

    if (path === "recovery/complete") {
      const userId = text(body.userId, "User", 1, 128);
      const recoverySecret = text(body.secret, "Recovery", 1, 8_192);
      const password = text(body.password, "Password", 8, 1_024);
      const { account } = createAdminAppwrite();
      await account.updateRecovery({ userId, secret: recoverySecret, password });
      return authJson({ updated: true, requestId }, requestId);
    }

    assertCookieMutationRequest(request, allowedOrigins());
    const secret = sessionSecret(request);
    const scoped = createSessionAppwrite(secret);

    if (path === "sign-out") {
      const { config } = scoped;
      let revocationFailed = false;
      try {
        await scoped.account.deleteSession({ sessionId: "current" });
      } catch (error) {
        if (!(error instanceof AppwriteException && error.code === 401)) {
          revocationFailed = true;
        }
      }
      const response = revocationFailed
        ? withRequestId(
            toErrorResponse(
              new HttpError(
                503,
                "SIGN_OUT_INCOMPLETE",
                "The local session was cleared, but server-session revocation could not be confirmed.",
              ),
              requestId,
            ),
            requestId,
          )
        : authJson({ signedOut: true, requestId }, requestId);
      clearSessionCookies(response, request, config.projectId);
      return response;
    }
    if (path === "verification") {
      const url = text(body.url, "Verification URL", 10, 2_048);
      const parsed = new URL(url);
      if (parsed.origin !== requestPublicOrigin(request) || parsed.pathname !== "/verify") {
        throw new HttpError(400, "VERIFICATION_URL_INVALID", "The verification URL is invalid.");
      }
      await scoped.account.createVerification({ url });
      return authJson({ sent: true, requestId }, requestId);
    }
    if (path === "verification/complete") {
      const userId = text(body.userId, "User", 1, 128);
      const verificationSecret = text(body.secret, "Verification", 1, 8_192);
      await scoped.account.updateVerification({ userId, secret: verificationSecret });
      return authJson({ verified: true, requestId }, requestId);
    }
    if (path === "mfa/enroll/start") {
      const user = await scoped.account.get();
      if (!user.emailVerification) {
        throw new HttpError(403, "EMAIL_NOT_VERIFIED", "Verify your email before setting up an authenticator.");
      }
      const factors = await scoped.account.listMFAFactors();
      if (factors.totp) {
        // An authenticator already exists. If multi-factor is on, enrollment
        // finished and there is nothing to re-issue: recovery codes are shown
        // once and cannot be read back, so the only honest offer here is the
        // regenerate action in Account security.
        if (user.mfa) {
          return authJson({ enabled: true, resumed: true, requestId }, requestId);
        }
        // Multi-factor is off with an authenticator present, so a previous
        // enrollment was abandoned before its codes were acknowledged. Those
        // codes cannot be shown again, so replace them and say so, rather than
        // leaving the account holding a set nobody has.
        const recovery = await issueRecoveryCodes(scoped.account);
        return authJson(
          {
            enabled: false,
            resumed: true,
            replacedRecoveryCodes: true,
            recoveryCodes: recovery.recoveryCodes,
            requestId,
          },
          requestId,
        );
      }
      const authenticator = await scoped.account.createMFAAuthenticator({ type: AuthenticatorType.Totp });
      const qrCodeDataUrl = await QRCode.toDataURL(authenticator.uri, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 240,
      });
      return authJson(
        { secret: authenticator.secret, uri: authenticator.uri, qrCodeDataUrl, requestId },
        requestId,
      );
    }
    if (path === "mfa/enroll/complete") {
      const otp = text(body.otp, "Authentication code", 6, 12);
      await scoped.account.updateMFAAuthenticator({ type: AuthenticatorType.Totp, otp });
      const recovery = await issueRecoveryCodes(scoped.account);
      // Deliberately does not enable multi-factor. The codes have been shown
      // but not yet saved, and enabling here is what let a browser closed on
      // this screen leave an account enforcing a factor whose recovery codes
      // its owner had never read. `mfa/enroll/acknowledge` turns it on.
      return authJson(
        { enabled: false, recoveryCodes: recovery.recoveryCodes, requestId },
        requestId,
      );
    }
    if (path === "mfa/enroll/acknowledge") {
      const factors = await scoped.account.listMFAFactors();
      if (!factors.totp) {
        throw new HttpError(
          409,
          "MFA_NOT_ENROLLED",
          "Set up an authenticator before turning on multi-factor sign-in.",
        );
      }
      const user = await scoped.account.get();
      if (!user.mfa) await scoped.account.updateMFA({ mfa: true });
      const nextUser = await scoped.account.get();
      return authJson(
        { enabled: true, user: serializeUser(nextUser), requestId },
        requestId,
      );
    }
    if (path === "mfa/disable") {
      const user = await scoped.account.get();
      try {
        await scoped.account.deleteMFAAuthenticator({ type: AuthenticatorType.Totp });
      } catch (error) {
        if (!(error instanceof AppwriteException && (error.code === 404 || error.code === 400))) {
          throw error;
        }
      }
      if (user.mfa) await scoped.account.updateMFA({ mfa: false });
      const nextUser = await scoped.account.get();
      return authJson({ enabled: false, user: serializeUser(nextUser), requestId }, requestId);
    }
    if (path === "mfa/recovery/regenerate") {
      await requireRecentTotp(request);
      const recovery = await scoped.account.updateMFARecoveryCodes();
      return authJson({ recoveryCodes: recovery.recoveryCodes, requestId }, requestId);
    }
    if (path === "mfa/challenge") {
      const factor = body.factor === "recoveryCode"
        ? AuthenticationFactor.Recoverycode
        : AuthenticationFactor.Totp;
      const challenge = await scoped.account.createMFAChallenge({ factor });
      return authJson({ challengeId: challenge.$id, requestId }, requestId);
    }
    if (path === "mfa/complete") {
      const challengeId = text(body.challengeId, "Challenge", 1, 128);
      const otp = text(body.otp, "Authentication code", 6, 128);
      await scoped.account.updateMFAChallenge({ challengeId, otp });
      const user = await scoped.account.get();
      return authJson({ user: serializeUser(user), requestId }, requestId);
    }
    if (path === "password") {
      const currentPassword = text(body.currentPassword, "Current password", 8, 1_024);
      const password = text(body.password, "Password", 8, 1_024);
      await scoped.account.updatePassword({ password, oldPassword: currentPassword });
      return authJson({ updated: true, requestId }, requestId);
    }
    if (path === "profile") {
      const name = text(body.name, "Name", 2, 128);
      await scoped.account.updateName({ name });
      const user = await scoped.account.get();
      return authJson({ user: serializeUser(user), requestId }, requestId);
    }
    if (path === "sessions/revoke-others") {
      const sessions = await scoped.account.listSessions();
      await Promise.all(
        sessions.sessions
          .filter((session) => !session.current)
          .map((session) => scoped.account.deleteSession({ sessionId: session.$id })),
      );
      return authJson({ revoked: true, requestId }, requestId);
    }
    throw new HttpError(404, "AUTH_ROUTE_NOT_FOUND", "Authentication route not found.");
  } catch (error) {
    return withRequestId(toErrorResponse(translate(error), requestId), requestId);
  }
}
