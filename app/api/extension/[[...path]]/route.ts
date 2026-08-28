import { ExtensionAuthService } from "../../../../lib/server/extension-auth-service";
import { ExtensionCaptureService } from "../../../../lib/server/extension-capture-service";
import { HttpError, jsonResponse, toErrorResponse } from "../../../../lib/server/http-security";
import {
  correlationId,
  createRequestServices,
  requestFingerprint,
  withRequestId,
} from "../../../../lib/server/request-services";
import { consumeFixedWindows } from "../../../../lib/server/rate-limit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path?: string[] }> };

function originAllowlist() {
  return (process.env.KNOWHOW_EXTENSION_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^chrome-extension:\/\/[a-p]{32}$/.test(value));
}

function extensionOrigin(request: Request) {
  const origin = request.headers.get("origin")?.trim() ?? "";
  const allowed = originAllowlist();
  const production = process.env.KNOWHOW_ENVIRONMENT === "production" || process.env.KNOWHOW_ENVIRONMENT === "staging";
  if (!origin) {
    if (production) throw new HttpError(403, "EXTENSION_ORIGIN_REQUIRED", "The browser extension origin is required.");
    return null;
  }
  if (!production && allowed.length === 0 && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    return origin;
  }
  if (!allowed.includes(origin)) {
    throw new HttpError(403, "EXTENSION_ORIGIN_DENIED", "This browser extension build is not allowed.");
  }
  return origin;
}

function withExtensionHeaders(response: Response, requestId: string, origin: string | null) {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-knowhow-api-version", "1");
  headers.set("vary", "Origin");
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    headers.set("access-control-allow-headers", "Authorization, Content-Type, Idempotency-Key, X-KnowHow-Redacted, X-KnowHow-Source-Rasterized, X-KnowHow-Image-Width, X-KnowHow-Image-Height, X-KnowHow-Step-Title, X-Request-Id");
    headers.set("access-control-max-age", "600");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function safePathId(value: string | undefined, label: string, maximum = 36) {
  const id = value?.trim() ?? "";
  const pattern = maximum === 36
    ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/
    : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if (!pattern.test(id)) throw new HttpError(400, "EXTENSION_PATH_INVALID", `${label} is invalid.`);
  return id;
}

async function dispatch(request: Request, context: RouteContext) {
  const path = (await context.params).path ?? [];
  const services = createRequestServices();
  const auth = new ExtensionAuthService(services.store);
  const captures = new ExtensionCaptureService(services.store, services.objects);
  const fingerprint = requestFingerprint(request);

  if (request.method === "POST" && path.length === 1 && path[0] === "pair") {
    await consumeFixedWindows(services.store, [{ scope: "extension.pair", subject: fingerprint, limit: 10, windowSeconds: 60 }]);
    return auth.pair(request);
  }
  if (request.method === "POST" && path.join("/") === "token/refresh") {
    await consumeFixedWindows(services.store, [{ scope: "extension.refresh", subject: fingerprint, limit: 30, windowSeconds: 60 }]);
    return auth.refresh(request);
  }
  await consumeFixedWindows(services.store, [{ scope: "extension.authorized", subject: fingerprint, limit: 300, windowSeconds: 60 }]);
  if (request.method === "GET" && path.join("/") === "context") {
    return captures.context(request);
  }
  if (request.method === "GET" && path.join("/") === "library") {
    return captures.library(request);
  }
  if (request.method === "GET" && path.length === 2 && path[0] === "media") {
    return captures.media(request, safePathId(path[1], "Media"));
  }
  if (request.method === "POST" && path.join("/") === "captures") {
    return captures.start(request);
  }
  if (request.method === "PATCH" && path.length === 2 && path[0] === "captures") {
    return captures.expectedSteps(request, safePathId(path[1], "Capture"));
  }
  if (
    request.method === "POST" && path.length === 3 && path[0] === "captures" &&
    (path[2] === "pause" || path[2] === "resume")
  ) {
    return captures.transition(request, safePathId(path[1], "Capture"), path[2]);
  }
  if (request.method === "DELETE" && path.length === 2 && path[0] === "captures") {
    return captures.discard(request, safePathId(path[1], "Capture"));
  }
  if (
    request.method === "PUT" && path.length === 3 && path[0] === "captures" &&
    path[2] === "favicon"
  ) {
    return captures.uploadFavicon(
      request,
      safePathId(path[1], "Capture"),
    );
  }
  if (
    request.method === "PUT" && path.length === 5 && path[0] === "captures" &&
    path[2] === "steps" && path[4] === "screenshot"
  ) {
    return captures.upload(
      request,
      safePathId(path[1], "Capture"),
      safePathId(path[3], "Step", 128),
    );
  }
  if (
    request.method === "POST" && path.length === 3 && path[0] === "captures" &&
    path[2] === "commit"
  ) {
    return captures.commit(request, safePathId(path[1], "Capture"));
  }
  throw new HttpError(404, "EXTENSION_ROUTE_NOT_FOUND", "This extension endpoint is unavailable.");
}

async function handle(request: Request, context: RouteContext) {
  const requestId = correlationId(request);
  let origin: string | null = null;
  try {
    origin = extensionOrigin(request);
    const result = await dispatch(request, context);
    const response = result instanceof Response
      ? result
      : jsonResponse(
          typeof result === "object" && result !== null
            ? { ...result, requestId }
            : { data: result, requestId },
        );
    return withExtensionHeaders(response, requestId, origin);
  } catch (error) {
    return withExtensionHeaders(toErrorResponse(error, requestId), requestId, origin);
  }
}

export function OPTIONS(request: Request) {
  const requestId = correlationId(request);
  try {
    const origin = extensionOrigin(request);
    return withExtensionHeaders(new Response(null, { status: 204 }), requestId, origin);
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}

export function GET(request: Request, context: RouteContext) {
  return handle(request, context);
}

export function POST(request: Request, context: RouteContext) {
  return handle(request, context);
}

export function PUT(request: Request, context: RouteContext) {
  return handle(request, context);
}

export function PATCH(request: Request, context: RouteContext) {
  return handle(request, context);
}

export function DELETE(request: Request, context: RouteContext) {
  return handle(request, context);
}
