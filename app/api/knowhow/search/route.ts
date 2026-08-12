import { searchAuthorizedGuides } from "../../../../lib/server/guide-search-service";
import {
  HttpError,
  jsonResponse,
  toErrorResponse,
} from "../../../../lib/server/http-security";
import { consumeFixedWindows } from "../../../../lib/server/rate-limit-service";
import {
  correlationId,
  createRequestServices,
  withRequestId,
} from "../../../../lib/server/request-services";
import { requireVerifiedSession } from "../../../../lib/server/session-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(workspaceId)) {
      throw new HttpError(
        400,
        "SEARCH_FILTER_INVALID",
        "Workspace is required.",
      );
    }
    const query = url.searchParams.get("q")?.trim() ?? "";
    const identity = await requireVerifiedSession(request);
    const { store } = createRequestServices();
    await consumeFixedWindows(store, [
      {
        scope: "knowhow.search",
        subject: identity.userId,
        limit: 120,
        windowSeconds: 60,
      },
    ]);
    const results = await searchAuthorizedGuides(
      store,
      identity,
      workspaceId,
      query,
    );
    return withRequestId(
      jsonResponse({ results, requestId }),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
