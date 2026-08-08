import { env } from "cloudflare:workers";
import {
  allRows,
  authorize,
  D1KnowHowRepository,
  HttpError,
  requireD1Binding,
  requireVerifiedIdentity,
  toErrorResponse,
  type D1DatabaseLike,
} from "../../../../lib/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

function statement(db: D1DatabaseLike, sql: string, ...values: unknown[]) {
  return db.prepare(sql).bind(...values);
}

function queryValue(url: URL, key: string, max: number) {
  const value = url.searchParams.get(key)?.trim() ?? "";
  if (value.length > max) throw new HttpError(400, "AUDIT_FILTER_INVALID", "An audit filter is invalid.");
  return value;
}

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  const eventId = crypto.randomUUID();
  try {
    const url = new URL(request.url);
    const workspaceId = queryValue(url, "workspaceId", 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(workspaceId)) {
      throw new HttpError(400, "AUDIT_FILTER_INVALID", "Workspace is required.");
    }
    const action = queryValue(url, "action", 128);
    const from = queryValue(url, "from", 32);
    const to = queryValue(url, "to", 32);
    if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) {
      throw new HttpError(400, "AUDIT_FILTER_INVALID", "Audit dates are invalid.");
    }

    const db = requireD1Binding(env.DB);
    const repository = new D1KnowHowRepository(db);
    await repository.ensureSecurityGuards();
    const identity = await requireVerifiedIdentity(request);
    const access = await repository.getWorkspaceAccess(workspaceId, identity.userId);
    if (!access) throw new HttpError(403, "WORKSPACE_ACCESS_REQUIRED", "You do not belong to this workspace.");
    const allowed = authorize("workspace.audit.read", {
      isVerifiedIdentity: true,
      membershipStatus: access.membershipStatus,
      workspaceStatus: access.workspaceStatus,
      roles: access.roles,
      capabilities: access.capabilities,
    });
    if (!allowed.allowed) throw new HttpError(403, allowed.code, allowed.reason);

    const predicates = ["workspace_id = ?"];
    const values: unknown[] = [workspaceId];
    if (action) {
      predicates.push("action = ?");
      values.push(action);
    }
    if (from) {
      predicates.push("unixepoch(occurred_at) >= unixepoch(?)");
      values.push(new Date(from).toISOString());
    }
    if (to) {
      predicates.push("unixepoch(occurred_at) <= unixepoch(?)");
      values.push(new Date(to).toISOString());
    }
    const events = await allRows<{
      sequence: number;
      occurred_at: string;
      action: string;
      actor_name: string | null;
      actor_email: string | null;
      target_type: string;
      target_id: string | null;
      target_label: string | null;
      summary: string;
      metadata_json: string;
      event_hash: string;
    }>(
      statement(
        db,
        `SELECT sequence, occurred_at, action, actor_name, actor_email,
                target_type, target_id, target_label, summary, metadata_json, event_hash
         FROM audit_events
         WHERE ${predicates.join(" AND ")}
         ORDER BY sequence ASC
         LIMIT 50001`,
        ...values,
      ),
    );
    if (events.length > 50_000) {
      throw new HttpError(413, "AUDIT_EXPORT_TOO_LARGE", "Narrow the date or action filter before exporting.");
    }
    const header = [
      "sequence",
      "occurred_at",
      "action",
      "actor_name",
      "actor_email",
      "target_type",
      "target_id",
      "target_label",
      "summary",
      "metadata_json",
      "event_hash",
    ];
    const csv = [
      header.map(csvCell).join(","),
      ...events.map((event) =>
        [
          event.sequence,
          event.occurred_at,
          event.action,
          event.actor_name,
          event.actor_email,
          event.target_type,
          event.target_id,
          event.target_label,
          event.summary,
          event.metadata_json,
          event.event_hash,
        ]
          .map(csvCell)
          .join(","),
      ),
    ].join("\r\n");
    await repository.executeAuditedMutation({
      workspaceId,
      actor: { userId: identity.userId, email: identity.email, name: identity.name },
      event: {
        action: "audit.exported",
        targetType: "audit-history",
        targetId: workspaceId,
        summary: "Permitted audit history exported",
        metadata: { rowCount: events.length, actionFilter: action || null, from: from || null, to: to || null },
      },
      statements: [],
    });
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="knowhow-audit-${workspaceId}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return toErrorResponse(error, eventId);
  }
}
