import { securityTriggerStatements } from "../../db/schema";
import type {
  RevisionStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from "../knowhow-types";
import {
  allRows,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from "./d1";
import { HttpError } from "./http-security";
import {
  constantTimeEqual,
  hashToken,
  type AppointmentTokenClaims,
  type DeviceTokenClaims,
  type InviteTokenClaims,
  verifyAppointmentToken,
  verifyDeviceToken,
  verifyInviteToken,
} from "./tokens";

const ZERO_HASH = "0".repeat(64);
const MAX_AUDIT_METADATA_BYTES = 32_000;
const SENSITIVE_AUDIT_KEY =
  /(?:password|passphrase|secret|credential|authorization|cookie|clipboard|token|raw.?screenshot|unredacted|api.?key|email\b)/i;

export interface SupportGrantAccess {
  grantId: string;
  role: WorkspaceRole;
  expiresAt: string;
}

export interface WorkspaceAccess {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  entityId: string;
  workspaceStatus: WorkspaceStatus;
  membershipStatus: "active" | "suspended";
  roles: readonly WorkspaceRole[];
  capabilities: readonly "vault"[];
  groupIds: readonly string[];
  /** Present when access comes from a temporary support grant, not membership. */
  supportGrant?: SupportGrantAccess;
}

export interface GuideAccessFacts {
  guideId: string;
  workspaceId: string;
  revisionId: string;
  revisionStatus: RevisionStatus;
  sourceType: "manual" | "capture" | "import";
  isAuthor: boolean;
  isAssignedReviewer: boolean;
  isAudienceMember: boolean;
  exportAllowed: boolean;
  privacyReviewed: boolean;
  reviewApproved: boolean;
}

export interface InvitationState {
  id: string;
  workspaceId: string;
  tokenHash: string;
  email: string | null;
  role: Exclude<WorkspaceRole, "administrator">;
  status: "active" | "revoked" | "exhausted";
  maxUses: number;
  useCount: number;
  expiresAt: string;
  createdVia: "standard" | "support-access";
}

export interface AppointmentState {
  id: string;
  workspaceId: string;
  tokenHash: string;
  email: string;
  status: "active" | "accepted" | "revoked" | "expired";
  expiresAt: string;
}

export interface SupportGrantState {
  id: string;
  requestId: string;
  workspaceId: string;
  userId: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
  status: "active" | "expired" | "revoked";
  approvedBy: string;
  grantedAt: string;
  expiresAt: string;
  endedAt: string | null;
  revokedBy: string | null;
}

export interface SupportRequestState {
  id: string;
  workspaceId: string;
  requesterUserId: string;
  requesterEmail: string;
  requesterName: string;
  requestedRole: WorkspaceRole;
  reason: string;
  requestedDurationHours: number;
  status: "pending" | "approved" | "denied" | "cancelled";
  decidedBy: string | null;
  decidedAt: string | null;
  grantedRole: WorkspaceRole | null;
  grantId: string | null;
  createdAt: string;
}

export interface DeviceTokenState {
  id: string;
  workspaceId: string;
  userId: string;
  deviceId: string;
  tokenHash: string;
  scopes: readonly string[];
  expiresAt: string;
  revokedAt: string | null;
}

export interface ValidatedInvitationCredential {
  claims: InviteTokenClaims;
  invitation: InvitationState;
}

export interface ValidatedDeviceCredential {
  claims: DeviceTokenClaims;
  deviceToken: DeviceTokenState;
}

export type AuditMetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly AuditMetadataValue[]
  | { readonly [key: string]: AuditMetadataValue };

export interface AuditActor {
  userId: string;
  email?: string;
  name?: string;
}

export interface AuditEventInput {
  action: string;
  targetType: string;
  targetId?: string;
  targetLabel?: string;
  summary: string;
  metadata?: Readonly<Record<string, AuditMetadataValue>>;
}

export interface AuditedMutationInput {
  workspaceId: string;
  actor: AuditActor;
  event: AuditEventInput;
  /** Domain statements only. Audit tables are owned by this repository. */
  statements: readonly D1PreparedStatementLike[];
}

export interface AuditReceipt {
  eventId: string;
  sequence: number;
  previousHash: string;
  eventHash: string;
  occurredAt: string;
}

interface WorkspaceAccessRow {
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  entity_id: string;
  workspace_status: WorkspaceStatus;
  membership_status: "active" | "suspended";
  role: WorkspaceRole | null;
  capability: "vault" | null;
}

interface WorkspaceGroupRow {
  workspace_id: string;
  group_id: string;
}

interface SupportGrantRow {
  grant_id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  entity_id: string;
  workspace_status: WorkspaceStatus;
  role: WorkspaceRole;
  expires_at: string;
}

interface GuideRow {
  id: string;
  workspace_id: string;
  author_user_id: string;
  current_published_revision_id: string | null;
  working_draft_revision_id: string | null;
  restricted_exports_enabled: number;
}

interface RevisionRow {
  id: string;
  status: RevisionStatus;
  source_type: GuideAccessFacts["sourceType"];
  privacy_reviewed_at: string | null;
}

interface ReviewSummaryRow {
  approved_count: number | null;
  blocking_count: number | null;
}

interface AuditHeadRow {
  last_sequence: number;
  last_hash: string;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function expirationSeconds(value: string): number | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

function normalizedOptionalEmail(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : value.trim().toLowerCase();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

export function extractExactEmailDomain(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const at = normalized.indexOf("@");
  if (at < 1 || at !== normalized.lastIndexOf("@")) return null;
  const domain = normalized.slice(at + 1);
  if (domain.length === 0 || domain.length > 253) return null;
  const labels = domain.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return null;
  }
  return domain;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function validateAuditMetadata(
  value: unknown,
  path = "metadata",
  depth = 0,
  seen = new WeakSet<object>(),
): void {
  if (depth > 12) {
    throw new HttpError(400, "AUDIT_METADATA_INVALID", "Audit metadata is too deeply nested.");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 8_000) {
      throw new HttpError(400, "AUDIT_METADATA_INVALID", `${path} is too long.`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new HttpError(400, "AUDIT_METADATA_INVALID", `${path} must be finite.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new HttpError(400, "AUDIT_METADATA_INVALID", `${path} is not JSON-safe.`);
  }
  if (seen.has(value)) {
    throw new HttpError(400, "AUDIT_METADATA_INVALID", "Audit metadata cannot be circular.");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 1_000) {
      throw new HttpError(400, "AUDIT_METADATA_INVALID", `${path} contains too many items.`);
    }
    value.forEach((item, index) =>
      validateAuditMetadata(item, `${path}[${index}]`, depth + 1, seen),
    );
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new HttpError(400, "AUDIT_METADATA_INVALID", `${path} must be a plain object.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || key.length > 128) {
      throw new HttpError(400, "AUDIT_METADATA_INVALID", `${path} has an invalid key.`);
    }
    if (SENSITIVE_AUDIT_KEY.test(key)) {
      throw new HttpError(
        400,
        "AUDIT_METADATA_SENSITIVE",
        "Sensitive values cannot be written to the audit log.",
      );
    }
    validateAuditMetadata(item, `${path}.${key}`, depth + 1, seen);
  }
}

function validAuditText(
  value: unknown,
  maximumLength: number,
  options: { optional?: boolean; pattern?: RegExp } = {},
): boolean {
  if (value === undefined && options.optional) return true;
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength &&
    !value.includes("\0") &&
    (!options.pattern || options.pattern.test(value))
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isAuditSequenceConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("audit sequence mismatch") ||
    message.includes("audit previous hash mismatch") ||
    message.includes("audit head advance failed") ||
    message.includes("uq_audit_events_workspace_sequence") ||
    message.includes("audit_events.workspace_id, audit_events.sequence") ||
    message.includes("UNIQUE constraint failed: audit_events")
  );
}

export class D1KnowHowRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async ensureSecurityGuards(): Promise<void> {
    for (const statement of securityTriggerStatements) {
      const result = await this.db.prepare(statement).run();
      if (!result.success) {
        throw new HttpError(
          500,
          "AUDIT_GUARD_SETUP_FAILED",
          "The audit security boundary could not be initialized.",
          { expose: false },
        );
      }
    }
  }

  async isPlatformAdministrator(userId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT user_id FROM platform_admins WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first<{ user_id: string }>();
    return row !== null;
  }

  async listWorkspaceAccess(userId: string): Promise<WorkspaceAccess[]> {
    const [accessRows, groupRows, supportRows] = await Promise.all([
      allRows<WorkspaceAccessRow>(
        this.db
          .prepare(
            `SELECT
               w.id AS workspace_id,
               w.name AS workspace_name,
               w.slug AS workspace_slug,
               w.entity_id,
               w.status AS workspace_status,
               wm.status AS membership_status,
               wmr.role,
               wmc.capability
             FROM workspace_members wm
             JOIN workspaces w ON w.id = wm.workspace_id
             LEFT JOIN workspace_member_roles wmr
               ON wmr.workspace_id = wm.workspace_id AND wmr.user_id = wm.user_id
             LEFT JOIN workspace_member_capabilities wmc
               ON wmc.workspace_id = wm.workspace_id AND wmc.user_id = wm.user_id
             WHERE wm.user_id = ?
             ORDER BY w.name, w.id`,
          )
          .bind(userId),
      ),
      allRows<WorkspaceGroupRow>(
        this.db
          .prepare(
            `SELECT g.workspace_id, g.id AS group_id
             FROM groups g
             JOIN group_members gm
               ON gm.group_id = g.id AND gm.workspace_id = g.workspace_id
             WHERE gm.user_id = ?
             UNION
             SELECT g.workspace_id, g.id AS group_id
             FROM groups g
             JOIN workspace_members wm ON wm.workspace_id = g.workspace_id
             WHERE g.kind = 'all_members' AND wm.user_id = ? AND wm.status = 'active'`,
          )
          .bind(userId, userId),
      ),
      allRows<SupportGrantRow>(
        this.db
          .prepare(
            `SELECT
               g.id AS grant_id,
               w.id AS workspace_id,
               w.name AS workspace_name,
               w.slug AS workspace_slug,
               w.entity_id,
               w.status AS workspace_status,
               g.role,
               g.expires_at
             FROM support_access_grants g
             JOIN workspaces w ON w.id = g.workspace_id
             WHERE g.user_id = ?
               AND g.status = 'active'
               AND unixepoch(g.expires_at) > unixepoch('now')
             ORDER BY w.name, w.id`,
          )
          .bind(userId),
      ),
    ]);

    const groupsByWorkspace = new Map<string, Set<string>>();
    for (const row of groupRows) {
      const current = groupsByWorkspace.get(row.workspace_id) ?? new Set<string>();
      current.add(row.group_id);
      groupsByWorkspace.set(row.workspace_id, current);
    }

    const accessByWorkspace = new Map<
      string,
      Omit<WorkspaceAccess, "roles" | "capabilities" | "groupIds"> & {
        roles: Set<WorkspaceRole>;
        capabilities: Set<"vault">;
      }
    >();
    for (const row of accessRows) {
      const current = accessByWorkspace.get(row.workspace_id) ?? {
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        workspaceSlug: row.workspace_slug,
        entityId: row.entity_id,
        workspaceStatus: row.workspace_status,
        membershipStatus: row.membership_status,
        roles: new Set<WorkspaceRole>(),
        capabilities: new Set<"vault">(),
      };
      if (row.role) current.roles.add(row.role);
      if (row.capability) current.capabilities.add(row.capability);
      accessByWorkspace.set(row.workspace_id, current);
    }

    const memberships = [...accessByWorkspace.values()].map((access) => ({
      ...access,
      roles: [...access.roles],
      capabilities: [...access.capabilities],
      groupIds: [...(groupsByWorkspace.get(access.workspaceId) ?? [])],
    }));

    // A real membership always takes precedence over a support grant for the
    // same workspace; grants only open workspaces the actor is not a member of.
    const memberWorkspaceIds = new Set(memberships.map((access) => access.workspaceId));
    const grants = supportRows
      .filter((grant) => !memberWorkspaceIds.has(grant.workspace_id))
      .map(
        (grant): WorkspaceAccess => ({
          workspaceId: grant.workspace_id,
          workspaceName: grant.workspace_name,
          workspaceSlug: grant.workspace_slug,
          entityId: grant.entity_id,
          workspaceStatus: grant.workspace_status,
          membershipStatus: "active",
          roles: [grant.role],
          capabilities: [],
          groupIds: [],
          supportGrant: {
            grantId: grant.grant_id,
            role: grant.role,
            expiresAt: grant.expires_at,
          },
        }),
      );

    return [...memberships, ...grants];
  }

  async getWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceAccess | null> {
    const access = await this.listWorkspaceAccess(userId);
    return access.find((item) => item.workspaceId === workspaceId) ?? null;
  }

  async getGuideAccessFacts(
    workspaceId: string,
    guideId: string,
    userId: string,
    revisionId?: string,
  ): Promise<GuideAccessFacts | null> {
    const [guide, workspaceAccess] = await Promise.all([
      this.db
        .prepare(
          `SELECT
             g.id,
             g.workspace_id,
             g.author_user_id,
             g.current_published_revision_id,
             g.working_draft_revision_id,
             COALESCE(ws.restricted_exports_enabled, 0) AS restricted_exports_enabled
           FROM guides g
           LEFT JOIN workspace_settings ws ON ws.workspace_id = g.workspace_id
           WHERE g.id = ? AND g.workspace_id = ? AND g.archived_at IS NULL
           LIMIT 1`,
        )
        .bind(guideId, workspaceId)
        .first<GuideRow>(),
      this.getWorkspaceAccess(workspaceId, userId),
    ]);
    if (!guide || !workspaceAccess) return null;

    const selectedRevisionId =
      revisionId ?? guide.current_published_revision_id ?? guide.working_draft_revision_id;
    if (!selectedRevisionId) return null;

    const revision = await this.db
      .prepare(
        `SELECT id, status, source_type, privacy_reviewed_at
         FROM guide_revisions
         WHERE id = ? AND guide_id = ? AND workspace_id = ?
         LIMIT 1`,
      )
      .bind(selectedRevisionId, guideId, workspaceId)
      .first<RevisionRow>();
    if (!revision) return null;

    const groupPredicate =
      " OR (subject_type = 'group' AND subject_id IN (SELECT value FROM json_each(?)))";
    const [reviewer, reviewSummary, audience] = await Promise.all([
      this.db
        .prepare(
          "SELECT 1 AS matched FROM review_assignments WHERE revision_id = ? AND reviewer_user_id = ? LIMIT 1",
        )
        .bind(revision.id, userId)
        .first<{ matched: number }>(),
      this.db
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
             SUM(CASE WHEN status != 'approved' THEN 1 ELSE 0 END) AS blocking_count
           FROM review_assignments
           WHERE revision_id = ?`,
        )
        .bind(revision.id)
        .first<ReviewSummaryRow>(),
      this.db
        .prepare(
          `SELECT subject_type
           FROM guide_audiences
           WHERE revision_id = ?
             AND (
               (subject_type = 'workspace' AND subject_id = ?)
               OR (subject_type = 'user' AND subject_id = ?)
               ${groupPredicate}
             )
           ORDER BY CASE subject_type WHEN 'workspace' THEN 0 WHEN 'user' THEN 1 ELSE 2 END
           LIMIT 1`,
        )
        .bind(revision.id, workspaceId, userId, JSON.stringify(workspaceAccess.groupIds))
        .first<{ subject_type: "workspace" | "group" | "user" }>(),
    ]);

    const isRestricted = audience?.subject_type !== "workspace";
    return {
      guideId: guide.id,
      workspaceId: guide.workspace_id,
      revisionId: revision.id,
      revisionStatus: revision.status,
      sourceType: revision.source_type,
      isAuthor: guide.author_user_id === userId,
      isAssignedReviewer: reviewer !== null,
      isAudienceMember: audience !== null,
      exportAllowed: !isRestricted || guide.restricted_exports_enabled === 1,
      privacyReviewed: revision.privacy_reviewed_at !== null,
      reviewApproved:
        (reviewSummary?.approved_count ?? 0) > 0 &&
        (reviewSummary?.blocking_count ?? 0) === 0,
    };
  }

  async getInvitationByJti(jti: string): Promise<InvitationState | null> {
    const row = await this.db
      .prepare(
        `SELECT id, workspace_id, token_hash, email, role, status,
                max_uses, use_count, expires_at, created_via
         FROM invitations WHERE id = ? LIMIT 1`,
      )
      .bind(jti)
      .first<{
        id: string;
        workspace_id: string;
        token_hash: string;
        email: string | null;
        role: InvitationState["role"];
        status: InvitationState["status"];
        max_uses: number;
        use_count: number;
        expires_at: string;
        created_via: InvitationState["createdVia"];
      }>();
    return row
      ? {
          id: row.id,
          workspaceId: row.workspace_id,
          tokenHash: row.token_hash,
          email: row.email,
          role: row.role,
          status: row.status,
          maxUses: row.max_uses,
          useCount: row.use_count,
          expiresAt: row.expires_at,
          createdVia: row.created_via,
        }
      : null;
  }

  async getDeviceTokenByJti(jti: string): Promise<DeviceTokenState | null> {
    const row = await this.db
      .prepare(
        `SELECT id, workspace_id, user_id, device_id, token_hash, scopes_json,
                expires_at, revoked_at
         FROM device_tokens WHERE id = ? LIMIT 1`,
      )
      .bind(jti)
      .first<{
        id: string;
        workspace_id: string;
        user_id: string;
        device_id: string;
        token_hash: string;
        scopes_json: string;
        expires_at: string;
        revoked_at: string | null;
      }>();
    return row
      ? {
          id: row.id,
          workspaceId: row.workspace_id,
          userId: row.user_id,
          deviceId: row.device_id,
          tokenHash: row.token_hash,
          scopes: parseJsonArray(row.scopes_json),
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
        }
      : null;
  }

  async validateInvitationCredential(
    token: string,
    signingSecret?: string,
  ): Promise<ValidatedInvitationCredential> {
    const claims = await verifyInviteToken(token, signingSecret);
    const [invitation, presentedHash] = await Promise.all([
      this.getInvitationByJti(claims.jti),
      hashToken(token),
    ]);
    const databaseExpiry = invitation ? expirationSeconds(invitation.expiresAt) : null;
    const matches =
      invitation !== null &&
      constantTimeEqual(invitation.tokenHash, presentedHash) &&
      invitation.workspaceId === claims.workspaceId &&
      invitation.role === claims.role &&
      normalizedOptionalEmail(invitation.email) === normalizedOptionalEmail(claims.email) &&
      invitation.status === "active" &&
      invitation.useCount < invitation.maxUses &&
      databaseExpiry !== null &&
      databaseExpiry === claims.expiresAt &&
      databaseExpiry > Math.floor(Date.now() / 1000);
    if (!matches || !invitation) {
      throw new HttpError(401, "INVITATION_INVALID", "The invitation is invalid or no longer active.");
    }
    return { claims, invitation };
  }

  async validateDeviceCredential(
    token: string,
    signingSecret?: string,
  ): Promise<ValidatedDeviceCredential> {
    const claims = await verifyDeviceToken(token, signingSecret);
    const [deviceToken, presentedHash] = await Promise.all([
      this.getDeviceTokenByJti(claims.jti),
      hashToken(token),
    ]);
    const databaseExpiry = deviceToken ? expirationSeconds(deviceToken.expiresAt) : null;
    const matches =
      deviceToken !== null &&
      constantTimeEqual(deviceToken.tokenHash, presentedHash) &&
      deviceToken.workspaceId === claims.workspaceId &&
      deviceToken.userId === claims.userId &&
      deviceToken.deviceId === claims.deviceId &&
      sameStringSet(deviceToken.scopes, claims.scopes) &&
      deviceToken.revokedAt === null &&
      databaseExpiry !== null &&
      databaseExpiry === claims.expiresAt &&
      databaseExpiry > Math.floor(Date.now() / 1000);
    if (!matches || !deviceToken) {
      throw new HttpError(401, "DEVICE_TOKEN_INVALID", "The device token is invalid or revoked.");
    }
    return { claims, deviceToken };
  }

  async findDomainEligibleWorkspaceIds(email: string): Promise<string[]> {
    const domain = extractExactEmailDomain(email);
    if (!domain) return [];
    const rows = await allRows<{ workspace_id: string }>(
      this.db
        .prepare(
          `SELECT wd.workspace_id
           FROM workspace_domains wd
           JOIN workspaces w ON w.id = wd.workspace_id
           WHERE wd.domain_ascii = ? AND wd.enabled = 1 AND w.status = 'active'`,
        )
        .bind(domain),
    );
    return rows.map((row) => row.workspace_id);
  }

  async getPlatformSetting<T = unknown>(key: string): Promise<T | null> {
    const row = await this.db
      .prepare("SELECT value_json FROM platform_settings WHERE key = ? LIMIT 1")
      .bind(key)
      .first<{ value_json: string }>();
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  async getActiveSupportGrant(
    workspaceId: string,
    userId: string,
  ): Promise<SupportGrantState | null> {
    const row = await this.db
      .prepare(
        `SELECT id, request_id, workspace_id, user_id, email, display_name, role,
                status, approved_by, granted_at, expires_at, ended_at, revoked_by
         FROM support_access_grants
         WHERE workspace_id = ? AND user_id = ? AND status = 'active'
           AND unixepoch(expires_at) > unixepoch('now')
         LIMIT 1`,
      )
      .bind(workspaceId, userId)
      .first<SupportGrantState>();
    return row ?? null;
  }

  async hasActiveSupportGrant(userId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS matched FROM support_access_grants
         WHERE user_id = ? AND status = 'active'
           AND unixepoch(expires_at) > unixepoch('now')
         LIMIT 1`,
      )
      .bind(userId)
      .first<{ matched: number }>();
    return row !== null;
  }

  async listPendingSupportRequests(
    workspaceId: string,
  ): Promise<SupportRequestState[]> {
    return allRows<SupportRequestState>(
      this.db
        .prepare(
          `SELECT id, workspace_id, requester_user_id, requester_email,
                  requester_name, requested_role, reason, requested_duration_hours,
                  status, decided_by, decided_at, granted_role, grant_id, created_at
           FROM support_access_requests
           WHERE workspace_id = ? AND status = 'pending'
           ORDER BY created_at`,
        )
        .bind(workspaceId),
    );
  }

  async listActiveSupportGrants(
    workspaceId: string,
  ): Promise<SupportGrantState[]> {
    return allRows<SupportGrantState>(
      this.db
        .prepare(
          `SELECT id, request_id, workspace_id, user_id, email, display_name, role,
                  status, approved_by, granted_at, expires_at, ended_at, revoked_by
           FROM support_access_grants
           WHERE workspace_id = ? AND status = 'active'
           ORDER BY granted_at`,
        )
        .bind(workspaceId),
    );
  }

  async listAppointments(workspaceId: string): Promise<AppointmentState[]> {
    return allRows<AppointmentState>(
      this.db
        .prepare(
          `SELECT id, workspace_id, token_hash, email, status, expires_at
           FROM admin_appointments
           WHERE workspace_id = ? AND status = 'active'
           ORDER BY created_at`,
        )
        .bind(workspaceId),
    );
  }

  async getAppointmentByJti(jti: string): Promise<AppointmentState | null> {
    const row = await this.db
      .prepare(
        `SELECT id, workspace_id, token_hash, email, status, expires_at
         FROM admin_appointments WHERE id = ? LIMIT 1`,
      )
      .bind(jti)
      .first<AppointmentState>();
    return row ?? null;
  }

  async validateAppointmentCredential(
    token: string,
    signingSecret?: string,
  ): Promise<{ claims: AppointmentTokenClaims; appointment: AppointmentState }> {
    const claims = await verifyAppointmentToken(token, signingSecret);
    const [appointment, presentedHash] = await Promise.all([
      this.getAppointmentByJti(claims.jti),
      hashToken(token),
    ]);
    const databaseExpiry = appointment ? expirationSeconds(appointment.expiresAt) : null;
    const matches =
      appointment !== null &&
      constantTimeEqual(appointment.tokenHash, presentedHash) &&
      appointment.workspaceId === claims.workspaceId &&
      normalizedOptionalEmail(appointment.email) === claims.email &&
      appointment.status === "active" &&
      databaseExpiry !== null &&
      databaseExpiry === claims.expiresAt &&
      databaseExpiry > Math.floor(Date.now() / 1000);
    if (!matches || !appointment) {
      throw new HttpError(401, "APPOINTMENT_INVALID", "The administrator appointment is invalid or no longer active.");
    }
    return { claims, appointment };
  }

  async expireSupportGrants(): Promise<SupportGrantState[]> {
    const expired = await allRows<SupportGrantState>(
      this.db
        .prepare(
          `SELECT id, request_id, workspace_id, user_id, email, display_name, role,
                  status, approved_by, granted_at, expires_at, ended_at, revoked_by
           FROM support_access_grants
           WHERE status = 'active' AND unixepoch(expires_at) <= unixepoch('now')`,
        ),
    );
    if (expired.length === 0) return [];
    const result = await this.db
      .prepare(
        `UPDATE support_access_grants
         SET status = 'expired', ended_at = expires_at
         WHERE status = 'active' AND unixepoch(expires_at) <= unixepoch('now')`,
      )
      .run();
    if (!result.success) {
      throw new HttpError(500, "SUPPORT_GRANT_SWEEP_FAILED", "Expired support grants could not be closed.", {
        expose: false,
      });
    }
    return expired;
  }

  async setPlatformSetting(
    key: string,
    value: unknown,
    updatedBy: string,
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `INSERT INTO platform_settings (key, value_json, updated_by, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_by = excluded.updated_by,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(key, JSON.stringify(value), updatedBy)
      .run();
    if (!result.success) {
      throw new HttpError(500, "PLATFORM_SETTING_FAILED", "The platform setting could not be saved.", {
        expose: false,
      });
    }
  }

  async executeAuditedMutation(
    input: AuditedMutationInput,
  ): Promise<AuditReceipt> {
    if (
      !validAuditText(input.workspaceId, 128, { pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ }) ||
      !validAuditText(input.actor.userId, 128) ||
      !validAuditText(input.actor.email, 320, { optional: true }) ||
      !validAuditText(input.actor.name, 256, { optional: true }) ||
      !validAuditText(input.event.action, 128, { pattern: /^[a-z0-9][a-z0-9._-]*$/ }) ||
      !validAuditText(input.event.targetType, 128, { pattern: /^[a-z0-9][a-z0-9._-]*$/ }) ||
      !validAuditText(input.event.targetId, 256, { optional: true }) ||
      !validAuditText(input.event.targetLabel, 512, { optional: true }) ||
      !validAuditText(input.event.summary, 1_000)
    ) {
      throw new HttpError(400, "AUDIT_EVENT_INVALID", "Audit event context is incomplete.");
    }
    const metadata = input.event.metadata ?? {};
    validateAuditMetadata(metadata);
    const metadataJson = canonicalJson(metadata);
    if (new TextEncoder().encode(metadataJson).byteLength > MAX_AUDIT_METADATA_BYTES) {
      throw new HttpError(400, "AUDIT_METADATA_TOO_LARGE", "Audit metadata is too large.");
    }

    const initialized = await this.db
      .prepare(
        `INSERT OR IGNORE INTO audit_heads
           (workspace_id, last_sequence, last_hash, updated_at)
         VALUES (?, 0, '', CURRENT_TIMESTAMP)`,
      )
      .bind(input.workspaceId)
      .run();
    if (!initialized.success) {
      throw new HttpError(500, "AUDIT_HEAD_INIT_FAILED", "The audit ledger is unavailable.", {
        expose: false,
      });
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const head = await this.db
        .prepare(
          "SELECT last_sequence, last_hash FROM audit_heads WHERE workspace_id = ? LIMIT 1",
        )
        .bind(input.workspaceId)
        .first<AuditHeadRow>();
      if (!head) {
        throw new HttpError(500, "AUDIT_HEAD_MISSING", "The audit ledger is unavailable.", {
          expose: false,
        });
      }

      const sequence = head.last_sequence + 1;
      const previousHash = head.last_hash || ZERO_HASH;
      const eventId = crypto.randomUUID();
      const occurredAt = new Date().toISOString();
      const hashDocument = canonicalJson({
        eventId,
        workspaceId: input.workspaceId,
        sequence,
        previousHash,
        actor: input.actor,
        action: input.event.action,
        targetType: input.event.targetType,
        targetId: input.event.targetId ?? null,
        targetLabel: input.event.targetLabel ?? null,
        summary: input.event.summary,
        metadata,
        occurredAt,
      });
      const eventHash = await sha256(hashDocument);
      const insertEvent = this.db
        .prepare(
          `INSERT INTO audit_events
             (id, workspace_id, sequence, previous_hash, event_hash,
              actor_user_id, actor_email, actor_name, action, target_type,
              target_id, target_label, summary, metadata_json, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          eventId,
          input.workspaceId,
          sequence,
          previousHash,
          eventHash,
          input.actor.userId,
          input.actor.email ?? null,
          input.actor.name ?? null,
          input.event.action,
          input.event.targetType,
          input.event.targetId ?? null,
          input.event.targetLabel ?? null,
          input.event.summary,
          metadataJson,
          occurredAt,
        );
      try {
        const results = await this.db.batch([
          ...input.statements,
          insertEvent,
        ]);
        if (results.some((result) => !result.success)) {
          throw new Error("D1 audited mutation batch failed");
        }
        return { eventId, sequence, previousHash, eventHash, occurredAt };
      } catch (error) {
        if (attempt < 2 && isAuditSequenceConflict(error)) continue;
        throw new HttpError(
          409,
          isAuditSequenceConflict(error)
            ? "AUDIT_CONCURRENCY_CONFLICT"
            : "AUDITED_MUTATION_FAILED",
          "The change could not be recorded safely. Retry the request.",
          { cause: error },
        );
      }
    }

    throw new HttpError(409, "AUDIT_CONCURRENCY_CONFLICT", "Retry the request.");
  }
}
