import { DesktopAuthService } from "../../../../../lib/server/desktop-auth-service";
import { DesktopCaptureService } from "../../../../../lib/server/desktop-capture-service";
import {
  HttpError,
  jsonResponse,
  toErrorResponse,
} from "../../../../../lib/server/http-security";
import {
  correlationId,
  createRequestServices,
  requestFingerprint,
} from "../../../../../lib/server/request-services";
import { consumeFixedWindows } from "../../../../../lib/server/rate-limit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path?: string[] }> };

function safePathId(value: string | undefined, label: string, maximum = 36) {
  const id = value?.trim() ?? "";
  const pattern =
    maximum === 36
      ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/
      : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if (!pattern.test(id)) {
    throw new HttpError(
      400,
      "DESKTOP_PATH_INVALID",
      `${label} is invalid.`,
    );
  }
  return id;
}

function desktopHeaders(response: Response, requestId: string) {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-knowhow-api-version", "desktop-v1");
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function dispatch(request: Request, context: RouteContext) {
  const path = (await context.params).path ?? [];
  const services = createRequestServices();
  const auth = new DesktopAuthService(services.store);
  const captures = new DesktopCaptureService(services.store, services.objects);
  const fingerprint = requestFingerprint(request);

  if (
    request.method === "POST" &&
    path.length === 1 &&
    path[0] === "authorizations"
  ) {
    await consumeFixedWindows(services.store, [
      {
        scope: "desktop.authorization.create",
        subject: fingerprint,
        limit: 10,
        windowSeconds: 60,
      },
    ]);
    return auth.createAuthorization(request);
  }
  if (
    request.method === "POST" &&
    path.length === 3 &&
    path[0] === "authorizations" &&
    path[2] === "token"
  ) {
    await consumeFixedWindows(services.store, [
      {
        scope: "desktop.authorization.token",
        subject: fingerprint,
        limit: 60,
        windowSeconds: 60,
      },
    ]);
    return auth.token(request, safePathId(path[1], "Authorization"));
  }
  if (request.method === "POST" && path.join("/") === "token/refresh") {
    await consumeFixedWindows(services.store, [
      {
        scope: "desktop.refresh",
        subject: fingerprint,
        limit: 30,
        windowSeconds: 60,
      },
    ]);
    return auth.refresh(request);
  }

  await consumeFixedWindows(services.store, [
    {
      scope: "desktop.authorized",
      subject: fingerprint,
      limit: 300,
      windowSeconds: 60,
    },
  ]);
  if (request.method === "GET" && path.join("/") === "context") {
    return captures.context(request);
  }
  if (request.method === "POST" && path.join("/") === "captures") {
    return captures.start(request);
  }
  if (
    request.method === "PATCH" &&
    path.length === 2 &&
    path[0] === "captures"
  ) {
    return captures.expectedSteps(
      request,
      safePathId(path[1], "Capture"),
    );
  }
  if (
    request.method === "POST" &&
    path.length === 3 &&
    path[0] === "captures" &&
    (path[2] === "pause" || path[2] === "resume")
  ) {
    return captures.transition(
      request,
      safePathId(path[1], "Capture"),
      path[2],
    );
  }
  if (
    request.method === "DELETE" &&
    path.length === 2 &&
    path[0] === "captures"
  ) {
    return captures.discard(
      request,
      safePathId(path[1], "Capture"),
    );
  }
  if (
    request.method === "PUT" &&
    path.length === 5 &&
    path[0] === "captures" &&
    path[2] === "steps" &&
    path[4] === "screenshot"
  ) {
    return captures.upload(
      request,
      safePathId(path[1], "Capture"),
      safePathId(path[3], "Step", 128),
    );
  }
  if (
    request.method === "POST" &&
    path.length === 3 &&
    path[0] === "captures" &&
    path[2] === "commit"
  ) {
    return captures.commit(
      request,
      safePathId(path[1], "Capture"),
    );
  }
  throw new HttpError(
    404,
    "DESKTOP_ROUTE_NOT_FOUND",
    "This desktop endpoint is unavailable.",
  );
}

async function handle(request: Request, context: RouteContext) {
  const requestId = correlationId(request);
  try {
    const result = await dispatch(request, context);
    const response =
      result instanceof Response
        ? result
        : jsonResponse(
            typeof result === "object" && result !== null
              ? { ...result, requestId }
              : { data: result, requestId },
          );
    return desktopHeaders(response, requestId);
  } catch (error) {
    return desktopHeaders(toErrorResponse(error, requestId), requestId);
  }
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { allow: "GET, POST, PUT, PATCH, DELETE, OPTIONS" },
  });
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
