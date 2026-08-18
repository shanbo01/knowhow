import { HttpError, jsonResponse, toErrorResponse } from "../../../../lib/server/http-security";
import { PlatformQueryService } from "../../../../lib/server/platform-query-service";
import { consumeFixedWindows } from "../../../../lib/server/rate-limit-service";
import {
  correlationId,
  createRequestServices,
  withRequestId,
} from "../../../../lib/server/request-services";
import { requireVerifiedSession } from "../../../../lib/server/session-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESOURCES = new Set([
  "home",
  "queues",
  "customers",
  "customer",
  "accounts",
  "account",
  "leads",
  "lead",
  "tickets",
  "ticket",
  "tools",
  "billing",
  "activity",
  "search",
]);

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const identity = await requireVerifiedSession(request);
    const { store } = createRequestServices();
    await consumeFixedWindows(store, [
      {
        scope: "knowhow.platform.query",
        subject: identity.userId,
        limit: 120,
        windowSeconds: 60,
      },
    ]);
    const url = new URL(request.url);
    const resource = url.searchParams.get("resource")?.trim() ?? "queues";
    if (!RESOURCES.has(resource)) {
      throw new HttpError(400, "PLATFORM_QUERY_INVALID", "Unknown platform query.");
    }
    const service = new PlatformQueryService(store);
    const query = url.searchParams.get("q")?.trim() ?? "";
    const status = url.searchParams.get("status")?.trim() ?? "";
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;
    const limit = url.searchParams.get("limit");
    const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
    const leadId = url.searchParams.get("leadId")?.trim() ?? "";
    const ticketId = url.searchParams.get("ticketId")?.trim() ?? "";

    let body: object;
    if (resource === "home") body = await service.home(identity);
    else if (resource === "queues") body = await service.queues(identity);
    else if (resource === "customers" || resource === "accounts") {
      body = await service.listAccounts(identity, { query, status, cursor, limit });
    } else if (resource === "customer" || resource === "account") {
      if (!workspaceId) {
        throw new HttpError(400, "WORKSPACE_FILTER_INVALID", "Customer is required.");
      }
      body = { account: await service.account(identity, workspaceId) };
    } else if (resource === "leads") {
      body = await service.listLeads(identity, { query, status, cursor, limit });
    } else if (resource === "lead") {
      if (!leadId) throw new HttpError(400, "LEAD_FILTER_INVALID", "Lead is required.");
      body = { lead: await service.lead(identity, leadId) };
    } else if (resource === "tickets") {
      body = await service.listTickets(identity, {
        query,
        status,
        workspaceId: workspaceId || undefined,
        cursor,
        limit,
      });
    } else if (resource === "ticket") {
      if (!ticketId) {
        throw new HttpError(400, "SUPPORT_TICKET_FILTER_INVALID", "Ticket is required.");
      }
      body = { ticket: await service.ticket(identity, ticketId) };
    } else if (resource === "tools" || resource === "activity") {
      body = await service.listActivity(identity, { cursor, limit });
    } else if (resource === "billing") {
      body = await service.listBilling(identity, { query, status, cursor, limit });
    } else {
      body = await service.search(identity, query);
    }

    return withRequestId(jsonResponse({ ...body, requestId }), requestId);
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
