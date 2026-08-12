import { decodePayload, rowData, type WorkspaceRecord } from "./domain-records";
import { HttpError } from "./http-security";
import { resourceId } from "./ids";
import { TABLES } from "./appwrite-resources";
import type { RecordStore } from "./record-store";
import type { AuthenticatedIdentity } from "./session-identity";

export type AuditInput = {
  action: string;
  targetType: string;
  targetId?: string;
  targetLabel?: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

const SENSITIVE_KEY =
  /(?:password|passphrase|secret|credential|authorization|cookie|clipboard|token|raw.?screenshot|unredacted|api.?key|email\b)/i;

function safeMetadata(value: unknown, path = "metadata", depth = 0): unknown {
  if (depth > 8) throw new HttpError(400, "AUDIT_METADATA_INVALID", `${path} is too deeply nested.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new HttpError(400, "AUDIT_METADATA_INVALID", `${path} has too many items.`);
    return value.map((item, index) => safeMetadata(item, `${path}[${index}]`, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        throw new HttpError(400, "AUDIT_METADATA_SENSITIVE", "Sensitive values cannot be written to the audit log.");
      }
      output[key] = safeMetadata(item, `${path}.${key}`, depth + 1);
    }
    return output;
  }
  throw new HttpError(400, "AUDIT_METADATA_INVALID", `${path} contains an unsupported value.`);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function appendAudit(
  store: RecordStore,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  input: AuditInput,
) {
  const workspaceRow = await store.get(TABLES.workspaces, workspaceId);
  if (!workspaceRow) throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
  const workspace = decodePayload<WorkspaceRecord>(workspaceRow, null as never);
  if (!workspace) throw new HttpError(500, "WORKSPACE_CORRUPT", "Workspace metadata is unavailable.", { expose: false });
  const sequence = workspace.auditSequence + 1;
  const occurredAt = new Date().toISOString();
  const previousHash = workspace.auditHash || "0".repeat(64);
  const metadata = safeMetadata(input.metadata ?? {}) as Record<string, unknown>;
  const event = {
    sequence,
    action: input.action,
    actorUserId: identity.userId,
    actorName: identity.name,
    actorEmail: identity.email,
    targetType: input.targetType,
    targetId: input.targetId ?? "",
    targetLabel: input.targetLabel ?? "",
    summary: input.summary,
    occurredAt,
    metadata,
    previousHash,
  };
  const eventHash = await sha256(`${previousHash}.${stableJson(event)}`);
  await store.create(
    TABLES.auditSegments,
    resourceId("audit"),
    rowData(
      {
        organization_id: workspace.organizationId,
        workspace_id: workspaceId,
        sequence,
        occurred_at: occurredAt,
        status: "sealed",
        kind: input.action,
        subject_id: input.targetId ?? null,
        created_by: identity.userId,
      },
      { ...event, eventHash },
    ),
  );
  await store.update(
    TABLES.workspaces,
    workspaceId,
    rowData(
      {
        organization_id: workspace.organizationId,
        slug: workspace.slug,
        status: workspace.status,
        updated_by: identity.userId,
      },
      { ...workspace, auditSequence: sequence, auditHash: eventHash },
    ),
  );
  return { sequence, eventHash };
}
