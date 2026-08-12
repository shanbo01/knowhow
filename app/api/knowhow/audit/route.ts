import { AccessService } from "../../../../lib/server/access-service";
import { appendAudit } from "../../../../lib/server/audit-service";
import { decodePayload } from "../../../../lib/server/domain-records";
import { HttpError, toErrorResponse } from "../../../../lib/server/http-security";
import { TABLES } from "../../../../lib/server/appwrite-resources";
import { requireAuthorized } from "../../../../lib/server/policy";
import {
  correlationId,
  createRequestServices,
  withRequestId,
} from "../../../../lib/server/request-services";
import { requireVerifiedSession } from "../../../../lib/server/session-identity";
import { consumeFixedWindows } from "../../../../lib/server/rate-limit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StoredAudit = {
  sequence: number;
  action: string;
  actorName: string;
  actorEmail: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  summary: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
  previousHash: string;
  eventHash: string;
};

function queryValue(url: URL, key: string, maximum: number) {
  const value = url.searchParams.get(key)?.trim() ?? "";
  if (value.length > maximum) throw new HttpError(400, "AUDIT_FILTER_INVALID", "An audit filter is invalid.");
  return value;
}

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const url = new URL(request.url);
    const workspaceId = queryValue(url, "workspaceId", 36);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(workspaceId)) {
      throw new HttpError(400, "AUDIT_FILTER_INVALID", "Workspace is required.");
    }
    const action = queryValue(url, "action", 128);
    const from = queryValue(url, "from", 32);
    const to = queryValue(url, "to", 32);
    const fromTime = from ? Date.parse(from) : Number.NEGATIVE_INFINITY;
    const toTime = to ? Date.parse(to) : Number.POSITIVE_INFINITY;
    if (Number.isNaN(fromTime) || Number.isNaN(toTime) || fromTime > toTime) {
      throw new HttpError(400, "AUDIT_FILTER_INVALID", "Audit dates are invalid.");
    }
    const identity = await requireVerifiedSession(request);
    const { store } = createRequestServices();
    await consumeFixedWindows(store, [{ scope: "knowhow.audit-export", subject: identity.userId, limit: 10, windowSeconds: 600 }]);
    const accessService = new AccessService(store);
    const access = await accessService.requireWorkspace(workspaceId, identity);
    requireAuthorized("workspace.audit.read", accessService.context(access));
    const rows = await store.list(TABLES.auditSegments, {
      filters: [{ field: "workspace_id", value: workspaceId }],
      orderBy: "sequence",
      order: "asc",
      limit: 50_001,
    });
    if (rows.length > 50_000) {
      throw new HttpError(413, "AUDIT_EXPORT_TOO_LARGE", "Narrow the date or action filter before exporting.");
    }
    const complete = rows.map((row) => decodePayload<StoredAudit>(row, null as never));
    let previousHash = "0".repeat(64);
    for (const [index, event] of complete.entries()) {
      if (!event || event.sequence !== index + 1 || event.previousHash !== previousHash) {
        throw new HttpError(500, "AUDIT_CHAIN_INVALID", "The audit chain failed verification.", { expose: false });
      }
      previousHash = event.eventHash;
    }
    const events = complete.filter((event) => {
      const occurredAt = Date.parse(event.occurredAt);
      return (!action || event.action === action) && occurredAt >= fromTime && occurredAt <= toTime;
    });
    const header = [
      "sequence", "occurred_at", "action", "actor_name", "actor_email",
      "target_type", "target_id", "target_label", "summary", "metadata_json", "event_hash",
    ];
    const csv = [
      header.map(csvCell).join(","),
      ...events.map((event) => [
        event.sequence,
        event.occurredAt,
        event.action,
        event.actorName,
        event.actorEmail,
        event.targetType,
        event.targetId,
        event.targetLabel,
        event.summary,
        JSON.stringify(event.metadata),
        event.eventHash,
      ].map(csvCell).join(",")),
    ].join("\r\n");
    await store.transaction((transaction) => appendAudit(transaction, identity, workspaceId, {
      action: "audit.exported",
      targetType: "audit-history",
      targetId: workspaceId,
      summary: "Permitted audit history exported",
      metadata: { rowCount: events.length, actionFilter: action || null, from: from || null, to: to || null, requestId },
    }));
    return withRequestId(new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="knowhow-audit-${workspaceId}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    }), requestId);
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
