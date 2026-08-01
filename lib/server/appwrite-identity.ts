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

interface AppwriteUserResponse {
  $id: string;
  email: string;
  name: string;
  emailVerification: boolean;
  labels: string[];
}

function appwriteAccountUrl(config: AppwriteIdentityConfig): string {
  return `${config.endpoint}/account`;
}

async function fetchAppwriteUser(
  jwt: string,
  request: Request,
  config: AppwriteIdentityConfig,
): Promise<AppwriteUserResponse> {
  const headers = new Headers({
    accept: "application/json",
    "X-Appwrite-JWT": jwt,
    "X-Appwrite-Project": config.projectId,
    "X-Appwrite-Response-Format": "1.9.5",
  });
  const userAgent = request.headers.get("user-agent");
  if (userAgent) headers.set("X-Forwarded-User-Agent", userAgent.slice(0, 512));

  let response: Response;
  try {
    // Use the runtime's native Fetch API. The Node Appwrite SDK bundles
    // Undici, whose TLS options are not fully supported by Workers.
    response = await fetch(appwriteAccountUrl(config), {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "manual",
      signal: request.signal,
    });
  } catch (error) {
    throw new HttpError(
      503,
      "IDENTITY_PROVIDER_UNAVAILABLE",
      "Sign-in validation is temporarily unavailable.",
      { cause: error },
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(
      401,
      "INVALID_APPWRITE_JWT",
      "Your session has expired. Sign in again.",
    );
  }
  if (response.status >= 300 || !response.ok) {
    throw new HttpError(
      503,
      "IDENTITY_PROVIDER_UNAVAILABLE",
      "Sign-in validation is temporarily unavailable.",
    );
  }

  let user: unknown;
  try {
    user = await response.json();
  } catch (error) {
    throw new HttpError(
      503,
      "IDENTITY_PROVIDER_UNAVAILABLE",
      "Sign-in validation is temporarily unavailable.",
      { cause: error },
    );
  }
  if (
    !user ||
    typeof user !== "object" ||
    typeof (user as Partial<AppwriteUserResponse>).$id !== "string" ||
    !(user as Partial<AppwriteUserResponse>).$id?.trim() ||
    typeof (user as Partial<AppwriteUserResponse>).email !== "string" ||
    !(user as Partial<AppwriteUserResponse>).email?.trim() ||
    typeof (user as Partial<AppwriteUserResponse>).name !== "string" ||
    typeof (user as Partial<AppwriteUserResponse>).emailVerification !== "boolean" ||
    !Array.isArray((user as Partial<AppwriteUserResponse>).labels) ||
    !(user as Partial<AppwriteUserResponse>).labels?.every(
      (label) => typeof label === "string",
    )
  ) {
    throw new HttpError(
      503,
      "IDENTITY_PROVIDER_UNAVAILABLE",
      "Sign-in validation is temporarily unavailable.",
    );
  }
  return user as AppwriteUserResponse;
}

function toIdentity(user: AppwriteUserResponse): AuthenticatedIdentity {
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
  return toIdentity(await fetchAppwriteUser(jwt, request, config));
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
