import { LeadService, type LeadKind } from "@/lib/server/lead-service";
import {
  HttpError,
  assertTrustedOrigin,
  jsonResponse,
  readCookie,
  readJsonObject,
  requestPublicOrigin,
  toErrorResponse,
} from "@/lib/server/http-security";
import {
  allowedRequestOrigins,
  correlationId,
  createRequestServices,
  withRequestId,
} from "@/lib/server/request-services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_CSRF_COOKIE = "knowhow_public_csrf";

function secure(request: Request) {
  return requestPublicOrigin(request).startsWith("https://");
}

function clientFingerprint(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  const address = forwarded && /^[0-9a-f:.]{3,64}$/i.test(forwarded) ? forwarded : "unknown";
  const agent = (request.headers.get("user-agent") ?? "unknown").slice(0, 256);
  const pepper = process.env.KNOWHOW_RATE_LIMIT_PEPPER?.trim();
  if (!pepper && process.env.NODE_ENV === "production") {
    throw new HttpError(503, "RATE_LIMIT_CONFIGURATION_INVALID", "Request protection is temporarily unavailable.", { expose: false });
  }
  return `${pepper || "development-only-rate-limit"}:${address}:${agent}`;
}

function assertPublicCsrf(request: Request) {
  assertTrustedOrigin(request, allowedRequestOrigins());
  const cookie = readCookie(request, PUBLIC_CSRF_COOKIE);
  const header = request.headers.get("x-csrf-token");
  if (!cookie || !header || cookie.length !== 64 || header.length !== cookie.length) {
    throw new HttpError(403, "CSRF_INVALID", "The request could not be verified.");
  }
  let mismatch = 0;
  for (let index = 0; index < cookie.length; index += 1) {
    mismatch |= cookie.charCodeAt(index) ^ header.charCodeAt(index);
  }
  if (mismatch) throw new HttpError(403, "CSRF_INVALID", "The request could not be verified.");
}

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const response = jsonResponse({ csrfToken: token, requestId });
    response.headers.append(
      "set-cookie",
      `${PUBLIC_CSRF_COOKIE}=${token}; Path=/api/leads; SameSite=Strict; Max-Age=3600${secure(request) ? "; Secure" : ""}`,
    );
    return withRequestId(response, requestId);
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}

export async function POST(request: Request) {
  const requestId = correlationId(request);
  try {
    assertPublicCsrf(request);
    const body = await readJsonObject(request, 16_384);
    const { store } = createRequestServices();
    const result = await new LeadService(store).create(
      {
        kind: body.kind as LeadKind,
        name: body.name,
        email: body.email,
        organization: body.organization,
        role: body.role,
        teamSize: body.teamSize,
        country: body.country,
        workflow: body.workflow,
        ordinaryDataOnly: body.ordinaryDataOnly,
        website: body.website,
      },
      { requestId, clientFingerprint: clientFingerprint(request) },
    );
    return withRequestId(
      jsonResponse({ accepted: true, duplicate: result.duplicate, requestId }, { status: result.duplicate ? 200 : 201 }),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
