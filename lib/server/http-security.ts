import { recordHttpFailure } from "./telemetry";
import { RecordConflictError } from "./record-store";

const DEFAULT_JSON_LIMIT = 256_000;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;
  /**
   * Set when the failure is an entitlement denial. Carried to the client so the
   * UI can name the blocked feature and offer the matching upgrade path.
   */
  readonly entitlement?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { expose?: boolean; cause?: unknown; entitlement?: string } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.expose = options.expose ?? status < 500;
    this.entitlement = options.entitlement;
  }
}
export function requireBearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  if (!match || match[1].length > 16_384) {
    throw new HttpError(401, "AUTH_REQUIRED", "Sign in to continue.");
  }
  return match[1];
}

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function requestPublicOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  if (
    forwardedHost &&
    /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.test(forwardedHost) &&
    (forwardedProtocol === "https" ||
      (forwardedProtocol === "http" && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(forwardedHost)))
  ) {
    return `${forwardedProtocol}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}

/**
 * The origin to put in a link a client will later navigate to.
 *
 * `request.url` is not it. Behind a proxy, a standalone Next server reports its
 * own bind address there, so a link built from it points at `0.0.0.0:3000` —
 * routable from nowhere, including the machine that served it. The deployment
 * already knows its public origin; ask it first, and only fall back to reading
 * it off the request when nothing is configured (a developer running locally).
 */
export function publicAppOrigin(request: Request): string {
  const configured = process.env.KNOWHOW_PUBLIC_APP_ORIGIN?.trim();
  if (configured) {
    try {
      const origin = new URL(configured);
      if (origin.protocol === "https:" || origin.protocol === "http:") {
        return origin.origin;
      }
    } catch {
      // Falls through to the request, and the configuration check reports it.
    }
  }
  return requestPublicOrigin(request);
}

function requestHostOrigin(request: Request): string | null {
  const host = request.headers.get("host")?.split(",", 1)[0]?.trim();
  if (
    !host ||
    !/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.test(host)
  ) {
    return null;
  }
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim();
  const requestProtocol = new URL(request.url).protocol.replace(/:$/, "");
  const protocol = forwardedProtocol === "https" ? "https" : requestProtocol;
  if (
    protocol !== "https" &&
    !(
      protocol === "http" &&
      /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host)
    )
  ) {
    return null;
  }
  return normalizedOrigin(`${protocol}://${host}`);
}

export function assertTrustedOrigin(
  request: Request,
  allowedOrigins: readonly string[] = [],
): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new HttpError(403, "ORIGIN_REQUIRED", "The request origin is required.");
  }

  const requestOrigin = requestPublicOrigin(request);
  const accepted = new Set<string>([requestOrigin]);
  const hostOrigin = requestHostOrigin(request);
  if (hostOrigin) accepted.add(hostOrigin);
  for (const candidate of allowedOrigins) {
    const normalized = normalizedOrigin(candidate);
    if (normalized) accepted.add(normalized);
  }

  const normalized = normalizedOrigin(origin);
  if (!normalized || !accepted.has(normalized)) {
    throw new HttpError(403, "UNTRUSTED_ORIGIN", "The request origin is not allowed.");
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") {
    throw new HttpError(403, "CROSS_SITE_REQUEST", "Cross-site requests are not allowed.");
  }
}

export const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;

/**
 * Resolves the calling extension's origin, or null when the browser did not
 * send one.
 *
 * A missing `Origin` is the normal case, not a suspicious one. The capture
 * extension holds `host_permissions` for the deployment, so Chrome treats its
 * service-worker requests as permitted rather than cross-origin and sends no
 * `Origin` at all. The extension cannot supply one either: `Origin` is a
 * forbidden header name, and `fetch` silently drops any attempt to set it.
 *
 * Requiring the header therefore rejects exactly the client it was meant to
 * admit, and it buys nothing against the client it was meant to exclude —
 * `Origin` is only evidence when a browser sets it, and anything that is not a
 * browser can send whatever it likes. What actually authenticates these
 * requests is the bearer token and the paired device behind it.
 *
 * So: enforce the allowlist whenever an origin *is* present, and let the
 * absence pass through to the token check.
 */
export function resolveExtensionOrigin(
  request: Request,
  allowedOrigins: readonly string[],
  { allowUnlistedInDevelopment = false } = {},
): string | null {
  const origin = request.headers.get("origin")?.trim() ?? "";
  if (!origin) return null;

  if (
    allowUnlistedInDevelopment &&
    allowedOrigins.length === 0 &&
    EXTENSION_ORIGIN_PATTERN.test(origin)
  ) {
    return origin;
  }

  if (!allowedOrigins.includes(origin)) {
    throw new HttpError(
      403,
      "EXTENSION_ORIGIN_DENIED",
      "This browser extension build is not allowed.",
    );
  }
  return origin;
}

function cookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== name) continue;
    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

export const CSRF_COOKIE_NAME = "knowhow_csrf";

export function readCookie(request: Request, name: string) {
  return cookieValue(request, name);
}

export function assertCsrfToken(request: Request): void {
  const cookie = cookieValue(request, CSRF_COOKIE_NAME);
  const header = request.headers.get("x-csrf-token");
  if (
    !cookie ||
    !header ||
    cookie.length < 32 ||
    cookie.length > 256 ||
    header.length !== cookie.length
  ) {
    throw new HttpError(403, "CSRF_INVALID", "The request could not be verified.");
  }
  let mismatch = 0;
  for (let index = 0; index < cookie.length; index += 1) {
    mismatch |= cookie.charCodeAt(index) ^ header.charCodeAt(index);
  }
  if (mismatch !== 0) {
    throw new HttpError(403, "CSRF_INVALID", "The request could not be verified.");
  }
}

export function assertCookieMutationRequest(
  request: Request,
  allowedOrigins: readonly string[] = [],
): void {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "A mutation method is required.");
  }
  assertTrustedOrigin(request, allowedOrigins);
  assertCsrfToken(request);
}

export async function readJsonObject(
  request: Request,
  maxBytes = DEFAULT_JSON_LIMIT,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "JSON_REQUIRED", "Use an application/json request body.");
  }

  const advertisedLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new HttpError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new HttpError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.", {
      cause: error,
    });
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "JSON_OBJECT_REQUIRED", "The request body must be an object.");
  }
  return value as Record<string, unknown>;
}

export function assertMutationRequest(
  request: Request,
  allowedOrigins: readonly string[] = [],
): void {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "A mutation method is required.");
  }
  assertTrustedOrigin(request, allowedOrigins);
  requireBearerToken(request);
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function toErrorResponse(error: unknown, requestId?: string): Response {
  const failure =
    error instanceof HttpError
      ? error
      : error instanceof RecordConflictError
        ? new HttpError(
            409,
            "CONCURRENT_UPDATE",
            "The record changed while this request was running. Retry the operation.",
            { cause: error },
          )
      : new HttpError(500, "INTERNAL_ERROR", "The request could not be completed.", {
          expose: false,
          cause: error,
        });
  recordHttpFailure(error, {
    requestId,
    errorCode: failure.code,
    status: failure.status,
  });
  return jsonResponse(
    {
      error: failure.expose ? failure.message : "The request could not be completed.",
      code: failure.code,
      ...(failure.entitlement ? { entitlement: failure.entitlement } : {}),
      ...(requestId ? { requestId } : {}),
    },
    { status: failure.status },
  );
}
