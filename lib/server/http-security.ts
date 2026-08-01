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

export function assertTrustedOrigin(
  request: Request,
  allowedOrigins: readonly string[] = [],
): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new HttpError(403, "ORIGIN_REQUIRED", "The request origin is required.");
  }

  const requestOrigin = new URL(request.url).origin;
  const accepted = new Set<string>([requestOrigin]);
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
      : new HttpError(500, "INTERNAL_ERROR", "The request could not be completed.", {
          expose: false,
          cause: error,
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
