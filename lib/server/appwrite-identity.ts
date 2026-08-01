import { Account, AppwriteException, Client, type Models } from "node-appwrite";
import { HttpError, requireBearerToken } from "./http-security";

const DEFAULT_ENDPOINT = "https://sgp.cloud.appwrite.io/v1";
const DEFAULT_PROJECT_ID = "6a6a53ac002ca43c7ea4";

export interface AppwriteIdentityConfig {
  endpoint: string;
  projectId: string;
}
export interface AuthenticatedIdentity {
  userId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  labels: readonly string[];
}

function readPublicConfig(
  overrides: Partial<AppwriteIdentityConfig> = {},
): AppwriteIdentityConfig {
  const endpoint =
    overrides.endpoint ?? process.env.APPWRITE_ENDPOINT ?? DEFAULT_ENDPOINT;
  const projectId =
    overrides.projectId ?? process.env.APPWRITE_PROJECT_ID ?? DEFAULT_PROJECT_ID;

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new HttpError(500, "APPWRITE_CONFIG_INVALID", "Authentication is unavailable.", {
      expose: false,
    });
  }
  if (parsed.protocol !== "https:" || !projectId.trim()) {
    throw new HttpError(500, "APPWRITE_CONFIG_INVALID", "Authentication is unavailable.", {
      expose: false,
    });
  }
  return { endpoint: parsed.toString().replace(/\/$/, ""), projectId: projectId.trim() };
}

function createJwtAccount(
  jwt: string,
  request: Request,
  config: AppwriteIdentityConfig,
): Account {
  const client = new Client()
    .setEndpoint(config.endpoint)
    .setProject(config.projectId)
    .setJWT(jwt);
  const userAgent = request.headers.get("user-agent");
  if (userAgent) client.setForwardedUserAgent(userAgent.slice(0, 512));
  return new Account(client);
}

function toIdentity(user: Models.User<Models.DefaultPreferences>): AuthenticatedIdentity {
  return Object.freeze({
    userId: user.$id,
    email: user.email.trim().toLowerCase(),
    name: user.name?.trim() || user.email,
    emailVerified: user.emailVerification,
    labels: Object.freeze([...(user.labels ?? [])]),
  });
}

export async function authenticateAppwriteJwt(
  request: Request,
  configOverrides: Partial<AppwriteIdentityConfig> = {},
): Promise<AuthenticatedIdentity> {
  const jwt = requireBearerToken(request);
  const config = readPublicConfig(configOverrides);
  try {
    const user = await createJwtAccount(jwt, request, config).get();
    return toIdentity(user);
  } catch (error) {
    if (
      error instanceof AppwriteException &&
      (error.code === 401 || error.code === 403)
    ) {
      throw new HttpError(401, "INVALID_APPWRITE_JWT", "Your session has expired. Sign in again.", {
        cause: error,
      });
    }
    throw new HttpError(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Sign-in validation is temporarily unavailable.", {
      cause: error,
    });
  }
}

export async function requireVerifiedIdentity(
  request: Request,
  configOverrides: Partial<AppwriteIdentityConfig> = {},
): Promise<AuthenticatedIdentity> {
  const identity = await authenticateAppwriteJwt(request, configOverrides);
  if (!identity.emailVerified) {
    throw new HttpError(403, "EMAIL_NOT_VERIFIED", "Verify your email address before accessing a workspace.");
  }
  return identity;
}
