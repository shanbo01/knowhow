import { recordHttpFailure } from "./telemetry";
import { RecordConflictError } from "./record-store";

const DEFAULT_JSON_LIMIT = 256_000;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.expose = options.expose ?? status < 500;
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
      ...(requestId ? { requestId } : {}),
    },
    { status: failure.status },
  );
}
