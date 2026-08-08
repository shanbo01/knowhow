import { env } from "cloudflare:workers";
import {
  authorize,
  D1KnowHowRepository,
  HttpError,
  jsonResponse,
  requireD1Binding,
  requireVerifiedIdentity,
  searchGuides,
  splitSearchTerms,
  toErrorResponse,
} from "../../../../lib/server";
import type { GuideSearchResult } from "../../../../lib/knowhow-types";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const MAX_QUERY_LENGTH = 300;

/**
 * Permission-aware global guide search. A viewer may only search a workspace
 * they are an active member of, and every candidate guide is filtered by the
 * exact same per-revision authorization used by the workspace guide list, so
 * unauthorized guides never surface — not even their existence, metadata, or
 * excerpts. Opening a result performs the normal authorized guide read.
 */
export async function GET(request: Request) {
  const eventId = crypto.randomUUID();
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(workspaceId)) {
      throw new HttpError(400, "SEARCH_FILTER_INVALID", "Workspace is required.");
    }
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (query.length === 0 || query.length > MAX_QUERY_LENGTH) {
      throw new HttpError(400, "SEARCH_QUERY_INVALID", "Enter a search query.");
    }
    if (splitSearchTerms(query).length === 0) {
      throw new HttpError(400, "SEARCH_QUERY_INVALID", "Use search terms of at least two characters.");
    }

    const db = requireD1Binding(env.DB);
    const repository = new D1KnowHowRepository(db);
    await repository.ensureSecurityGuards();
    const identity = await requireVerifiedIdentity(request);
    const access = await repository.getWorkspaceAccess(workspaceId, identity.userId);
    if (!access) throw new HttpError(403, "WORKSPACE_ACCESS_REQUIRED", "You do not belong to this workspace.");
    const allowed = authorize("workspace.read", {
      isVerifiedIdentity: true,
      membershipStatus: access.membershipStatus,
      workspaceStatus: access.workspaceStatus,
      roles: access.roles,
      capabilities: access.capabilities,
      supportGrant: access.supportGrant,
    });
    if (!allowed.allowed) throw new HttpError(403, allowed.code, allowed.reason);

    const results: GuideSearchResult[] = await searchGuides(
      db,
      access,
      identity,
      false,
      query,
    );
    return jsonResponse({ results });
  } catch (error) {
    return toErrorResponse(error, eventId);
  }
}
