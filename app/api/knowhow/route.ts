import { env } from "cloudflare:workers";
import {
  allRows,
  assertMutationRequest,
  authorize,
  clonePrivateMedia,
  deletePrivateMedia,
  D1KnowHowRepository,
  evaluateGuideVisibility,
  extractExactEmailDomain,
  hashToken,
  HttpError,
  jsonResponse,
  readJsonObject,
  requireAuthorized,
  requireD1Binding,
  requireR2Binding,
  requireVerifiedIdentity,
  signAppointmentToken,
  signInviteToken,
  toErrorResponse,
  type AuthenticatedIdentity,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type GuideAccessFacts,
  type RevisionAudienceRow,
  type RevisionMediaRow,
  type RevisionReviewRow,
  type RevisionRow,
  type RevisionStepRow,
  type SupportGrantState,
  type WorkspaceAccess,
} from "../../../lib/server";
import type {
  AdminAppointment,
  Audience,
  AuditEvent,
  BootstrapResponse,
  EditorBlock,
  Guide,
  Invitation,
  JoinRequest,
  PlatformMetrics,
  PlatformWorkspace,
  SupportAccessGrant,
  SupportAccessRequest,
  VaultItem,
  WorkspaceBundle,
  WorkspaceGroup,
  WorkspaceMember,
  WorkspaceMetrics,
  WorkspaceRole,
  WorkspaceSettings,
  WorkspaceStatus,
  WorkspaceSummary,
} from "../../../lib/knowhow-types";
import type {
  GuideActor,
  GuideAudience,
  GuideBlock,
  GuideRevision,
  WorkspaceBranding,
} from "../../../lib/guide-contracts";
import { parseGuideRevision } from "../../../lib/guide-contracts";

export const runtime = "edge";
export const dynamic = "force-dynamic";

let initializedBinding: D1DatabaseLike | null = null;

function requestId() {
  return crypto.randomUUID();
}

function dbBinding() {
  return requireD1Binding(env.DB);
}

async function repositoryFor(db: D1DatabaseLike) {
  const repository = new D1KnowHowRepository(db);
  if (initializedBinding !== db) {
    await repository.ensureSecurityGuards();
    initializedBinding = db;
  }
  return repository;
}

function signingKey() {
  return env.KNOWHOW_TOKEN_SIGNING_KEY;
}

function statement(
  db: D1DatabaseLike,
  sql: string,
  ...values: unknown[]
): D1PreparedStatementLike {
  return db.prepare(sql).bind(...values);
}

async function rows<T>(
  db: D1DatabaseLike,
  sql: string,
  ...values: unknown[]
): Promise<T[]> {
  return allRows<T>(statement(db, sql, ...values));
}

async function first<T>(
  db: D1DatabaseLike,
  sql: string,
  ...values: unknown[]
): Promise<T | null> {
  return statement(db, sql, ...values).first<T>();
}

async function run(
  db: D1DatabaseLike,
  sql: string,
  ...values: unknown[]
) {
  const result = await statement(db, sql, ...values).run();
  if (!result.success) {
    throw new HttpError(500, "DATABASE_MUTATION_FAILED", "The change could not be saved.", {
      expose: false,
    });
  }
  return result;
}

function asObject(value: unknown, label = "payload"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_PAYLOAD", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function textValue(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; optional?: boolean } = {},
) {
  if (value === undefined && options.optional) return "";
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_PAYLOAD", `${label} must be text.`);
  }
  const result = value.trim();
  if (result.length < (options.min ?? 0) || result.length > (options.max ?? 500)) {
    throw new HttpError(400, "INVALID_PAYLOAD", `${label} has an invalid length.`);
  }
  return result;
}

function integerValue(
  value: unknown,
  label: string,
  min: number,
  max: number,
) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new HttpError(400, "INVALID_PAYLOAD", `${label} is invalid.`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string) {
  if (typeof value !== "boolean") {
    throw new HttpError(400, "INVALID_PAYLOAD", `${label} must be true or false.`);
  }
  return value;
}

function stringList(value: unknown, label: string, maxItems = 100) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HttpError(400, "INVALID_PAYLOAD", `${label} must be a list.`);
  }
  return [...new Set(value.map((item) => textValue(item, label, { max: 500 })).filter(Boolean))];
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function decodedBase64Length(value: string, label: string) {
  if (
    value.length === 0 ||
    value.length > 131_072 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new HttpError(400, "VAULT_ENVELOPE_INVALID", `${label} is invalid.`);
  }
  try {
    return atob(value).length;
  } catch {
    throw new HttpError(400, "VAULT_ENVELOPE_INVALID", `${label} is invalid.`);
  }
}

function validateVaultEnvelopeJson(value: unknown) {
  const source = textValue(value, "Encrypted envelope", { min: 20, max: 131_072 });
  if (new TextEncoder().encode(source).byteLength > 131_072) {
    throw new HttpError(413, "VAULT_ENVELOPE_TOO_LARGE", "The encrypted envelope is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new HttpError(400, "VAULT_ENVELOPE_INVALID", "The encrypted envelope is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "VAULT_ENVELOPE_INVALID", "The encrypted envelope is invalid.");
  }
  const envelope = parsed as Record<string, unknown>;
  const allowedKeys = new Set([
    "version",
    "algorithm",
    "keyDerivation",
    "iterations",
    "salt",
    "iv",
    "ciphertext",
  ]);
  if (
    Object.keys(envelope).length !== allowedKeys.size ||
    Object.keys(envelope).some((key) => !allowedKeys.has(key)) ||
    envelope.version !== 1 ||
    envelope.algorithm !== "AES-GCM" ||
    envelope.keyDerivation !== "PBKDF2-SHA-256" ||
    !Number.isSafeInteger(envelope.iterations) ||
    (envelope.iterations as number) < 210_000 ||
    (envelope.iterations as number) > 2_000_000 ||
    typeof envelope.salt !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new HttpError(400, "VAULT_ENVELOPE_INVALID", "The encrypted envelope is invalid.");
  }
  const saltBytes = decodedBase64Length(envelope.salt, "Envelope salt");
  const ivBytes = decodedBase64Length(envelope.iv, "Envelope IV");
  const ciphertextBytes = decodedBase64Length(envelope.ciphertext, "Envelope ciphertext");
  if (saltBytes < 16 || saltBytes > 64 || ivBytes !== 12 || ciphertextBytes < 16 || ciphertextBytes > 96 * 1024) {
    throw new HttpError(400, "VAULT_ENVELOPE_INVALID", "The encrypted envelope is invalid.");
  }
  return JSON.stringify(envelope);
}

function validateVaultMetadataJson(value: unknown) {
  const source = textValue(value ?? "{}", "Vault metadata", { min: 2, max: 16_384 });
  if (new TextEncoder().encode(source).byteLength > 16_384) {
    throw new HttpError(413, "VAULT_METADATA_TOO_LARGE", "Vault metadata is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new HttpError(400, "VAULT_METADATA_INVALID", "Vault metadata is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "VAULT_METADATA_INVALID", "Vault metadata is invalid.");
  }
  const metadata = parsed as Record<string, unknown>;
  const allowedKeys = new Set(["username", "url", "notes"]);
  if (
    Object.keys(metadata).some((key) => !allowedKeys.has(key)) ||
    Object.values(metadata).some((item) => typeof item !== "string")
  ) {
    throw new HttpError(400, "VAULT_METADATA_INVALID", "Vault metadata is invalid.");
  }
  const username = String(metadata.username ?? "").trim();
  const url = String(metadata.url ?? "").trim();
  const notes = String(metadata.notes ?? "").trim();
  if (username.length > 320 || url.length > 2_000 || notes.length > 5_000) {
    throw new HttpError(400, "VAULT_METADATA_INVALID", "Vault metadata is invalid.");
  }
  if (url) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new HttpError(400, "VAULT_METADATA_INVALID", "The vault sign-in URL is invalid.");
    }
    if (
      (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      throw new HttpError(400, "VAULT_METADATA_INVALID", "The vault sign-in URL is invalid.");
    }
  }
  return JSON.stringify({ username, url, notes });
}

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 52) || "workspace"
  );
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function actor(identity: AuthenticatedIdentity) {
  return { userId: identity.userId, email: identity.email, name: identity.name };
}

function platformOwnerEmails() {
  return new Set(
    (env.KNOWHOW_PLATFORM_OWNER_EMAILS ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function platformAdministrator(
  db: D1DatabaseLike,
  repository: D1KnowHowRepository,
  identity: AuthenticatedIdentity,
) {
  const configured =
    platformOwnerEmails().has(identity.email) || identity.labels.includes("platform-administrator");
  if (configured) {
    await run(
      db,
      `INSERT OR IGNORE INTO platform_admins (user_id, created_by, created_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      identity.userId,
      identity.userId,
    );
  }
  return configured || repository.isPlatformAdministrator(identity.userId);
}

function policyContext(
  access: WorkspaceAccess,
  isPlatformAdministrator: boolean,
  guide?: GuideAccessFacts,
) {
  return {
    isVerifiedIdentity: true,
    isPlatformAdministrator,
    membershipStatus: access.membershipStatus,
    workspaceStatus: access.workspaceStatus,
    roles: access.roles,
    capabilities: access.capabilities,
    guide,
    supportGrant: access.supportGrant,
  } as const;
}

async function requireWorkspace(
  repository: D1KnowHowRepository,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  isPlatformAdministrator: boolean,
) {
  const access = await repository.getWorkspaceAccess(workspaceId, identity.userId);
  if (!access) throw new HttpError(403, "WORKSPACE_ACCESS_REQUIRED", "You do not belong to this workspace.");
  requireAuthorized("workspace.read", policyContext(access, isPlatformAdministrator));
  return access;
}

async function audit(
  repository: D1KnowHowRepository,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  event: {
    action: string;
    targetType: string;
    targetId?: string;
    targetLabel?: string;
    summary: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
  statements: D1PreparedStatementLike[] = [],
) {
  return repository.executeAuditedMutation({
    workspaceId,
    actor: actor(identity),
    event,
    statements,
  });
}

const DEFAULT_SETTINGS: WorkspaceSettings = {
  logoUrl: null,
  accentColor: "#356fe5",
  clickTargetColor: "#ef6f47",
  removeBranding: false,
  allowedDomains: [],
  excludedCaptureHosts: [],
  allowRestrictedExports: false,
  watermarkExports: true,
};

type SupportRequestRow = {
  id: string;
  workspace_id: string;
  requester_user_id: string;
  requester_email: string;
  requester_name: string;
  requested_role: WorkspaceRole;
  requested_duration_hours: number;
  status: string;
};

type SupportGrantRow = {
  id: string;
  user_id: string;
  email: string;
  status: string;
  workspace_id: string;
};

async function loadSettings(db: D1DatabaseLike, workspaceId: string): Promise<WorkspaceSettings> {
  const [setting, domainRows] = await Promise.all([
    first<{
      logo_object_key: string | null;
      accent_color: string;
      click_target_color: string;
      remove_branding: number;
      restricted_exports_enabled: number;
      watermark_restricted_exports: number;
      capture_policy_json: string;
    }>(
      db,
      `SELECT logo_object_key, accent_color, click_target_color, remove_branding,
              restricted_exports_enabled, watermark_restricted_exports, capture_policy_json
       FROM workspace_settings WHERE workspace_id = ?`,
      workspaceId,
    ),
    rows<{ domain_ascii: string }>(
      db,
      `SELECT domain_ascii FROM workspace_domains
       WHERE workspace_id = ? AND enabled = 1 ORDER BY domain_ascii`,
      workspaceId,
    ),
  ]);
  if (!setting) return DEFAULT_SETTINGS;
  const capture = safeJson<{ excludedHosts?: string[] }>(setting.capture_policy_json, {});
  return {
    logoUrl: setting.logo_object_key,
    accentColor: setting.accent_color,
    clickTargetColor: setting.click_target_color,
    removeBranding: setting.remove_branding === 1,
    allowedDomains: domainRows.map((item) => item.domain_ascii),
    excludedCaptureHosts: Array.isArray(capture.excludedHosts)
      ? capture.excludedHosts.filter((item): item is string => typeof item === "string")
      : [],
    allowRestrictedExports: setting.restricted_exports_enabled === 1,
    watermarkExports: setting.watermark_restricted_exports === 1,
  };
}

async function loadWorkspaceSummaries(
  db: D1DatabaseLike,
  accesses: WorkspaceAccess[],
): Promise<WorkspaceSummary[]> {
  if (accesses.length === 0) return [];
  const countRows = await rows<{
    id: string;
    member_count: number;
    published_count: number;
    draft_count: number;
    created_at: string;
  }>(
    db,
    `SELECT w.id,
       (SELECT COUNT(*) FROM workspace_members wm
        WHERE wm.workspace_id = w.id AND wm.status = 'active') AS member_count,
       (SELECT COUNT(*) FROM guides g
        WHERE g.workspace_id = w.id AND g.current_published_revision_id IS NOT NULL
          AND g.archived_at IS NULL) AS published_count,
       (SELECT COUNT(*) FROM guides g
        WHERE g.workspace_id = w.id AND g.working_draft_revision_id IS NOT NULL
          AND g.archived_at IS NULL) AS draft_count,
       w.created_at
     FROM workspaces w
     WHERE w.id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(accesses.map((access) => access.workspaceId)),
  );
  const countsByWorkspace = new Map(countRows.map((item) => [item.id, item]));
  return accesses.map((access) => {
    const mayReadWorkspaceData =
      access.membershipStatus === "active" && access.workspaceStatus === "active";
    const counts = countsByWorkspace.get(access.workspaceId);
    return {
      id: access.workspaceId,
      name: access.workspaceName,
      slug: access.workspaceSlug,
      status: access.workspaceStatus,
      roles: [...access.roles],
      memberCount: mayReadWorkspaceData ? Number(counts?.member_count ?? 0) : 0,
      publishedCount: mayReadWorkspaceData ? Number(counts?.published_count ?? 0) : 0,
      draftCount: mayReadWorkspaceData ? Number(counts?.draft_count ?? 0) : 0,
      createdAt: counts?.created_at ?? "",
    };
  });
}

async function loadMembers(db: D1DatabaseLike, workspaceId: string): Promise<WorkspaceMember[]> {
  const [memberRows, roleRows, capabilityRows, groupRows] = await Promise.all([
    rows<{
      workspace_id: string;
      user_id: string;
      email: string;
      display_name: string | null;
      status: "active" | "suspended";
      joined_at: string;
    }>(
      db,
      `SELECT workspace_id, user_id, email, display_name, status, joined_at
       FROM workspace_members WHERE workspace_id = ? ORDER BY COALESCE(display_name, email)`,
      workspaceId,
    ),
    rows<{ user_id: string; role: WorkspaceRole }>(
      db,
      `SELECT user_id, role FROM workspace_member_roles WHERE workspace_id = ?`,
      workspaceId,
    ),
    rows<{ user_id: string; capability: "vault" }>(
      db,
      `SELECT user_id, capability FROM workspace_member_capabilities WHERE workspace_id = ?`,
      workspaceId,
    ),
    rows<{ user_id: string; group_id: string }>(
      db,
      `SELECT gm.user_id, gm.group_id FROM group_members gm
       JOIN groups g ON g.id = gm.group_id AND g.workspace_id = gm.workspace_id
       WHERE gm.workspace_id = ?`,
      workspaceId,
    ),
  ]);
  return memberRows.map((member) => ({
    id: `${member.workspace_id}:${member.user_id}`,
    userId: member.user_id,
    email: member.email,
    name: member.display_name ?? member.email,
    status: member.status,
    roles: roleRows.filter((item) => item.user_id === member.user_id).map((item) => item.role),
    capabilities: capabilityRows
      .filter((item) => item.user_id === member.user_id)
      .map((item) => item.capability),
    groupIds: groupRows.filter((item) => item.user_id === member.user_id).map((item) => item.group_id),
    joinedAt: member.joined_at,
  }));
}

async function loadGroups(db: D1DatabaseLike, workspaceId: string): Promise<WorkspaceGroup[]> {
  const groupRows = await rows<{
    id: string;
    name: string;
    description: string;
    sensitive: number;
    kind: "all_members" | "custom";
    created_at: string;
  }>(
    db,
    `SELECT id, name, description, sensitive, kind, created_at
     FROM groups WHERE workspace_id = ? ORDER BY kind, name`,
    workspaceId,
  );
  const memberships = await rows<{ group_id: string; user_id: string }>(
    db,
    `SELECT group_id, user_id FROM group_members WHERE workspace_id = ?`,
    workspaceId,
  );
  const activeCount = await first<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND status = 'active'`,
    workspaceId,
  );
  return groupRows.map((group) => {
    const memberIds = memberships.filter((item) => item.group_id === group.id).map((item) => item.user_id);
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      sensitive: group.sensitive === 1,
      memberCount: group.kind === "all_members" ? Number(activeCount?.count ?? 0) : memberIds.length,
      memberIds,
      createdAt: group.created_at,
    };
  });
}

async function loadGuides(
  db: D1DatabaseLike,
  access: WorkspaceAccess,
  identity: AuthenticatedIdentity,
  isPlatformAdministrator: boolean,
  members: WorkspaceMember[],
  groups: WorkspaceGroup[],
  settings: WorkspaceSettings,
): Promise<Guide[]> {
  const guideRows = await rows<{
    id: string;
    workspace_id: string;
    title: string;
    author_user_id: string;
    current_published_revision_id: string | null;
    working_draft_revision_id: string | null;
    archived_at: string | null;
    screenshots_locked_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    db,
    `SELECT id, workspace_id, title, author_user_id, current_published_revision_id,
            working_draft_revision_id, archived_at, screenshots_locked_at, created_at, updated_at
     FROM guides WHERE workspace_id = ? ORDER BY updated_at DESC`,
    access.workspaceId,
  );
  const [revisionRows, stepRows, audienceRows, reviewRows, mediaRows] = await Promise.all([
    rows<RevisionRow>(
      db,
      `SELECT r.id, r.guide_id, r.workspace_id, r.version, r.status, r.source_type,
              r.title, r.summary, r.category, r.tags_json, r.system_references_json,
              r.privacy_reviewed_at, r.created_by, r.created_at, r.updated_at,
              r.published_by, r.published_at,
              EXISTS (
                SELECT 1 FROM capture_sessions c
                WHERE c.workspace_id = r.workspace_id
                  AND c.status IN ('recording', 'paused')
                  AND json_extract(c.capture_scope, '$.revisionId') = r.id
              ) AS has_active_capture
       FROM guide_revisions r
       WHERE r.workspace_id = ?
       ORDER BY r.guide_id, r.version DESC`,
      access.workspaceId,
    ),
    rows<RevisionStepRow>(
      db,
      `SELECT s.revision_id, s.id, s.position, s.kind, s.title, s.body, s.annotation_json
       FROM guide_steps s
       JOIN guide_revisions r ON r.id = s.revision_id
       WHERE r.workspace_id = ? ORDER BY s.revision_id, s.position`,
      access.workspaceId,
    ),
    rows<RevisionAudienceRow>(
      db,
      `SELECT a.revision_id, a.subject_type, a.subject_id
       FROM guide_audiences a
       JOIN guide_revisions r ON r.id = a.revision_id
       WHERE r.workspace_id = ?`,
      access.workspaceId,
    ),
    rows<RevisionReviewRow>(
      db,
      `SELECT a.revision_id, a.reviewer_user_id, a.status, a.decided_at
       FROM review_assignments a
       JOIN guide_revisions r ON r.id = a.revision_id
       WHERE r.workspace_id = ? ORDER BY a.revision_id, a.decided_at`,
      access.workspaceId,
    ),
    rows<RevisionMediaRow>(
      db,
      `SELECT m.revision_id, m.id, m.step_id
       FROM guide_media m
       JOIN guide_revisions r ON r.id = m.revision_id
       WHERE r.workspace_id = ?`,
      access.workspaceId,
    ),
  ]);
  const activeCaptureRevisionIds = new Set(
    revisionRows.filter((item) => item.has_active_capture === 1).map((item) => item.id),
  );
  const groupNames = new Map(groups.map((item) => [item.id, item.name]));
  const result: Guide[] = [];
  for (const guide of guideRows) {
    const visibility = evaluateGuideVisibility({
      guide,
      revisions: revisionRows,
      steps: stepRows,
      audiences: audienceRows,
      reviews: reviewRows,
      media: mediaRows,
      activeCaptureRevisionIds,
      access,
      identity,
      isPlatformAdministrator,
      settings,
      members,
      groupNames,
    });
    if (!visibility) continue;
    const display = visibility.working ?? visibility.published;
    if (!display) continue;
    result.push({
      id: guide.id,
      workspaceId: guide.workspace_id,
      title: display.title,
      status: visibility.status,
      restricted: visibility.restricted,
      canEdit: visibility.canEdit,
      canReview: visibility.canReview,
      canPublish: visibility.canPublish,
      canDelete: visibility.canDelete,
      createdAt: guide.created_at,
      updatedAt: guide.updated_at,
      ...(guide.screenshots_locked_at ? { screenshotsLockedAt: guide.screenshots_locked_at } : {}),
      publishedRevision: visibility.published,
      workingRevision: visibility.working,
      revisionHistory: visibility.revisionHistory,
    });
  }
  return result;
}

async function loadMetrics(db: D1DatabaseLike, workspaceId: string): Promise<WorkspaceMetrics> {
  const result = await first<{
    members: number;
    groups: number;
    drafts: number;
    reviews: number;
    published: number;
    captures: number;
    views: number;
    completions: number;
    exports: number;
    storage_bytes: number;
    failed_operations: number;
  }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ? AND status = 'active') AS members,
       (SELECT COUNT(*) FROM groups WHERE workspace_id = ?) AS groups,
       (SELECT COUNT(*) FROM guide_revisions WHERE workspace_id = ? AND status = 'draft') AS drafts,
       (SELECT COUNT(*) FROM guide_revisions WHERE workspace_id = ? AND status = 'review') AS reviews,
       (SELECT COUNT(*) FROM guides WHERE workspace_id = ? AND current_published_revision_id IS NOT NULL AND archived_at IS NULL) AS published,
       (SELECT COUNT(*) FROM capture_sessions WHERE workspace_id = ?) AS captures,
       COALESCE((SELECT SUM(views) FROM workspace_metrics_daily WHERE workspace_id = ?), 0) AS views,
       COALESCE((SELECT SUM(completions) FROM workspace_metrics_daily WHERE workspace_id = ?), 0) AS completions,
       (SELECT COUNT(*) FROM exports WHERE workspace_id = ? AND status = 'ready') AS exports,
       COALESCE((SELECT SUM(byte_size) FROM guide_media WHERE workspace_id = ?), 0) AS storage_bytes,
       COALESCE((SELECT SUM(failed_operations) FROM workspace_metrics_daily WHERE workspace_id = ?), 0) AS failed_operations`,
    ...Array(11).fill(workspaceId),
  );
  return {
    members: Number(result?.members ?? 0),
    groups: Number(result?.groups ?? 0),
    drafts: Number(result?.drafts ?? 0),
    reviews: Number(result?.reviews ?? 0),
    published: Number(result?.published ?? 0),
    captures: Number(result?.captures ?? 0),
    views: Number(result?.views ?? 0),
    completions: Number(result?.completions ?? 0),
    exports: Number(result?.exports ?? 0),
    storageBytes: Number(result?.storage_bytes ?? 0),
    failedOperations: Number(result?.failed_operations ?? 0),
  };
}

async function loadInvitations(db: D1DatabaseLike, workspaceId: string): Promise<Invitation[]> {
  const results = await rows<{
    id: string;
    label: string;
    role: Invitation["role"];
    expires_at: string;
    max_uses: number;
    use_count: number;
    revoked_at: string | null;
    created_at: string;
  }>(
    db,
    `SELECT id, label, role, expires_at, max_uses, use_count, revoked_at, created_at
     FROM invitations WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`,
    workspaceId,
  );
  return results.map((item) => ({
    id: item.id,
    label: item.label,
    role: item.role,
    expiresAt: item.expires_at,
    maxUses: item.max_uses,
    useCount: item.use_count,
    revokedAt: item.revoked_at,
    createdAt: item.created_at,
  }));
}

async function loadJoinRequests(db: D1DatabaseLike, workspaceId: string): Promise<JoinRequest[]> {
  const results = await rows<{
    id: string;
    user_id: string;
    email: string;
    status: JoinRequest["status"];
    created_at: string;
  }>(
    db,
    `SELECT id, user_id, email, status, created_at FROM join_requests
     WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`,
    workspaceId,
  );
  return results.map((item) => ({
    id: item.id,
    userId: item.user_id,
    email: item.email,
    name: item.email.split("@")[0],
    status: item.status,
    createdAt: item.created_at,
  }));
}

async function loadAudits(db: D1DatabaseLike, workspaceId: string): Promise<AuditEvent[]> {
  const results = await rows<{
    id: string;
    sequence: number;
    action: string;
    actor_name: string | null;
    actor_email: string | null;
    target_type: string;
    target_id: string | null;
    target_label: string | null;
    summary: string;
    occurred_at: string;
    metadata_json: string;
  }>(
    db,
    `SELECT id, sequence, action, actor_name, actor_email, target_type, target_id,
            target_label, summary, occurred_at, metadata_json
     FROM audit_events WHERE workspace_id = ? ORDER BY sequence DESC LIMIT 500`,
    workspaceId,
  );
  return results.map((item) => ({
    id: item.id,
    sequence: item.sequence,
    action: item.action,
    actorName: item.actor_name ?? "Unknown actor",
    actorEmail: item.actor_email ?? "",
    targetType: item.target_type,
    targetId: item.target_id ?? "",
    targetLabel: item.target_label ?? item.target_id ?? "",
    summary: item.summary,
    occurredAt: item.occurred_at,
    metadata: safeJson(item.metadata_json, {}),
  }));
}

async function loadVaultItems(db: D1DatabaseLike, workspaceId: string): Promise<VaultItem[]> {
  const results = await rows<{
    id: string;
    title: string;
    encrypted_envelope_json: string;
    metadata_json: string;
    created_by: string;
    created_at: string;
    updated_at: string;
  }>(
    db,
    `SELECT id, title, encrypted_envelope_json, metadata_json, created_by,
            created_at, updated_at
     FROM vault_items WHERE workspace_id = ? ORDER BY updated_at DESC, id`,
    workspaceId,
  );
  return results.map((item) => ({
    id: item.id,
    title: item.title,
    encryptedEnvelopeJson: item.encrypted_envelope_json,
    metadataJson: item.metadata_json,
    createdBy: item.created_by,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }));
}

async function loadWorkspaceBundle(
  db: D1DatabaseLike,
  repository: D1KnowHowRepository,
  summary: WorkspaceSummary,
  access: WorkspaceAccess,
  identity: AuthenticatedIdentity,
  isPlatformAdministrator: boolean,
): Promise<WorkspaceBundle> {
  const admin = access.roles.includes("administrator");
  // Keep each fan-out below D1's six simultaneous-connection ceiling. These
  // loaders also feed guide authorization, so they must finish before any
  // document blocks are selected for delivery.
  const settings = await loadSettings(db, access.workspaceId);
  const members = await loadMembers(db, access.workspaceId);
  const groups = await loadGroups(db, access.workspaceId);
  const memberDirectory = admin
    ? members
    : members.map((member) => ({
        ...member,
        name:
          member.userId === identity.userId || member.name !== member.email
            ? member.name
            : `Workspace member ${member.userId.slice(-6)}`,
      }));
  const metrics = admin
    ? await loadMetrics(db, access.workspaceId)
    : {
        members: 0,
        groups: 0,
        drafts: 0,
        reviews: 0,
        published: 0,
        captures: 0,
        views: 0,
        completions: 0,
        exports: 0,
        storageBytes: 0,
        failedOperations: 0,
      };
  const guides = await loadGuides(
    db,
    access,
    identity,
    isPlatformAdministrator,
    memberDirectory,
    groups,
    settings,
  );
  // The current client receives document blocks in bootstrap. Record every
  // restricted published revision before returning those bytes; an audit
  // failure therefore fails closed instead of serving an unrecorded view.
  for (const guide of guides) {
    const published = guide.publishedRevision;
    if (!published || published.audiences.some((item) => item.kind === "workspace")) continue;
    await audit(repository, identity, access.workspaceId, {
      action: "guide.restricted-viewed",
      targetType: "guide",
      targetId: guide.id,
      targetLabel: published.title,
      summary: `${published.title} restricted content delivered`,
      metadata: { revisionId: published.id, delivery: "workspace-bootstrap" },
    });
  }
  const exposedMembers = admin
    ? members
    : memberDirectory
        .filter((member) => member.status === "active")
        .map((member) => ({
          ...member,
          email: member.userId === identity.userId ? member.email : "",
          roles: member.userId === identity.userId ? member.roles : [],
          capabilities:
            member.userId === identity.userId ? member.capabilities : [],
          groupIds: [],
        }));
  const exposedGroups = admin
    ? groups
    : groups.map((group) => ({
        ...group,
        memberCount: group.sensitive ? 0 : group.memberCount,
        memberIds: [],
      }));
  const exposedSettings = admin
    ? settings
    : { ...settings, allowedDomains: [], excludedCaptureHosts: [] };
  const supportRequests = admin
    ? await loadSupportRequests(db, access.workspaceId)
    : [];
  const supportGrants = admin
    ? await loadSupportGrants(db, access.workspaceId)
    : [];
  return {
    workspace: { ...summary, settings: exposedSettings },
    metrics,
    members: exposedMembers,
    groups: exposedGroups,
    guides,
    invitations: admin ? await loadInvitations(db, access.workspaceId) : [],
    joinRequests: admin ? await loadJoinRequests(db, access.workspaceId) : [],
    supportRequests,
    supportGrants,
    audits: admin ? await loadAudits(db, access.workspaceId) : [],
    vaultItems: authorize(
      "vault.use",
      policyContext(access, isPlatformAdministrator),
    ).allowed
      ? await loadVaultItems(db, access.workspaceId)
      : [],
  };
}

async function loadSupportRequests(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<SupportAccessRequest[]> {
  const results = await rows<{
    id: string;
    requester_user_id: string;
    requester_email: string;
    requester_name: string;
    requested_role: WorkspaceRole;
    reason: string;
    requested_duration_hours: number;
    status: SupportAccessRequest["status"];
    granted_role: WorkspaceRole | null;
    created_at: string;
  }>(
    db,
    `SELECT id, requester_user_id, requester_email, requester_name, requested_role,
            reason, requested_duration_hours, status, granted_role, created_at
     FROM support_access_requests
     WHERE workspace_id = ? AND status = 'pending'
     ORDER BY created_at DESC`,
    workspaceId,
  );
  return results.map((item) => ({
    id: item.id,
    workspaceId,
    requesterUserId: item.requester_user_id,
    requesterEmail: item.requester_email,
    requesterName: item.requester_name,
    requestedRole: item.requested_role,
    reason: item.reason,
    requestedDurationHours: item.requested_duration_hours,
    status: item.status,
    grantedRole: item.granted_role,
    createdAt: item.created_at,
  }));
}

async function loadSupportGrants(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<SupportAccessGrant[]> {
  const results = await rows<{
    id: string;
    request_id: string;
    user_id: string;
    email: string;
    display_name: string;
    role: WorkspaceRole;
    status: SupportAccessGrant["status"];
    approved_by: string;
    granted_at: string;
    expires_at: string;
    ended_at: string | null;
    revoked_by: string | null;
  }>(
    db,
    `SELECT id, request_id, user_id, email, display_name, role, status,
            approved_by, granted_at, expires_at, ended_at, revoked_by
     FROM support_access_grants
     WHERE workspace_id = ?
     ORDER BY granted_at DESC
     LIMIT 100`,
    workspaceId,
  );
  return results.map((item) => ({
    id: item.id,
    requestId: item.request_id,
    workspaceId,
    userId: item.user_id,
    email: item.email,
    displayName: item.display_name,
    role: item.role,
    status: item.status,
    approvedBy: item.approved_by,
    grantedAt: item.granted_at,
    expiresAt: item.expires_at,
    endedAt: item.ended_at,
    revokedBy: item.revoked_by,
  }));
}

async function loadPlatform(
  db: D1DatabaseLike,
  identity: AuthenticatedIdentity,
): Promise<NonNullable<BootstrapResponse["platform"]>> {
  const workspaceRows = await rows<{
    id: string;
    name: string;
    slug: string;
    status: WorkspaceStatus;
    created_at: string;
    member_count: number;
    published_count: number;
    draft_count: number;
    captures: number;
    views: number;
    completions: number;
    exports: number;
    storage_bytes: number;
    failed_operations: number;
  }>(
    db,
    `SELECT w.id, w.name, w.slug, w.status, w.created_at,
       (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.status = 'active') AS member_count,
       (SELECT COUNT(*) FROM guides g WHERE g.workspace_id = w.id AND g.current_published_revision_id IS NOT NULL AND g.archived_at IS NULL) AS published_count,
       (SELECT COUNT(*) FROM guide_revisions gr WHERE gr.workspace_id = w.id AND gr.status IN ('draft','review')) AS draft_count,
       (SELECT COUNT(*) FROM capture_sessions cs WHERE cs.workspace_id = w.id) AS captures,
       COALESCE((SELECT SUM(views) FROM workspace_metrics_daily m WHERE m.workspace_id = w.id), 0) AS views,
       COALESCE((SELECT SUM(completions) FROM workspace_metrics_daily m WHERE m.workspace_id = w.id), 0) AS completions,
       (SELECT COUNT(*) FROM exports e WHERE e.workspace_id = w.id AND e.status = 'ready') AS exports,
       COALESCE((SELECT SUM(byte_size) FROM guide_media gm WHERE gm.workspace_id = w.id), 0) AS storage_bytes,
       COALESCE((SELECT SUM(failed_operations) FROM workspace_metrics_daily m WHERE m.workspace_id = w.id), 0) AS failed_operations
     FROM workspaces w ORDER BY w.created_at DESC`,
  );
  const administratorRows = await rows<{
    workspace_id: string;
    user_id: string;
    display_name: string | null;
    email: string;
  }>(
    db,
    `SELECT wm.workspace_id, wm.user_id, wm.display_name, wm.email
     FROM workspace_members wm
     JOIN workspace_member_roles r
       ON r.workspace_id = wm.workspace_id AND r.user_id = wm.user_id
     WHERE r.role = 'administrator' AND wm.status = 'active'
     ORDER BY wm.workspace_id, COALESCE(wm.display_name, wm.email)`,
  );
  const [supportRows, appointmentRows, settingsRow] = await Promise.all([
    rows<{
      workspace_id: string;
      request_id: string;
      request_status: "pending" | "approved" | "denied" | "cancelled";
      requested_role: WorkspaceRole;
      requested_duration_hours: number;
      reason: string;
      created_at: string;
      grant_id: string | null;
      grant_role: WorkspaceRole | null;
      granted_at: string | null;
      expires_at: string | null;
    }>(
      db,
      `SELECT r.workspace_id, r.id AS request_id, r.status AS request_status,
              r.requested_role, r.requested_duration_hours, r.reason, r.created_at,
              g.id AS grant_id, g.role AS grant_role, g.granted_at, g.expires_at
       FROM support_access_requests r
       LEFT JOIN support_access_grants g ON g.request_id = r.id
       WHERE r.requester_user_id = ?
       ORDER BY r.created_at DESC`,
      identity.userId,
    ),
    rows<{
      id: string;
      workspace_id: string;
      email: string;
      status: AdminAppointment["status"];
      expires_at: string;
      created_at: string;
    }>(
      db,
      `SELECT a.id, a.workspace_id, a.email, a.status, a.expires_at, a.created_at
       FROM admin_appointments a
       JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.status = 'active'
       ORDER BY a.created_at DESC`,
    ),
    db
      .prepare(
        `SELECT value_json FROM platform_settings WHERE key = 'selfServiceWorkspaceLimit' LIMIT 1`,
      )
      .first<{ value_json: string }>(),
  ]);
  const latestByWorkspace = new Map<string, typeof supportRows[number]>();
  for (const row of supportRows) {
    if (!latestByWorkspace.has(row.workspace_id)) latestByWorkspace.set(row.workspace_id, row);
  }
  const appointments: AdminAppointment[] = appointmentRows.map((item) => ({
    id: item.id,
    workspaceId: item.workspace_id,
    email: item.email,
    status: item.status,
    expiresAt: item.expires_at,
    createdAt: item.created_at,
  }));
  const workspaces: PlatformWorkspace[] = [];
  for (const workspace of workspaceRows) {
    const administrators = administratorRows.filter(
      (admin) => admin.workspace_id === workspace.id,
    );
    const support = latestByWorkspace.get(workspace.id);
    workspaces.push({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      status: workspace.status,
      roles: [],
      memberCount: Number(workspace.member_count),
      publishedCount: Number(workspace.published_count),
      draftCount: Number(workspace.draft_count),
      createdAt: workspace.created_at,
      administrators: administrators.map((admin) => ({ userId: admin.user_id, name: admin.display_name ?? admin.email, email: admin.email })),
      captures: Number(workspace.captures),
      views: Number(workspace.views),
      completions: Number(workspace.completions),
      exports: Number(workspace.exports),
      storageBytes: Number(workspace.storage_bytes),
      failedOperations: Number(workspace.failed_operations),
      supportRequest: support
        ? {
            id: support.request_id,
            status: support.request_status,
            requestedRole: support.requested_role,
            requestedDurationHours: support.requested_duration_hours,
            reason: support.reason,
            createdAt: support.created_at,
          }
        : null,
      supportGrant:
        support?.grant_id && support.grant_role && support.granted_at && support.expires_at
          ? {
              id: support.grant_id,
              role: support.grant_role,
              grantedAt: support.granted_at,
              expiresAt: support.expires_at,
            }
          : null,
    });
  }
  const metrics: PlatformMetrics = {
    users: Number((await first<{ count: number }>(db, `SELECT COUNT(DISTINCT user_id) AS count FROM workspace_members`))?.count ?? 0),
    activeWorkspaces: workspaces.filter((item) => item.status === "active").length,
    suspendedWorkspaces: workspaces.filter((item) => item.status === "suspended").length,
    archivedWorkspaces: workspaces.filter((item) => item.status === "archived").length,
    drafts: workspaces.reduce((total, item) => total + item.draftCount, 0),
    published: workspaces.reduce((total, item) => total + item.publishedCount, 0),
    captures: workspaces.reduce((total, item) => total + item.captures, 0),
    views: workspaces.reduce((total, item) => total + item.views, 0),
    completions: workspaces.reduce((total, item) => total + item.completions, 0),
    exports: workspaces.reduce((total, item) => total + item.exports, 0),
    storageBytes: workspaces.reduce((total, item) => total + item.storageBytes, 0),
    failedOperations: workspaces.reduce((total, item) => total + item.failedOperations, 0),
  };
  let limit = 1;
  try {
    const parsed = settingsRow ? (JSON.parse(settingsRow.value_json) as unknown) : null;
    if (typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0 && parsed <= 1000) {
      limit = parsed;
    }
  } catch {
    // Fall back to the default limit.
  }
  return { metrics, workspaces, settings: { selfServiceWorkspaceLimit: limit }, appointments };
}

async function bootstrap(request: Request): Promise<BootstrapResponse> {
  const db = dbBinding();
  const repository = await repositoryFor(db);
  const identity = await requireVerifiedIdentity(request);
  const isPlatformAdministrator = await platformAdministrator(db, repository, identity);
  // Close any grants that lapsed while the workspace was idle and record each
  // expiration in the customer's audit ledger before serving access.
  const expired = await repository.expireSupportGrants();
  for (const grant of expired) {
    await audit(repository, identity, grant.workspaceId, {
      action: "support.expired",
      targetType: "support-grant",
      targetId: grant.id,
      targetLabel: grant.email,
      summary: `${grant.email} temporary access expired`,
      metadata: { role: grant.role, expiresAt: grant.expiresAt },
    });
  }
  const accesses = await repository.listWorkspaceAccess(identity.userId);
  const summaries = await loadWorkspaceSummaries(db, accesses);
  const eligibleIds = await repository.findDomainEligibleWorkspaceIds(identity.email);
  const eligibleRows = eligibleIds.length
    ? await rows<{ id: string; name: string; slug: string; status: WorkspaceStatus; created_at: string }>(
         db,
         `SELECT id, name, slug, status, created_at FROM workspaces
          WHERE id IN (SELECT value FROM json_each(?))`,
         JSON.stringify(eligibleIds),
       )
    : [];
  const requested = new URL(request.url).searchParams.get("workspaceId");
  const readableAccesses = accesses.filter((item) =>
    authorize("workspace.read", policyContext(item, isPlatformAdministrator)).allowed &&
    item.membershipStatus === "active" &&
    item.workspaceStatus === "active",
  );
  const selectedAccess =
    readableAccesses.find((item) => item.workspaceId === requested) ??
    readableAccesses[0];
  const selectedSummary = summaries.find((item) => item.id === selectedAccess?.workspaceId);
  const theme = await first<{ theme: "light" | "dark" | "system" }>(
    db,
    `SELECT theme FROM user_preferences WHERE user_id = ?`,
    identity.userId,
  );
  return {
    viewer: {
      id: identity.userId,
      email: identity.email,
      name: identity.name,
      emailVerified: identity.emailVerified,
      platformAdministrator: isPlatformAdministrator,
      themePreference: theme?.theme ?? "system",
    },
    workspaces: summaries,
    eligibleWorkspaces: eligibleRows
      .filter((item) => !accesses.some((access) => access.workspaceId === item.id))
      .map((item) => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        status: item.status,
        roles: [],
        memberCount: 0,
        publishedCount: 0,
        draftCount: 0,
        createdAt: item.created_at,
      })),
    activeWorkspace:
      selectedAccess && selectedSummary
        ? await loadWorkspaceBundle(
            db,
            repository,
            selectedSummary,
            selectedAccess,
            identity,
            isPlatformAdministrator,
          )
        : null,
    ...(isPlatformAdministrator ? { platform: await loadPlatform(db, identity) } : {}),
  };
}

function normalizeAudiences(value: unknown, workspaceId: string): Audience[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new HttpError(400, "AUDIENCE_REQUIRED", "Select at least one audience.");
  }
  const result: Audience[] = [];
  for (const candidate of value) {
    const item = asObject(candidate, "Audience");
    if (!(["workspace", "group", "user"] as unknown[]).includes(item.kind)) {
      throw new HttpError(400, "AUDIENCE_INVALID", "An audience is invalid.");
    }
    const kind = item.kind as Audience["kind"];
    result.push({
      kind,
      subjectId:
        kind === "workspace"
          ? workspaceId
          : textValue(item.subjectId, "Audience target", { min: 1, max: 128 }),
      label:
        typeof item.label === "string" ? textValue(item.label, "Audience label", { max: 200 }) : undefined,
    });
  }
  if (result.some((item) => item.kind === "workspace")) {
    return [{ kind: "workspace", subjectId: workspaceId, label: "Entire workspace" }];
  }
  return result.filter(
    (item, index, all) =>
      all.findIndex((candidate) => candidate.kind === item.kind && candidate.subjectId === item.subjectId) === index,
  );
}

function normalizedCoordinate(value: unknown, label: string, options: { positive?: boolean } = {}) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < (options.positive ? Number.EPSILON : 0) ||
    value > 1
  ) {
    throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} must be normalized between 0 and 1.`);
  }
  return value;
}

function normalizedCrop(value: unknown, label: string): NonNullable<EditorBlock["crop"]> {
  const crop = asObject(value, label);
  const expected = new Set(["x", "y", "width", "height"]);
  if (Object.keys(crop).length !== 4 || Object.keys(crop).some((key) => !expected.has(key))) {
    throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} has invalid fields.`);
  }
  const result = {
    x: normalizedCoordinate(crop.x, `${label} x`),
    y: normalizedCoordinate(crop.y, `${label} y`),
    width: normalizedCoordinate(crop.width, `${label} width`, { positive: true }),
    height: normalizedCoordinate(crop.height, `${label} height`, { positive: true }),
  };
  if (result.x + result.width > 1 || result.y + result.height > 1) {
    throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} must stay inside the screenshot.`);
  }
  return result;
}

function normalizedAnnotations(
  value: unknown,
  label: string,
): NonNullable<EditorBlock["annotations"]> {
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} is invalid.`);
  }
  const allowedKeys = new Set([
    "id",
    "kind",
    "x",
    "y",
    "width",
    "height",
    "x2",
    "y2",
    "text",
    "color",
  ]);
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const annotation = asObject(candidate, `${label} ${index + 1}`);
    if (Object.keys(annotation).some((key) => !allowedKeys.has(key))) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} ${index + 1} has invalid fields.`);
    }
    const annotationId = textValue(annotation.id, `${label} ${index + 1} ID`, {
      min: 1,
      max: 128,
    });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(annotationId) || seen.has(annotationId)) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} IDs must be unique and valid.`);
    }
    seen.add(annotationId);
    if (!(annotation.kind === "click" || annotation.kind === "arrow" || annotation.kind === "box" || annotation.kind === "text")) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} ${index + 1} has an invalid kind.`);
    }
    const x = normalizedCoordinate(annotation.x, `${label} ${index + 1} x`);
    const y = normalizedCoordinate(annotation.y, `${label} ${index + 1} y`);
    const width = annotation.width === undefined
      ? undefined
      : normalizedCoordinate(annotation.width, `${label} ${index + 1} width`, {
          positive: true,
        });
    const height = annotation.height === undefined
      ? undefined
      : normalizedCoordinate(annotation.height, `${label} ${index + 1} height`, {
          positive: true,
        });
    if ((width !== undefined && x + width > 1) || (height !== undefined && y + height > 1)) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} ${index + 1} is outside the screenshot.`);
    }
    const x2 = annotation.x2 === undefined
      ? undefined
      : normalizedCoordinate(annotation.x2, `${label} ${index + 1} x2`);
    const y2 = annotation.y2 === undefined
      ? undefined
      : normalizedCoordinate(annotation.y2, `${label} ${index + 1} y2`);
    const annotationText = annotation.text === undefined
      ? undefined
      : textValue(annotation.text, `${label} ${index + 1} text`, { max: 2_000 });
    if (annotation.kind === "text" && !annotationText) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} text annotations need text.`);
    }
    const color = annotation.color === undefined
      ? undefined
      : textValue(annotation.color, `${label} ${index + 1} color`, { min: 7, max: 7 });
    if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} ${index + 1} has an invalid color.`);
    }
    return {
      id: annotationId,
      kind: annotation.kind,
      x,
      y,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(x2 !== undefined ? { x2 } : {}),
      ...(y2 !== undefined ? { y2 } : {}),
      ...(annotationText !== undefined ? { text: annotationText } : {}),
      ...(color !== undefined ? { color } : {}),
    };
  });
}

function normalizedRedactions(
  value: unknown,
  label: string,
): NonNullable<EditorBlock["redactions"]> {
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} is invalid.`);
  }
  const allowedKeys = new Set(["id", "x", "y", "width", "height", "applied"]);
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const region = asObject(candidate, `${label} ${index + 1}`);
    if (Object.keys(region).some((key) => !allowedKeys.has(key))) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} ${index + 1} has invalid fields.`);
    }
    const regionId = textValue(region.id, `${label} ${index + 1} ID`, { min: 1, max: 128 });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(regionId) || seen.has(regionId)) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} IDs must be unique and valid.`);
    }
    seen.add(regionId);
    const x = normalizedCoordinate(region.x, `${label} ${index + 1} x`);
    const y = normalizedCoordinate(region.y, `${label} ${index + 1} y`);
    const width = normalizedCoordinate(region.width, `${label} ${index + 1} width`, { positive: true });
    const height = normalizedCoordinate(region.height, `${label} ${index + 1} height`, { positive: true });
    if (x + width > 1 || y + height > 1) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} ${index + 1} is outside the screenshot.`);
    }
    if (typeof region.applied !== "boolean") {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} ${index + 1} is missing its applied state.`);
    }
    return { id: regionId, x, y, width, height, applied: region.applied };
  });
}

function normalizeBlocks(value: unknown): EditorBlock[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 250) {
    throw new HttpError(400, "GUIDE_STEPS_INVALID", "A guide needs between 1 and 250 blocks.");
  }
  return value.map((candidate, index) => {
    const item = asObject(candidate, `Block ${index + 1}`);
    if (!(["action", "heading", "note", "warning"] as unknown[]).includes(item.kind)) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `Block ${index + 1} has an invalid type.`);
    }
    const blockId = typeof item.id === "string"
      ? textValue(item.id, `Block ${index + 1} ID`, { min: 1, max: 128 })
      : id("client_block");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(blockId)) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `Block ${index + 1} has an invalid ID.`);
    }
    const screenshotMediaId = typeof item.screenshotMediaId === "string"
      ? textValue(item.screenshotMediaId, "Screenshot", { min: 1, max: 128 })
      : undefined;
    if (screenshotMediaId && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(screenshotMediaId)) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `Block ${index + 1} has an invalid screenshot.`);
    }
    const crop = item.crop === undefined
      ? undefined
      : normalizedCrop(item.crop, `Block ${index + 1} crop`);
    const annotations = item.annotations === undefined
      ? undefined
      : normalizedAnnotations(item.annotations, `Block ${index + 1} annotations`);
    const redactions = item.redactions === undefined
      ? undefined
      : normalizedRedactions(item.redactions, `Block ${index + 1} redactions`);
    if (!screenshotMediaId && (crop || (annotations && annotations.length) || (redactions && redactions.length))) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `Block ${index + 1} media edits need a screenshot.`);
    }
    return {
      id: blockId,
      kind: item.kind as EditorBlock["kind"],
      title: textValue(item.title, `Block ${index + 1} title`, { min: 1, max: 500 }),
      description: textValue(item.description ?? "", `Block ${index + 1} description`, { max: 50_000 }),
      ...(screenshotMediaId ? { screenshotMediaId } : {}),
      ...(crop ? { crop } : {}),
      ...(annotations ? { annotations } : {}),
      ...(redactions ? { redactions } : {}),
    };
  });
}

function canonicalAudience(audiences: Audience[], workspaceId: string): GuideAudience {
  if (audiences.some((item) => item.kind === "workspace")) {
    return { mode: "workspace", workspaceId };
  }
  return {
    mode: "restricted",
    workspaceId,
    targets: audiences.map((item) => ({
      type: item.kind as "group" | "user",
      id: item.subjectId!,
      ...(item.label ? { label: item.label } : {}),
    })),
  };
}

function canonicalBlocks(blocks: EditorBlock[]): GuideBlock[] {
  return blocks.map((block) => {
    if (block.kind === "heading") return { id: block.id, type: "heading", level: 2, text: block.title };
    if (block.kind === "note" || block.kind === "warning") {
      return {
        id: block.id,
        type: "callout",
        tone: block.kind === "warning" ? "warning" : "note",
        title: block.title,
        text: block.description || block.title,
      };
    }
    return { id: block.id, type: "action", title: block.title, instructions: block.description || block.title };
  });
}

function validateCanonicalRevision(input: {
  guideId: string;
  revisionId: string;
  workspaceId: string;
  version: number;
  lifecycle: "draft" | "review";
  source: "manual" | "browser-capture";
  title: string;
  summary: string;
  createdAt: string;
  identity: AuthenticatedIdentity;
  blocks: EditorBlock[];
  audiences: Audience[];
  privacyReviewed: boolean;
  branding: WorkspaceBranding;
}) {
  const guideActor: GuideActor = { userId: input.identity.userId, displayName: input.identity.name };
  const base = {
    schemaVersion: 1 as const,
    guideId: input.guideId,
    revisionId: input.revisionId,
    workspaceId: input.workspaceId,
    revisionNumber: input.version,
    source: input.source,
    title: input.title,
    summary: input.summary,
    createdAt: input.createdAt,
    createdBy: guideActor,
    blocks: canonicalBlocks(input.blocks),
    audience: canonicalAudience(input.audiences, input.workspaceId),
    privacyReview:
      input.source === "browser-capture"
        ? {
            required: true as const,
            status: input.privacyReviewed ? ("approved" as const) : ("pending" as const),
            originalMediaRetained: false as const,
            ...(input.privacyReviewed
              ? { reviewedAt: input.createdAt, reviewedBy: guideActor, findingsResolved: true }
              : {}),
          }
        : {
            required: false as const,
            status: "not-required" as const,
            originalMediaRetained: false as const,
          },
    branding: input.branding,
    exportPolicy: {
      allowedFormats: ["live-link", "pdf", "html", "markdown"] as const,
      restrictedGuideExports: "allowed" as const,
      watermark: {
        mode: "optional" as const,
        includeViewer: true,
        includeWorkspace: true,
        includeDate: true,
      },
    },
  };
  const candidate: GuideRevision =
    input.lifecycle === "review"
      ? { ...base, lifecycle: "review", submittedAt: input.createdAt, submittedBy: guideActor }
      : { ...base, lifecycle: "draft" };
  parseGuideRevision(candidate);
}

async function createWorkspace(
  db: D1DatabaseLike,
  repository: D1KnowHowRepository,
  identity: AuthenticatedIdentity,
  payload: Record<string, unknown>,
  options: { selfServe: boolean; administratorEmail?: string; inviteEmails?: string[] },
) {
  const name = textValue(payload.name, "Workspace name", { min: 2, max: 120 });
  const workspaceId = id("ws");
  const entityId = id("entity");
  const groupId = id("group");
  const workspaceSlug = `${slug(name)}-${workspaceId.slice(-6)}`;
  const statements = [
    statement(db, `INSERT INTO entities (id, name, status, created_by, created_at, updated_at) VALUES (?, ?, 'active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, entityId, name, identity.userId),
    statement(db, `INSERT INTO workspaces (id, entity_id, name, slug, status, self_serve, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, workspaceId, entityId, name, workspaceSlug, options.selfServe ? 1 : 0, identity.userId),
    statement(db, `INSERT INTO workspace_settings (workspace_id, accent_color, click_target_color, remove_branding, restricted_exports_enabled, watermark_restricted_exports, capture_policy_json, created_at, updated_at) VALUES (?, '#356fe5', '#ef6f47', 0, 0, 1, '{"excludedHosts":[]}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, workspaceId),
    statement(db, `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, status, joined_at, updated_at) VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, workspaceId, identity.userId, identity.email, identity.name),
    statement(db, `INSERT INTO workspace_member_roles (workspace_id, user_id, role, granted_by, granted_at) VALUES (?, ?, 'administrator', ?, CURRENT_TIMESTAMP)`, workspaceId, identity.userId, identity.userId),
    statement(db, `INSERT INTO groups (id, workspace_id, name, slug, description, sensitive, kind, created_by, created_at, updated_at) VALUES (?, ?, 'All Employees', 'all-employees', 'Every active workspace member', 0, 'all_members', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, groupId, workspaceId, identity.userId),
  ];
  const results = await db.batch(statements);
  if (results.some((result) => !result.success)) {
    throw new HttpError(409, "WORKSPACE_CREATE_FAILED", "The workspace could not be created.");
  }
  await audit(repository, identity, workspaceId, {
    action: "workspace.created",
    targetType: "workspace",
    targetId: workspaceId,
    targetLabel: name,
    summary: `${name} workspace created`,
    metadata: options.selfServe ? { origin: "self-serve" } : { origin: "platform-provisioned" },
  });

  let appointmentToken: string | null = null;
  if (options.administratorEmail) {
    appointmentToken = await createAppointmentToken(
      db,
      repository,
      identity,
      workspaceId,
      options.administratorEmail,
    );
  }
  const invitations = await createScopedInvitations(
    db,
    repository,
    identity,
    workspaceId,
    options.inviteEmails ?? [],
    null,
  );
  return { workspaceId, appointmentToken, invitations };
}

/**
 * A pending administrator appointment: single-use, expiring, and bound to one
 * normalized email. The recipient must sign in with that exact verified email
 * and explicitly accept before becoming the workspace administrator.
 */
async function createAppointmentToken(
  db: D1DatabaseLike,
  repository: D1KnowHowRepository,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  rawEmail: string,
): Promise<string> {
  const email = rawEmail.trim().toLowerCase();
  if (extractExactEmailDomain(email) === null || email.length > 320) {
    throw new HttpError(400, "APPOINTMENT_EMAIL_INVALID", "The administrator email is invalid.");
  }
  const appointmentId = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 14 * 24 * 3600;
  const token = await signAppointmentToken(
    { jti: appointmentId, workspaceId, email, expiresAt: expiresAtSeconds },
    signingKey(),
  );
  const tokenHash = await hashToken(token);
  await audit(
    repository,
    identity,
    workspaceId,
    {
      action: "appointment.created",
      targetType: "admin-appointment",
      targetId: appointmentId,
      summary: `Administrator appointment created`,
      metadata: { durationDays: 14 },
    },
    [
      statement(
        db,
        `INSERT INTO admin_appointments (id, workspace_id, token_hash, email, status, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)`,
        appointmentId,
        workspaceId,
        tokenHash,
        email,
        new Date(expiresAtSeconds * 1000).toISOString(),
        identity.userId,
      ),
    ],
  );
  return token;
}

async function createScopedInvitations(
  db: D1DatabaseLike,
  repository: D1KnowHowRepository,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  emails: string[],
  supportGrant: SupportGrantState | null,
): Promise<string[]> {
  const unique = [...new Set(emails.map((email) => email.trim().toLowerCase()))].slice(0, 50);
  const tokens: string[] = [];
  for (const email of unique) {
    if (extractExactEmailDomain(email) === null || email.length > 320) {
      throw new HttpError(400, "INVITE_EMAIL_INVALID", `${email} is not a valid email address.`);
    }
    const invitationId = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const maxHours = 24 * 90;
    const expiresAtSeconds =
      supportGrant !== null
        ? Math.min(
            Math.floor(Date.parse(supportGrant.expiresAt) / 1000),
            Math.floor(Date.now() / 1000) + maxHours * 3600,
          )
        : Math.floor(Date.now() / 1000) + maxHours * 3600;
    const token = await signInviteToken(
      {
        jti: invitationId,
        workspaceId,
        role: "viewer",
        email,
        expiresAt: expiresAtSeconds,
      },
      signingKey(),
    );
    const tokenHash = await hashToken(token);
    await audit(
      repository,
      identity,
      workspaceId,
      {
        action: "invitation.created",
        targetType: "invitation",
        targetId: invitationId,
        summary: "Email-scoped invitation created",
        metadata: {
          role: "viewer",
          maxUses: 1,
          ...(supportGrant !== null
            ? { via: "support-access", grantId: supportGrant.id }
            : {}),
        },
      },
      [
        statement(
          db,
          `INSERT INTO invitations (id, workspace_id, token_hash, label, email, role, status, max_uses, use_count, expires_at, created_by, created_via, created_at)
           VALUES (?, ?, ?, ?, ?, 'viewer', 'active', 1, 0, ?, ?, ?, CURRENT_TIMESTAMP)`,
          invitationId,
          workspaceId,
          tokenHash,
          `Invite ${email}`,
          email,
          new Date(expiresAtSeconds * 1000).toISOString(),
          identity.userId,
          supportGrant !== null ? "support-access" : "standard",
        ),
      ],
    );
    tokens.push(token);
  }
  return tokens;
}

async function handleCommand(
  request: Request,
  actionName: string,
  payload: Record<string, unknown>,
) {
  const db = dbBinding();
  const repository = await repositoryFor(db);
  const identity = await requireVerifiedIdentity(request);
  const isPlatformAdministrator = await platformAdministrator(db, repository, identity);
  // A platform administrator operating under a temporary support grant is a
  // transient workspace identity: platform authority is suspended for the
  // duration of the grant (see policy.ts). This covers every platform-level
  // mutation, not just the ones whose policy contexts carry the grant.
  const activeSupportGrantAnywhere = isPlatformAdministrator
    ? await repository.hasActiveSupportGrant(identity.userId)
    : false;
  const platformMutation =
    actionName === "createWorkspace" ||
    actionName === "setWorkspaceStatus" ||
    actionName === "assignWorkspaceAdministrator" ||
    actionName === "requestSupportAccess" ||
    actionName === "revokeAppointment" ||
    actionName === "updatePlatformSettings";
  if (platformMutation && activeSupportGrantAnywhere) {
    throw new HttpError(
      409,
      "SUPPORT_GRANT_ACTIVE",
      "Platform administration is suspended while temporary support access is active.",
    );
  }

  if (actionName === "createWorkspace") {
    if (isPlatformAdministrator) {
      requireAuthorized("platform.workspaces.manage", {
        isVerifiedIdentity: true,
        isPlatformAdministrator,
        roles: [],
      });
      const rawAdministrator = payload.administratorEmail;
      const administratorEmail =
        typeof rawAdministrator === "string" && rawAdministrator.trim()
          ? rawAdministrator.trim().toLowerCase()
          : undefined;
      const inviteEmails =
        payload.inviteEmails === undefined || payload.inviteEmails === null
          ? []
          : stringList(payload.inviteEmails, "Invite emails", 50);
      return createWorkspace(db, repository, identity, payload, {
        selfServe: false,
        administratorEmail,
        inviteEmails,
      });
    }
    // Any verified user may create a personal workspace; the self-serve limit
    // is enforced atomically by the workspaces_limit_self_serve trigger.
    return createWorkspace(db, repository, identity, payload, { selfServe: true });
  }
  if (actionName === "requestSupportAccess") {
    requireAuthorized("platform.workspaces.manage", {
      isVerifiedIdentity: true,
      isPlatformAdministrator,
      roles: [],
    });
    const targetWorkspaceId = textValue(payload.workspaceId, "Workspace", { min: 1, max: 128 });
    const requestedRole = textValue(payload.requestedRole, "Requested role", { min: 4, max: 13 }) as WorkspaceRole;
    if (!(["administrator", "creator", "reviewer", "publisher", "viewer"] as string[]).includes(requestedRole)) {
      throw new HttpError(400, "SUPPORT_ROLE_INVALID", "The requested role is invalid.");
    }
    const reason = textValue(payload.reason, "Reason", { min: 10, max: 2000 });
    const requestedDurationHours = integerValue(payload.requestedDurationHours, "Duration", 1, 168);
    const target = await first<{ name: string; status: WorkspaceStatus }>(
      db,
      `SELECT name, status FROM workspaces WHERE id = ?`,
      targetWorkspaceId,
    );
    if (!target) throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    if (target.status !== "active") {
      throw new HttpError(409, "WORKSPACE_NOT_ACTIVE", "Only active workspaces accept support access.");
    }
    const existing = await first<{ id: string }>(
      db,
      `SELECT id FROM support_access_requests
       WHERE workspace_id = ? AND requester_user_id = ? AND status = 'pending'
       LIMIT 1`,
      targetWorkspaceId,
      identity.userId,
    );
    if (existing) {
      throw new HttpError(409, "SUPPORT_REQUEST_PENDING", "A support request is already pending for this workspace.");
    }
    const grant = await repository.getActiveSupportGrant(targetWorkspaceId, identity.userId);
    if (grant) {
      throw new HttpError(409, "SUPPORT_GRANT_ACTIVE", "Support access is already active in this workspace.");
    }
    const requestKey = id("support");
    await audit(
      repository,
      identity,
      targetWorkspaceId,
      {
        action: "support.requested",
        targetType: "support-request",
        targetId: requestKey,
        targetLabel: target.name,
        summary: `${identity.name} requested temporary ${requestedRole} access`,
        metadata: { requestedRole, requestedDurationHours },
      },
      [
        statement(
          db,
          `INSERT INTO support_access_requests
             (id, workspace_id, requester_user_id, requester_email, requester_name,
              requested_role, reason, requested_duration_hours, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          requestKey,
          targetWorkspaceId,
          identity.userId,
          identity.email,
          identity.name,
          requestedRole,
          reason,
          requestedDurationHours,
        ),
      ],
    );
    return { requested: true, requestId: requestKey };
  }
  if (actionName === "cancelSupportRequest") {
    const requestId = textValue(payload.requestId, "Support request", { min: 1, max: 128 });
    const request = await first<{ workspace_id: string; requester_user_id: string; status: string }>(
      db,
      `SELECT workspace_id, requester_user_id, status FROM support_access_requests WHERE id = ? LIMIT 1`,
      requestId,
    );
    if (!request || request.requester_user_id !== identity.userId) {
      throw new HttpError(404, "SUPPORT_REQUEST_NOT_FOUND", "Support request not found.");
    }
    if (request.status !== "pending") {
      throw new HttpError(409, "SUPPORT_REQUEST_NOT_PENDING", "This support request is no longer pending.");
    }
    await audit(
      repository,
      identity,
      request.workspace_id,
      {
        action: "support.cancelled",
        targetType: "support-request",
        targetId: requestId,
        summary: "Support request cancelled by the requester",
      },
      [
        statement(
          db,
          `UPDATE support_access_requests
           SET status = 'cancelled', decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'pending'`,
          identity.userId,
          requestId,
        ),
      ],
    );
    return { cancelled: true };
  }
  if (actionName === "acceptAppointment") {
    const token = textValue(payload.token, "Appointment", { min: 20, max: 8192 });
    const validated = await repository.validateAppointmentCredential(token, signingKey());
    if (validated.appointment.email !== identity.email) {
      throw new HttpError(403, "APPOINTMENT_EMAIL_MISMATCH", "This appointment belongs to another email address.");
    }
    const grant = await repository.getActiveSupportGrant(validated.appointment.workspaceId, identity.userId);
    if (grant) {
      throw new HttpError(403, "APPOINTMENT_SUPPORT_BLOCKED", "Support access cannot accept a permanent administrator appointment.");
    }
    const workspace = await first<{ name: string; status: WorkspaceStatus }>(
      db,
      `SELECT name, status FROM workspaces WHERE id = ?`,
      validated.appointment.workspaceId,
    );
    if (!workspace || workspace.status !== "active") {
      throw new HttpError(409, "WORKSPACE_NOT_ACTIVE", "Only active workspaces accept administrator appointments.");
    }
    const existing = await repository.getWorkspaceAccess(validated.appointment.workspaceId, identity.userId);
    if (existing) {
      throw new HttpError(409, "MEMBERSHIP_EXISTS", "You are already a member of this workspace.");
    }
    await audit(
      repository,
      identity,
      validated.appointment.workspaceId,
      {
        action: "appointment.accepted",
        targetType: "admin-appointment",
        targetId: validated.appointment.id,
        targetLabel: workspace.name,
        summary: `${identity.email} accepted the administrator appointment`,
      },
      [
        statement(db, `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, status, joined_at, updated_at) VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, validated.appointment.workspaceId, identity.userId, identity.email, identity.name),
        statement(db, `INSERT INTO workspace_member_roles (workspace_id, user_id, role, granted_by, granted_at) VALUES (?, ?, 'administrator', ?, CURRENT_TIMESTAMP)`, validated.appointment.workspaceId, identity.userId, identity.userId),
        statement(
          db,
          `UPDATE admin_appointments
           SET status = 'accepted', accepted_by = ?, accepted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'active'`,
          identity.userId,
          validated.appointment.id,
        ),
      ],
    );
    return { workspaceId: validated.appointment.workspaceId };
  }
  if (actionName === "revokeAppointment") {
    requireAuthorized("platform.workspaces.manage", {
      isVerifiedIdentity: true,
      isPlatformAdministrator,
      roles: [],
    });
    const appointmentId = textValue(payload.appointmentId, "Appointment", { min: 1, max: 128 });
    const appointment = await first<{ workspace_id: string; email: string }>(
      db,
      `SELECT workspace_id, email FROM admin_appointments WHERE id = ? AND status = 'active'`,
      appointmentId,
    );
    if (!appointment) throw new HttpError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found.");
    await audit(
      repository,
      identity,
      appointment.workspace_id,
      {
        action: "appointment.revoked",
        targetType: "admin-appointment",
        targetId: appointmentId,
        summary: "Administrator appointment revoked",
      },
      [
        statement(
          db,
          `UPDATE admin_appointments
           SET status = 'revoked', revoked_by = ?, revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'active'`,
          identity.userId,
          appointmentId,
        ),
      ],
    );
    return { revoked: true };
  }
  if (actionName === "updatePlatformSettings") {
    requireAuthorized("platform.settings.manage", {
      isVerifiedIdentity: true,
      isPlatformAdministrator,
      roles: [],
    });
    const limit = integerValue(payload.selfServiceWorkspaceLimit, "Self-serve workspace limit", 0, 1000);
    await repository.setPlatformSetting("selfServiceWorkspaceLimit", limit, identity.userId);
    return { selfServiceWorkspaceLimit: limit };
  }
  if (actionName === "updateTheme") {
    const theme = textValue(payload.theme, "Theme", { min: 4, max: 6 });
    if (!(["light", "dark", "system"] as string[]).includes(theme)) {
      throw new HttpError(400, "THEME_INVALID", "Theme must be light, dark, or system.");
    }
    await run(
      db,
      `INSERT INTO user_preferences (user_id, theme, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, updated_at = CURRENT_TIMESTAMP`,
      identity.userId,
      theme,
    );
    return { theme };
  }
  if (actionName === "redeemInvite") {
    const token = textValue(payload.token, "Invitation", { min: 20, max: 8192 });
    const validated = await repository.validateInvitationCredential(token, signingKey());
    if (validated.claims.email && validated.claims.email !== identity.email) {
      throw new HttpError(403, "INVITATION_EMAIL_MISMATCH", "This invitation belongs to another email address.");
    }
    const supportGrant = await repository.getActiveSupportGrant(
      validated.invitation.workspaceId,
      identity.userId,
    );
    if (supportGrant) {
      throw new HttpError(
        403,
        "INVITATION_SUPPORT_BLOCKED",
        "Temporary support access cannot convert itself into permanent membership.",
      );
    }
    const invitation = validated.invitation;
    const existing = await repository.getWorkspaceAccess(invitation.workspaceId, identity.userId);
    if (!existing) {
      await audit(
        repository,
        identity,
        invitation.workspaceId,
        {
          action: "invitation.accepted",
          targetType: "invitation",
          targetId: invitation.id,
          summary: `${identity.name} accepted an invitation`,
          metadata: { role: invitation.role },
        },
        [
          statement(db, `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, status, joined_at, updated_at) VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, invitation.workspaceId, identity.userId, identity.email, identity.name),
          statement(db, `INSERT INTO workspace_member_roles (workspace_id, user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`, invitation.workspaceId, identity.userId, invitation.role, identity.userId),
          statement(db, `INSERT INTO invite_redemptions (invitation_id, user_id, email, redeemed_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`, invitation.id, identity.userId, identity.email),
        ],
      );
    }
    return { workspaceId: invitation.workspaceId };
  }
  if (actionName === "requestDomainJoin") {
    const workspaceId = textValue(payload.workspaceId, "Workspace", { min: 1, max: 128 });
    const supportGrant = await repository.getActiveSupportGrant(workspaceId, identity.userId);
    if (supportGrant) {
      throw new HttpError(
        403,
        "JOIN_SUPPORT_BLOCKED",
        "Temporary support access cannot request permanent membership.",
      );
    }
    const eligible = await repository.findDomainEligibleWorkspaceIds(identity.email);
    if (!eligible.includes(workspaceId)) {
      throw new HttpError(403, "DOMAIN_NOT_ELIGIBLE", "Your verified email domain is not eligible for this workspace.");
    }
    const requestKey = id("join");
    await audit(
      repository,
      identity,
      workspaceId,
      {
        action: "membership.requested",
        targetType: "join-request",
        targetId: requestKey,
        summary: `${identity.email} requested workspace access`,
      },
      [
        statement(
          db,
          `INSERT INTO join_requests (id, workspace_id, user_id, email, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(workspace_id, user_id) DO UPDATE SET email = excluded.email,
             status = 'pending', decided_by = NULL, decided_at = NULL, updated_at = CURRENT_TIMESTAMP`,
          requestKey,
          workspaceId,
          identity.userId,
          identity.email,
        ),
      ],
    );
    return { requested: true };
  }

  if (actionName === "setWorkspaceStatus") {
    requireAuthorized("platform.workspaces.manage", {
      isVerifiedIdentity: true,
      isPlatformAdministrator,
      roles: [],
    });
    const targetWorkspaceId = textValue(payload.targetWorkspaceId, "Workspace", { min: 1, max: 128 });
    const status = textValue(payload.status, "Status", { min: 6, max: 9 }) as WorkspaceStatus;
    if (!(["active", "suspended", "archived"] as string[]).includes(status)) {
      throw new HttpError(400, "WORKSPACE_STATUS_INVALID", "Workspace status is invalid.");
    }
    const target = await first<{ name: string }>(db, `SELECT name FROM workspaces WHERE id = ?`, targetWorkspaceId);
    if (!target) throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    await audit(
      repository,
      identity,
      targetWorkspaceId,
      {
        action: "workspace.status-changed",
        targetType: "workspace",
        targetId: targetWorkspaceId,
        targetLabel: target.name,
        summary: `${target.name} marked ${status}`,
        metadata: { status },
      },
      [
        statement(db, `UPDATE workspaces SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, status, targetWorkspaceId),
        ...(status === "active"
          ? []
          : [
              statement(db, `UPDATE invitations SET status = 'revoked', revoked_by = ?, revoked_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND status = 'active'`, identity.userId, targetWorkspaceId),
              statement(db, `UPDATE device_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND revoked_at IS NULL`, targetWorkspaceId),
            ]),
      ],
    );
    return { status };
  }
  if (actionName === "assignWorkspaceAdministrator") {
    requireAuthorized("platform.workspaces.manage", {
      isVerifiedIdentity: true,
      isPlatformAdministrator,
      roles: [],
    });
    const targetWorkspaceId = textValue(payload.targetWorkspaceId, "Workspace", { min: 1, max: 128 });
    const email = textValue(payload.email, "Email", { min: 5, max: 320 }).toLowerCase();
    const known = await first<{ user_id: string; display_name: string | null }>(
      db,
      `SELECT user_id, display_name FROM workspace_members WHERE email = ?
       UNION SELECT user_id, NULL AS display_name FROM join_requests WHERE email = ? LIMIT 1`,
      email,
      email,
    );
    if (!known) {
      throw new HttpError(409, "ACCOUNT_NOT_KNOWN", "Ask this verified account to request access or join another workspace first.");
    }
    await audit(
      repository,
      identity,
      targetWorkspaceId,
      {
        action: "workspace.permission-changed",
        targetType: "member",
        targetId: known.user_id,
        targetLabel: email,
        summary: `${email} assigned as workspace administrator`,
        metadata: { role: "administrator" },
      },
      [
        statement(db, `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, status, joined_at, updated_at) VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(workspace_id, user_id) DO UPDATE SET email = excluded.email, display_name = COALESCE(excluded.display_name, workspace_members.display_name), status = 'active', updated_at = CURRENT_TIMESTAMP`, targetWorkspaceId, known.user_id, email, known.display_name),
        statement(db, `INSERT OR IGNORE INTO workspace_member_roles (workspace_id, user_id, role, granted_by, granted_at) VALUES (?, ?, 'administrator', ?, CURRENT_TIMESTAMP)`, targetWorkspaceId, known.user_id, identity.userId),
      ],
    );
    return { assigned: true };
  }

  const workspaceId = textValue(payload.workspaceId, "Workspace", { min: 1, max: 128 });
  const access = await requireWorkspace(repository, identity, workspaceId, isPlatformAdministrator);
  const context = policyContext(access, isPlatformAdministrator);
  const supportGrant = access.supportGrant
    ? await repository.getActiveSupportGrant(workspaceId, identity.userId)
    : null;

  if (actionName === "resolveSupportRequest") {
    requireAuthorized("workspace.support.decide", context);
    const requestId = textValue(payload.requestId, "Support request", { min: 1, max: 128 });
    const approve = booleanValue(payload.approve, "Decision");
    const request = await first<SupportRequestRow>(
      db,
      `SELECT id, requester_user_id, requester_email, requester_name, requested_role,
              requested_duration_hours, status, workspace_id
       FROM support_access_requests WHERE id = ? AND workspace_id = ?`,
      requestId,
      workspaceId,
    );
    if (!request || request.status !== "pending") {
      throw new HttpError(409, "SUPPORT_REQUEST_UNAVAILABLE", "This support request is no longer pending.");
    }
    if (!approve) {
      await audit(
        repository,
        identity,
        workspaceId,
        {
          action: "support.denied",
          targetType: "support-request",
          targetId: requestId,
          targetLabel: request.requester_email,
          summary: `${request.requester_email} support request denied`,
          metadata: { requestedRole: request.requested_role },
        },
        [
          statement(
            db,
            `UPDATE support_access_requests
             SET status = 'denied', decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'pending'`,
            identity.userId,
            requestId,
          ),
        ],
      );
      return { approved: false };
    }
    const grantedRole = textValue(
      payload.grantedRole ?? request.requested_role,
      "Granted role",
      { min: 4, max: 13 },
    ) as WorkspaceRole;
    if (!(["administrator", "creator", "reviewer", "publisher", "viewer"] as string[]).includes(grantedRole)) {
      throw new HttpError(400, "SUPPORT_ROLE_INVALID", "The granted role is invalid.");
    }
    const grantedDurationHours = integerValue(
      payload.grantedDurationHours ?? request.requested_duration_hours,
      "Granted duration",
      1,
      168,
    );
    if (grantedRole === "administrator") {
      // A customer administrator may approve administrator-level support, but
      // the approval must be an explicit, separate decision from the request.
      const explicit = booleanValue(payload.explicitAdministrator, "Administrator approval");
      if (!explicit) {
        throw new HttpError(400, "SUPPORT_ADMIN_CONFIRM_REQUIRED", "Confirm administrator-level access explicitly.");
      }
    }
    const grantId = id("grant");
    const expiresAt = new Date(
      Date.now() + grantedDurationHours * 3600 * 1000,
    ).toISOString();
    const statements = [
      statement(
        db,
        `UPDATE support_access_requests
         SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
             granted_role = ?, grant_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`,
        identity.userId,
        grantedRole,
        grantId,
        requestId,
      ),
      statement(
        db,
        `INSERT INTO support_access_grants
           (id, request_id, workspace_id, user_id, email, display_name, role,
            status, approved_by, granted_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP, ?)`,
        grantId,
        requestId,
        workspaceId,
        request.requester_user_id,
        request.requester_email,
        request.requester_name,
        grantedRole,
        identity.userId,
        expiresAt,
      ),
    ];
    await audit(repository, identity, workspaceId, {
      action: "support.approved",
      targetType: "support-grant",
      targetId: grantId,
      targetLabel: request.requester_email,
      summary: `${request.requester_email} granted temporary ${grantedRole} access`,
      metadata: {
        requestedRole: request.requested_role,
        grantedRole,
        requestedDurationHours: request.requested_duration_hours,
        grantedDurationHours,
        expiresAt,
      },
    }, statements);
    return { approved: true, grantId };
  }
  if (actionName === "revokeSupportAccess") {
    const grantId = textValue(payload.grantId, "Support grant", { min: 1, max: 128 });
    const grant = await first<SupportGrantRow>(
      db,
      `SELECT id, user_id, email, status, workspace_id FROM support_access_grants
       WHERE id = ? AND workspace_id = ?`,
      grantId,
      workspaceId,
    );
    if (!grant) throw new HttpError(404, "SUPPORT_GRANT_NOT_FOUND", "Support grant not found.");
    const holder = grant.user_id === identity.userId;
    if (holder) {
      // Grant holders may always revoke their own temporary access.
      requireAuthorized("workspace.read", context);
    } else {
      requireAuthorized("workspace.support.revoke", context);
    }
    if (grant.status !== "active") {
      throw new HttpError(409, "SUPPORT_GRANT_NOT_ACTIVE", "This support grant is not active.");
    }
    await audit(
      repository,
      identity,
      workspaceId,
      {
        action: "support.revoked",
        targetType: "support-grant",
        targetId: grantId,
        targetLabel: grant.email,
        summary: `${grant.email} temporary access revoked`,
        metadata: { revokedBy: holder ? "grant-holder" : "workspace-administrator" },
      },
      [
        statement(
          db,
          `UPDATE support_access_grants
           SET status = 'revoked', ended_at = CURRENT_TIMESTAMP, revoked_by = ?
           WHERE id = ? AND status = 'active'`,
          identity.userId,
          grantId,
        ),
        statement(
          db,
          `UPDATE invitations
           SET status = 'revoked', revoked_by = ?, revoked_at = CURRENT_TIMESTAMP
           WHERE workspace_id = ? AND created_by = ? AND created_via = 'support-access'
             AND status = 'active'`,
          identity.userId,
          workspaceId,
          grant.user_id,
        ),
      ],
    );
    return { revoked: true };
  }
  if (actionName === "sweepExpiredSupportAccess") {
    requireAuthorized("workspace.audit.read", context);
    const expired = await repository.expireSupportGrants();
    const expiredHere = expired.filter((item) => item.workspaceId === workspaceId);
    for (const grant of expiredHere) {
      await audit(repository, identity, workspaceId, {
        action: "support.expired",
        targetType: "support-grant",
        targetId: grant.id,
        targetLabel: grant.email,
        summary: `${grant.email} temporary access expired`,
        metadata: { role: grant.role, expiresAt: grant.expiresAt },
      });
    }
    return { expired: expiredHere.length };
  }
  if (actionName === "updateAllowedDomains") {
    requireAuthorized("workspace.domains.manage", context);
    const domains = [
      ...new Set(
        stringList(payload.allowedDomains, "Allowed domains", 100).map((item) =>
          item.toLowerCase(),
        ),
      ),
    ];
    for (const domain of domains) {
      if (extractExactEmailDomain(`owner@${domain}`) !== domain) {
        throw new HttpError(400, "DOMAIN_INVALID", `${domain} is not an exact valid email domain.`);
      }
    }
    await audit(
      repository,
      identity,
      workspaceId,
      {
        action: "workspace.domains-updated",
        targetType: "workspace",
        targetId: workspaceId,
        summary: "Approved email domains updated",
        metadata: { domainCount: domains.length },
      },
      [
        statement(db, `DELETE FROM workspace_domains WHERE workspace_id = ?`, workspaceId),
        statement(
          db,
          `INSERT INTO workspace_domains
             (id, workspace_id, domain_ascii, enabled, created_by, created_at)
           SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.domain'), 1, ?, CURRENT_TIMESTAMP
           FROM json_each(?)`,
          workspaceId,
          identity.userId,
          JSON.stringify(domains.map((domain) => ({ id: id("domain"), domain }))),
        ),
      ],
    );
    return { saved: true };
  }

  if (actionName === "updateWorkspaceSettings") {
    requireAuthorized("workspace.settings.manage", context);
    const settingsPayload = asObject(payload.settings, "Settings");
    const currentLogo = await first<{ logo_object_key: string | null }>(
      db,
      `SELECT logo_object_key FROM workspace_settings WHERE workspace_id = ?`,
      workspaceId,
    );
    const requestedLogo =
      typeof settingsPayload.logoUrl === "string"
        ? textValue(settingsPayload.logoUrl, "Workspace logo", { max: 512 }) || null
        : null;
    if (requestedLogo !== null && requestedLogo !== currentLogo?.logo_object_key) {
      throw new HttpError(400, "LOGO_REFERENCE_INVALID", "Upload the workspace logo before selecting it.");
    }
    const accentColor = textValue(settingsPayload.accentColor, "Accent color", { min: 7, max: 7 });
    const clickTargetColor = textValue(settingsPayload.clickTargetColor, "Click target color", { min: 7, max: 7 });
    if (!/^#[0-9a-f]{6}$/i.test(accentColor) || !/^#[0-9a-f]{6}$/i.test(clickTargetColor)) {
      throw new HttpError(400, "COLOR_INVALID", "Use six-digit hexadecimal colors.");
    }
    const excludedHosts = stringList(settingsPayload.excludedCaptureHosts, "Excluded hosts", 200).map((item) => item.toLowerCase());
    for (const host of excludedHosts) {
      try {
        const parsed = new URL(`https://${host}`);
        if (parsed.hostname !== host || parsed.pathname !== "/") throw new Error("invalid");
      } catch {
        throw new HttpError(400, "CAPTURE_HOST_INVALID", `${host} is not a valid hostname.`);
      }
    }
    const statements: D1PreparedStatementLike[] = [
      statement(
        db,
        `UPDATE workspace_settings SET logo_object_key = ?, accent_color = ?, click_target_color = ?,
          remove_branding = ?, restricted_exports_enabled = ?, watermark_restricted_exports = ?,
          capture_policy_json = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?`,
        requestedLogo,
        accentColor,
        clickTargetColor,
        booleanValue(settingsPayload.removeBranding, "Remove branding") ? 1 : 0,
        booleanValue(settingsPayload.allowRestrictedExports, "Restricted exports") ? 1 : 0,
        booleanValue(settingsPayload.watermarkExports, "Watermarks") ? 1 : 0,
        JSON.stringify({ excludedHosts }),
        workspaceId,
      ),
    ];
    await audit(repository, identity, workspaceId, {
      action: "workspace.settings-updated",
      targetType: "workspace",
      targetId: workspaceId,
      summary: "Workspace branding and capture policies updated",
      metadata: { excludedHostCount: excludedHosts.length },
    }, statements);
    return { saved: true };
  }

  if (actionName === "saveGroup") {
    requireAuthorized("workspace.groups.manage", context);
    const groupId = typeof payload.id === "string" ? textValue(payload.id, "Group", { min: 1, max: 128 }) : id("group");
    const name = textValue(payload.name, "Group name", { min: 2, max: 120 });
    const description = textValue(payload.description ?? "", "Description", { max: 1000 });
    const sensitive = booleanValue(payload.sensitive, "Sensitive group");
    const memberIds = [...new Set(stringList(payload.memberIds, "Group members", 500))];
    if (memberIds.length) {
      const validMembers = await rows<{ user_id: string }>(
        db,
        `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND status = 'active'
         AND user_id IN (SELECT value FROM json_each(?))`,
        workspaceId,
        JSON.stringify(memberIds),
      );
      if (validMembers.length !== memberIds.length) throw new HttpError(400, "GROUP_MEMBER_INVALID", "Every group member must be active in this workspace.");
    }
    const existing = await first<{ kind: string }>(db, `SELECT kind FROM groups WHERE id = ? AND workspace_id = ?`, groupId, workspaceId);
    if (existing?.kind === "all_members") throw new HttpError(409, "SYSTEM_GROUP_LOCKED", "All Employees is managed automatically.");
    const statements: D1PreparedStatementLike[] = [
      existing
        ? statement(db, `UPDATE groups SET name = ?, slug = ?, description = ?, sensitive = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?`, name, `${slug(name)}-${groupId.slice(-6)}`, description, sensitive ? 1 : 0, groupId, workspaceId)
        : statement(db, `INSERT INTO groups (id, workspace_id, name, slug, description, sensitive, kind, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'custom', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, groupId, workspaceId, name, `${slug(name)}-${groupId.slice(-6)}`, description, sensitive ? 1 : 0, identity.userId),
      statement(db, `DELETE FROM group_members WHERE group_id = ? AND workspace_id = ?`, groupId, workspaceId),
      statement(
        db,
        `INSERT INTO group_members (group_id, workspace_id, user_id, added_by, added_at)
         SELECT ?, ?, value, ?, CURRENT_TIMESTAMP FROM json_each(?)`,
        groupId,
        workspaceId,
        identity.userId,
        JSON.stringify(memberIds),
      ),
    ];
    await audit(repository, identity, workspaceId, {
      action: existing ? "group.updated" : "group.created",
      targetType: "group",
      targetId: groupId,
      targetLabel: name,
      summary: `${name} ${existing ? "updated" : "created"}`,
      metadata: { sensitive, memberCount: memberIds.length },
    }, statements);
    return { groupId };
  }

  if (actionName === "deleteGroup") {
    requireAuthorized("workspace.groups.manage", context);
    const groupId = textValue(payload.groupId, "Group", { min: 1, max: 128 });
    const group = await first<{ name: string; kind: string }>(db, `SELECT name, kind FROM groups WHERE id = ? AND workspace_id = ?`, groupId, workspaceId);
    if (!group) throw new HttpError(404, "GROUP_NOT_FOUND", "Group not found.");
    if (group.kind === "all_members") throw new HttpError(409, "SYSTEM_GROUP_LOCKED", "All Employees cannot be deleted.");
    const used = await first<{ matched: number }>(db, `SELECT 1 AS matched FROM guide_audiences ga JOIN guide_revisions gr ON gr.id = ga.revision_id WHERE gr.workspace_id = ? AND ga.subject_type = 'group' AND ga.subject_id = ? LIMIT 1`, workspaceId, groupId);
    if (used) throw new HttpError(409, "GROUP_IN_USE", "Remove this group from guide audiences before deleting it.");
    await audit(repository, identity, workspaceId, { action: "group.deleted", targetType: "group", targetId: groupId, targetLabel: group.name, summary: `${group.name} deleted` }, [statement(db, `DELETE FROM groups WHERE id = ? AND workspace_id = ?`, groupId, workspaceId)]);
    return { deleted: true };
  }

  if (actionName === "createInvite") {
    requireAuthorized("workspace.invitations.manage", context);
    const role = textValue(payload.role, "Role", { min: 6, max: 9 }) as Exclude<WorkspaceRole, "administrator">;
    if (!(["creator", "reviewer", "publisher", "viewer"] as string[]).includes(role)) throw new HttpError(400, "INVITE_ROLE_INVALID", "Invitation role is invalid.");
    const expiresInHours = integerValue(payload.expiresInHours, "Expiration", 1, 24 * 90);
    const maxUses = supportGrant ? 1 : integerValue(payload.maxUses, "Maximum uses", 1, 100);
    const email =
      typeof payload.email === "string" && payload.email.trim()
        ? payload.email.trim().toLowerCase()
        : undefined;
    if (email !== undefined && (email.length > 320 || extractExactEmailDomain(email) === null)) {
      throw new HttpError(400, "INVITE_EMAIL_INVALID", "The invitation email is invalid.");
    }
    const invitationId = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const expiresAtSeconds = supportGrant
      ? Math.min(
          Math.floor(Date.parse(supportGrant.expiresAt) / 1000),
          Math.floor(Date.now() / 1000) + expiresInHours * 3600,
        )
      : Math.floor(Date.now() / 1000) + expiresInHours * 3600;
    const token = await signInviteToken({ jti: invitationId, workspaceId, expiresAt: expiresAtSeconds, role, ...(email ? { email } : {}) }, signingKey());
    const tokenHash = await hashToken(token);
    const label = textValue(payload.label ?? "Invite link", "Label", { max: 160 }) || "Invite link";
    await audit(repository, identity, workspaceId, {
      action: "invitation.created",
      targetType: "invitation",
      targetId: invitationId,
      targetLabel: label,
      summary: `${label} invitation created`,
      metadata: {
        role,
        maxUses,
        expiresInHours,
        ...(email ? { emailScoped: true } : {}),
        ...(supportGrant ? { via: "support-access", grantId: supportGrant.id } : {}),
      },
    }, [statement(db, `INSERT INTO invitations (id, workspace_id, token_hash, label, email, role, status, max_uses, use_count, expires_at, created_by, created_via, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?, CURRENT_TIMESTAMP)`, invitationId, workspaceId, tokenHash, label, email ?? null, role, maxUses, new Date(expiresAtSeconds * 1000).toISOString(), identity.userId, supportGrant ? "support-access" : "standard")]);
    return { token };
  }

  if (actionName === "revokeInvite") {
    requireAuthorized("workspace.invitations.manage", context);
    const invitationId = textValue(payload.invitationId, "Invitation", { min: 1, max: 128 });
    await audit(repository, identity, workspaceId, { action: "invitation.revoked", targetType: "invitation", targetId: invitationId, summary: "Invitation revoked" }, [statement(db, `UPDATE invitations SET status = 'revoked', revoked_by = ?, revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ? AND status = 'active'`, identity.userId, invitationId, workspaceId)]);
    return { revoked: true };
  }

  if (actionName === "resolveJoinRequest") {
    requireAuthorized("workspace.members.manage", context);
    const joinRequestId = textValue(payload.joinRequestId, "Join request", { min: 1, max: 128 });
    const approve = booleanValue(payload.approve, "Decision");
    const join = await first<{ user_id: string; email: string; status: string }>(db, `SELECT user_id, email, status FROM join_requests WHERE id = ? AND workspace_id = ?`, joinRequestId, workspaceId);
    if (!join || join.status !== "pending") throw new HttpError(409, "JOIN_REQUEST_UNAVAILABLE", "This join request is no longer pending.");
    if (approve && join.user_id === identity.userId) {
      throw new HttpError(403, "JOIN_SELF_APPROVAL_BLOCKED", "You cannot approve your own join request.");
    }
    const statements = [
      statement(db, `UPDATE join_requests SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, approve ? "approved" : "denied", identity.userId, joinRequestId),
      ...(approve
        ? [
            statement(db, `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, status, joined_at, updated_at) VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(workspace_id, user_id) DO UPDATE SET status = 'active', email = excluded.email, updated_at = CURRENT_TIMESTAMP`, workspaceId, join.user_id, join.email, join.email.split("@")[0]),
            statement(db, `INSERT OR IGNORE INTO workspace_member_roles (workspace_id, user_id, role, granted_by, granted_at) VALUES (?, ?, 'viewer', ?, CURRENT_TIMESTAMP)`, workspaceId, join.user_id, identity.userId),
          ]
        : []),
    ];
    await audit(repository, identity, workspaceId, { action: approve ? "membership.approved" : "membership.denied", targetType: "join-request", targetId: joinRequestId, targetLabel: join.email, summary: `${join.email} ${approve ? "approved as a viewer" : "denied workspace access"}` }, statements);
    return { approved: approve };
  }

  if (actionName === "updateMember") {
    requireAuthorized("workspace.members.manage", context);
    const memberId = textValue(payload.memberId, "Member", { min: 1, max: 300 });
    const userId = memberId.includes(":") ? memberId.slice(memberId.indexOf(":") + 1) : memberId;
    const roles = [...new Set(stringList(payload.roles, "Roles", 5))] as WorkspaceRole[];
    if (!roles.length || roles.some((role) => !(["administrator", "creator", "reviewer", "publisher", "viewer"] as string[]).includes(role))) throw new HttpError(400, "MEMBER_ROLES_INVALID", "Select at least one valid role.");
    const capabilities = [
      ...new Set(stringList(payload.capabilities ?? [], "Capabilities", 1)),
    ] as Array<"vault">;
    if (capabilities.some((capability) => capability !== "vault")) {
      throw new HttpError(400, "MEMBER_CAPABILITIES_INVALID", "Member capabilities are invalid.");
    }
    const status = textValue(payload.status, "Member status", { min: 6, max: 9 });
    if (!(["active", "suspended"] as string[]).includes(status)) throw new HttpError(400, "MEMBER_STATUS_INVALID", "Member status is invalid.");
    const member = await first<{ email: string }>(db, `SELECT email FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, workspaceId, userId);
    if (!member) throw new HttpError(404, "MEMBER_NOT_FOUND", "Member not found.");
    const adminCount = await first<{ count: number }>(db, `SELECT COUNT(*) AS count FROM workspace_member_roles r JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.user_id = r.user_id WHERE r.workspace_id = ? AND r.role = 'administrator' AND m.status = 'active'`, workspaceId);
    const currentlyAdmin = await first<{ matched: number }>(db, `SELECT 1 AS matched FROM workspace_member_roles WHERE workspace_id = ? AND user_id = ? AND role = 'administrator'`, workspaceId, userId);
    if (currentlyAdmin && Number(adminCount?.count ?? 0) <= 1 && (status !== "active" || !roles.includes("administrator"))) throw new HttpError(409, "LAST_ADMIN_REQUIRED", "Assign another administrator before changing the last active administrator.");
    const statements: D1PreparedStatementLike[] = [
      statement(db, `UPDATE workspace_members SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND user_id = ?`, status, workspaceId, userId),
      statement(db, `UPDATE device_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND user_id = ? AND revoked_at IS NULL`, workspaceId, userId),
      statement(
         db,
         `DELETE FROM workspace_member_roles
          WHERE workspace_id = ? AND user_id = ?
            AND role NOT IN (SELECT value FROM json_each(?))`,
         workspaceId,
         userId,
         JSON.stringify(roles),
       ),
      statement(
        db,
        `INSERT OR IGNORE INTO workspace_member_roles
           (workspace_id, user_id, role, granted_by, granted_at)
         SELECT ?, ?, value, ?, CURRENT_TIMESTAMP FROM json_each(?)`,
        workspaceId,
        userId,
        identity.userId,
        JSON.stringify(roles),
      ),
      statement(
        db,
        `DELETE FROM workspace_member_capabilities
         WHERE workspace_id = ? AND user_id = ?
           AND capability NOT IN (SELECT value FROM json_each(?))`,
        workspaceId,
        userId,
        JSON.stringify(capabilities),
      ),
      statement(
        db,
        `INSERT OR IGNORE INTO workspace_member_capabilities
           (workspace_id, user_id, capability, granted_by, granted_at)
         SELECT ?, ?, value, ?, CURRENT_TIMESTAMP FROM json_each(?)`,
        workspaceId,
        userId,
        identity.userId,
        JSON.stringify(capabilities),
      ),
    ];
    await audit(repository, identity, workspaceId, { action: "membership.changed", targetType: "member", targetId: userId, targetLabel: member.email, summary: `${member.email} membership updated`, metadata: { status, roles: roles.join(","), capabilities: capabilities.join(",") } }, statements);
    return { updated: true };
  }

  if (actionName === "saveVaultItem") {
    requireAuthorized("vault.use", context);
    const suppliedId = typeof payload.id === "string"
      ? textValue(payload.id, "Vault item", { min: 1, max: 128 })
      : null;
    if (suppliedId && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(suppliedId)) {
      throw new HttpError(400, "VAULT_ITEM_INVALID", "The vault item identifier is invalid.");
    }
    const vaultItemId = suppliedId ?? id("vault");
    const title = textValue(payload.title, "Vault item title", { min: 2, max: 160 });
    const encryptedEnvelopeJson = validateVaultEnvelopeJson(payload.encryptedEnvelopeJson);
    const metadataJson = validateVaultMetadataJson(payload.metadataJson);
    const existing = await first<{ title: string }>(
      db,
      `SELECT title FROM vault_items WHERE id = ? AND workspace_id = ?`,
      vaultItemId,
      workspaceId,
    );
    if (suppliedId && !existing) {
      throw new HttpError(404, "VAULT_ITEM_NOT_FOUND", "Vault item not found.");
    }
    await audit(
      repository,
      identity,
      workspaceId,
      {
        action: existing ? "vault.item-updated" : "vault.item-created",
        targetType: "vault-item",
        targetId: vaultItemId,
        targetLabel: title,
        summary: `${title} encrypted vault item ${existing ? "updated" : "created"}`,
      },
      [
        existing
          ? statement(
              db,
              `UPDATE vault_items SET title = ?, encrypted_envelope_json = ?,
                 metadata_json = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND workspace_id = ?`,
              title,
              encryptedEnvelopeJson,
              metadataJson,
              vaultItemId,
              workspaceId,
            )
          : statement(
              db,
              `INSERT INTO vault_items
                 (id, workspace_id, title, encrypted_envelope_json, metadata_json,
                  created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              vaultItemId,
              workspaceId,
              title,
              encryptedEnvelopeJson,
              metadataJson,
              identity.userId,
            ),
      ],
    );
    return { vaultItemId };
  }

  if (actionName === "deleteVaultItem") {
    requireAuthorized("vault.use", context);
    const vaultItemId = textValue(payload.vaultItemId, "Vault item", {
      min: 1,
      max: 128,
    });
    const existing = await first<{ title: string }>(
      db,
      `SELECT title FROM vault_items WHERE id = ? AND workspace_id = ?`,
      vaultItemId,
      workspaceId,
    );
    if (!existing) throw new HttpError(404, "VAULT_ITEM_NOT_FOUND", "Vault item not found.");
    await audit(
      repository,
      identity,
      workspaceId,
      {
        action: "vault.item-deleted",
        targetType: "vault-item",
        targetId: vaultItemId,
        targetLabel: existing.title,
        summary: `${existing.title} encrypted vault item deleted`,
      },
      [
        statement(
          db,
          `DELETE FROM vault_items WHERE id = ? AND workspace_id = ?`,
          vaultItemId,
          workspaceId,
        ),
      ],
    );
    return { deleted: true };
  }

  if (actionName === "createPairingCode") {
    requireAuthorized("capture.create", context);
    const code = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte % 32]).join("");
    const tokenId = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const codeHash = await hashToken(code);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await audit(repository, identity, workspaceId, { action: "capture.pairing-created", targetType: "device-token", targetId: tokenId, summary: "One-time extension pairing code created" }, [statement(db, `INSERT INTO device_tokens (id, workspace_id, user_id, device_id, token_hash, scopes_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, tokenId, workspaceId, identity.userId, `pair:${code.slice(0, 4)}`, codeHash, JSON.stringify(["capture:write", "media:write"]), expiresAt)]);
    return { code, expiresAt };
  }

  if (actionName === "revokeCaptureDevices") {
    requireAuthorized("capture.create", context);
    await audit(
      repository,
      identity,
      workspaceId,
      {
        action: "capture.devices-revoked",
        targetType: "device-token",
        targetId: identity.userId,
        summary: "All paired browser capture credentials revoked",
      },
      [
        statement(
          db,
          "UPDATE device_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND user_id = ? AND revoked_at IS NULL",
          workspaceId,
          identity.userId,
        ),
      ],
    );
    return { revoked: true };
  }

  if (actionName === "saveGuide") {
    const guideId = typeof payload.guideId === "string" ? textValue(payload.guideId, "Guide", { min: 1, max: 128 }) : id("guide");
    const existing = await first<{ author_user_id: string; working_draft_revision_id: string | null; current_published_revision_id: string | null; archived_at: string | null; screenshots_locked_at: string | null }>(db, `SELECT author_user_id, working_draft_revision_id, current_published_revision_id, archived_at, screenshots_locked_at FROM guides WHERE id = ? AND workspace_id = ?`, guideId, workspaceId);
    if (existing?.archived_at) throw new HttpError(409, "GUIDE_ARCHIVED", "Restore an archived revision before editing it.");
    const title = textValue(payload.title, "Guide title", { min: 3, max: 500 });
    const summary = textValue(payload.summary, "Guide summary", { min: 1, max: 5000 });
    const category = textValue(payload.category ?? "", "Category", { max: 200 });
    const tags = stringList(payload.tags, "Tags", 50);
    const systems = stringList(payload.systemReferences, "Systems", 50);
    let blocks = normalizeBlocks(payload.steps);
    const audiences = normalizeAudiences(payload.audiences, workspaceId);
    const source = payload.source === "browser-capture" ? "browser-capture" : "manual";
    const privacyReviewed = booleanValue(payload.privacyReviewed, "Privacy review");
    const transition = payload.transition === "review" ? "review" : "draft";
    const screenshotsLocked = Boolean(existing?.screenshots_locked_at);
    const firstReviewSubmission = !screenshotsLocked && transition === "review";
    const hasUnappliedRedaction = blocks.some((block) =>
      (block.redactions ?? []).some((region) => !region.applied),
    );
    if (screenshotsLocked && hasUnappliedRedaction) {
      throw new HttpError(
        409,
        "SCREENSHOTS_LOCKED",
        "This guide's screenshots were locked at its first review and can no longer have reversible redactions.",
      );
    }
    if (firstReviewSubmission && hasUnappliedRedaction) {
      throw new HttpError(
        409,
        "REDACTIONS_NOT_FLATTENED",
        "Flatten every redaction into its screenshot before requesting the first review.",
      );
    }
    const settings = await loadSettings(db, workspaceId);
    const revisionId = existing?.working_draft_revision_id ?? id("revision");
    let version = 1;
    let createdAt = nowIso();
    let createRevision = !existing?.working_draft_revision_id;
    if (existing) {
      if (existing.working_draft_revision_id) {
        const facts = await repository.getGuideAccessFacts(workspaceId, guideId, identity.userId, existing.working_draft_revision_id);
        if (!facts) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
        requireAuthorized("guide.update", policyContext(access, isPlatformAdministrator, facts));
        const current = await first<{ version: number; created_at: string; status: string }>(db, `SELECT version, created_at, status FROM guide_revisions WHERE id = ?`, revisionId);
        if (!current || current.status !== "draft") throw new HttpError(409, "DRAFT_NOT_EDITABLE", "Only a draft revision can be edited.");
        version = current.version;
        createdAt = current.created_at;
        createRevision = false;
      } else {
        const mayCreateDraft = access.roles.includes("administrator") || (access.roles.includes("creator") && existing.author_user_id === identity.userId);
        if (!mayCreateDraft) throw new HttpError(403, "DRAFT_EDITOR_REQUIRED", "You cannot create a draft for this guide.");
        const maxVersion = await first<{ version: number }>(db, `SELECT COALESCE(MAX(version), 0) AS version FROM guide_revisions WHERE guide_id = ?`, guideId);
        version = Number(maxVersion?.version ?? 0) + 1;
      }
    } else {
      requireAuthorized("guide.create", context);
    }
    const referencedMediaIds = [
      ...new Set(
        blocks
          .map((block) => block.screenshotMediaId)
          .filter((mediaId): mediaId is string => Boolean(mediaId)),
      ),
    ];
    const inheritedMedia: Array<{
      id: string;
      stepId: string | null;
      objectKey: string;
      contentType: "image/png" | "image/jpeg" | "image/webp";
      byteSize: number;
      width: number;
      height: number;
      sha256: string;
      redactionState: "pending" | "redacted";
    }> = [];
    const clonedObjectKeys: string[] = [];
    const cleanupInheritedMedia = async () => {
      if (!clonedObjectKeys.length) return;
      const bucket = requireR2Binding(env.MEDIA);
      for (const objectKey of clonedObjectKeys) {
        await deletePrivateMedia(bucket, objectKey, workspaceId).catch(() => undefined);
      }
    };
    if (referencedMediaIds.length) {
      const sourceRevisionId = existing
        ? createRevision
          ? existing.current_published_revision_id
          : revisionId
        : null;
      if (!sourceRevisionId) {
        throw new HttpError(
          409,
          "SCREENSHOT_REFERENCE_INVALID",
          "Save the guide before attaching a private screenshot.",
        );
      }
      const sourceMedia = await rows<{
        id: string;
        object_key: string;
        content_type: "image/png" | "image/jpeg" | "image/webp";
        byte_size: number;
        width: number;
        height: number;
        sha256: string;
      }>(
        db,
        `SELECT id, object_key, content_type, byte_size, width, height, sha256
         FROM guide_media
         WHERE workspace_id = ? AND revision_id = ?
           AND id IN (SELECT value FROM json_each(?))`,
        workspaceId,
        sourceRevisionId,
        JSON.stringify(referencedMediaIds),
      );
      const sourceMediaById = new Map(sourceMedia.map((media) => [media.id, media]));
      if (
        sourceMediaById.size !== referencedMediaIds.length ||
        referencedMediaIds.some((mediaId) => !sourceMediaById.has(mediaId))
      ) {
        throw new HttpError(
          409,
          "SCREENSHOT_REFERENCE_INVALID",
          "Each screenshot must belong to the guide revision being saved.",
        );
      }
      if (existing && createRevision) {
        try {
          const bucket = requireR2Binding(env.MEDIA);
          const clonedBySourceId = new Map<
            string,
            { id: string; objectKey: string; redactionState: "pending" | "redacted" }
          >();
          for (const sourceMediaId of referencedMediaIds) {
            const sourceMediaRow = sourceMediaById.get(sourceMediaId)!;
            const cloned = await clonePrivateMedia(bucket, {
              sourceObjectKey: sourceMediaRow.object_key,
              workspaceId,
              revisionId,
              uploadedBy: identity.userId,
            });
            clonedObjectKeys.push(cloned.objectKey);
            clonedBySourceId.set(sourceMediaId, {
              id: id("media"),
              objectKey: cloned.objectKey,
              redactionState: cloned.redactionState,
            });
          }
          blocks = blocks.map((block) => {
            if (!block.screenshotMediaId) return block;
            const cloned = clonedBySourceId.get(block.screenshotMediaId)!;
            return { ...block, screenshotMediaId: cloned.id };
          });
          for (const sourceMediaId of referencedMediaIds) {
            const sourceMediaRow = sourceMediaById.get(sourceMediaId)!;
            const cloned = clonedBySourceId.get(sourceMediaId)!;
            const stepPosition = blocks.findIndex(
              (block) => block.screenshotMediaId === cloned.id,
            );
            inheritedMedia.push({
              id: cloned.id,
              stepId: stepPosition >= 0 ? `step_${revisionId}_${stepPosition}` : null,
              objectKey: cloned.objectKey,
              contentType: sourceMediaRow.content_type,
              byteSize: sourceMediaRow.byte_size,
              width: sourceMediaRow.width,
              height: sourceMediaRow.height,
              sha256: sourceMediaRow.sha256,
              redactionState: cloned.redactionState,
            });
          }
        } catch (error) {
          await cleanupInheritedMedia();
          throw error;
        }
      }
    }
    try {
      const branding: WorkspaceBranding = {
      workspaceId,
      workspaceName: access.workspaceName,
      ...(settings.logoUrl ? { logoMediaId: settings.logoUrl } : {}),
      accentColor: settings.accentColor,
      clickTargetColor: settings.clickTargetColor,
      showKnowHowBranding: !settings.removeBranding,
      };
      validateCanonicalRevision({ guideId, revisionId, workspaceId, version, lifecycle: transition, source, title, summary, createdAt, identity, blocks, audiences, privacyReviewed, branding });
      const statements: D1PreparedStatementLike[] = [];
    if (!existing) {
      statements.push(statement(db, `INSERT INTO guides (id, workspace_id, title, slug, author_user_id, working_draft_revision_id, screenshots_locked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, guideId, workspaceId, title, `${slug(title)}-${guideId.slice(-6)}`, identity.userId, revisionId, firstReviewSubmission ? nowIso() : null));
    } else if (createRevision) {
      statements.push(statement(db, `UPDATE guides SET working_draft_revision_id = ?, title = ?, screenshots_locked_at = COALESCE(screenshots_locked_at, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?`, revisionId, title, firstReviewSubmission ? nowIso() : null, guideId, workspaceId));
    } else {
      statements.push(statement(db, `UPDATE guides SET title = ?, screenshots_locked_at = COALESCE(screenshots_locked_at, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?`, title, firstReviewSubmission ? nowIso() : null, guideId, workspaceId));
    }
    if (createRevision) {
      statements.push(statement(db, `INSERT INTO guide_revisions (id, guide_id, workspace_id, version, status, source_type, title, summary, category, tags_json, system_references_json, privacy_reviewed_at, privacy_reviewed_by, created_by, submitted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, revisionId, guideId, workspaceId, version, transition, source === "browser-capture" ? "capture" : "manual", title, summary, category || null, JSON.stringify(tags), JSON.stringify(systems), privacyReviewed && source === "browser-capture" ? nowIso() : null, privacyReviewed && source === "browser-capture" ? identity.userId : null, identity.userId, transition === "review" ? nowIso() : null, createdAt, nowIso()));
    } else {
      statements.push(statement(db, `UPDATE guide_revisions SET status = ?, title = ?, summary = ?, category = ?, tags_json = ?, system_references_json = ?, privacy_reviewed_at = ?, privacy_reviewed_by = ?, submitted_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ? AND status = 'draft'`, transition, title, summary, category || null, JSON.stringify(tags), JSON.stringify(systems), privacyReviewed && source === "browser-capture" ? nowIso() : null, privacyReviewed && source === "browser-capture" ? identity.userId : null, transition === "review" ? nowIso() : null, revisionId, workspaceId));
      statements.push(statement(db, `DELETE FROM guide_steps WHERE revision_id = ?`, revisionId));
      statements.push(statement(db, `DELETE FROM guide_audiences WHERE revision_id = ?`, revisionId));
      statements.push(statement(db, `DELETE FROM review_assignments WHERE revision_id = ?`, revisionId));
    }
    const blockWritesJson = JSON.stringify(
      blocks.map((block, position) => ({
        id: `step_${revisionId}_${position}`,
        position,
        kind: block.kind,
        title: block.title,
        body: block.description,
        annotationJson: JSON.stringify({
          ...(block.screenshotMediaId ? { screenshotMediaId: block.screenshotMediaId } : {}),
          ...(block.crop ? { crop: block.crop } : {}),
          ...(block.annotations ? { annotations: block.annotations } : {}),
          ...(block.redactions ? { redactions: block.redactions } : {}),
        }),
      })),
    );
    statements.push(
      statement(
        db,
        `INSERT INTO guide_steps
           (id, revision_id, position, kind, title, body, annotation_json,
            created_at, updated_at)
         SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.position'),
                json_extract(value, '$.kind'), json_extract(value, '$.title'),
                json_extract(value, '$.body'), json_extract(value, '$.annotationJson'),
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         FROM json_each(?)`,
        revisionId,
        blockWritesJson,
      ),
    );
    if (inheritedMedia.length) {
      statements.push(
        statement(
          db,
          `INSERT INTO guide_media
             (id, workspace_id, revision_id, step_id, object_key, content_type,
              byte_size, width, height, sha256, redaction_state, source_rasterized,
              uploaded_by, created_at)
           SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.stepId'),
                  json_extract(value, '$.objectKey'), json_extract(value, '$.contentType'),
                  json_extract(value, '$.byteSize'), json_extract(value, '$.width'),
                  json_extract(value, '$.height'), json_extract(value, '$.sha256'),
                  json_extract(value, '$.redactionState'), 1, ?, CURRENT_TIMESTAMP
           FROM json_each(?)`,
          workspaceId,
          revisionId,
          identity.userId,
          JSON.stringify(inheritedMedia),
        ),
      );
    }
    const audienceWritesJson = JSON.stringify(
      audiences.map((audience) => ({
        kind: audience.kind,
        subjectId: audience.kind === "workspace" ? workspaceId : audience.subjectId,
      })),
    );
    statements.push(
      statement(
        db,
        `INSERT INTO guide_audiences
           (revision_id, subject_type, subject_id, granted_by, granted_at)
         SELECT ?, json_extract(value, '$.kind'), json_extract(value, '$.subjectId'),
                ?, CURRENT_TIMESTAMP
         FROM json_each(?)`,
        revisionId,
        identity.userId,
        audienceWritesJson,
      ),
    );
    if (transition === "review") {
      const reviewers = await rows<{ user_id: string }>(db, `SELECT DISTINCT r.user_id FROM workspace_member_roles r JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.user_id = r.user_id WHERE r.workspace_id = ? AND r.role IN ('reviewer', 'administrator') AND m.status = 'active'`, workspaceId);
      const reviewerIds = reviewers.map((item) => item.user_id);
      if (!reviewerIds.length) throw new HttpError(409, "REVIEWER_REQUIRED", "Assign an active reviewer or administrator before submitting this guide.");
      statements.push(
        statement(
          db,
          `INSERT INTO review_assignments
             (revision_id, reviewer_user_id, status, assigned_by, assigned_at)
           SELECT ?, value, 'pending', ?, CURRENT_TIMESTAMP FROM json_each(?)`,
          revisionId,
          identity.userId,
          JSON.stringify(reviewerIds),
        ),
      );
    }
    await audit(repository, identity, workspaceId, { action: transition === "review" ? "guide.submitted" : existing ? "guide.updated" : "guide.created", targetType: "guide", targetId: guideId, targetLabel: title, summary: transition === "review" ? `${title} submitted for review` : `${title} private draft saved`, metadata: { revisionId, version, source, clonedMediaCount: inheritedMedia.length } }, statements);
    } catch (error) {
      await cleanupInheritedMedia();
      throw error;
    }
    return { guideId, revisionId };
  }

  if (actionName === "reviewGuide") {
    const guideId = textValue(payload.guideId, "Guide", { min: 1, max: 128 });
    const guide = await first<{ working_draft_revision_id: string | null; title: string }>(db, `SELECT working_draft_revision_id, title FROM guides WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`, guideId, workspaceId);
    if (!guide?.working_draft_revision_id) throw new HttpError(409, "REVIEW_NOT_AVAILABLE", "This guide has no review revision.");
    const facts = await repository.getGuideAccessFacts(workspaceId, guideId, identity.userId, guide.working_draft_revision_id);
    if (!facts) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    requireAuthorized("guide.review", policyContext(access, isPlatformAdministrator, facts));
    if (payload.decision !== "approved" && payload.decision !== "changes_requested") {
      throw new HttpError(400, "REVIEW_DECISION_INVALID", "Select an explicit review decision.");
    }
    const decision = payload.decision;
    await audit(repository, identity, workspaceId, { action: decision === "approved" ? "guide.review-approved" : "guide.review-changes-requested", targetType: "guide", targetId: guideId, targetLabel: guide.title, summary: `${guide.title} review ${decision === "approved" ? "approved" : "returned for changes"}`, metadata: { revisionId: guide.working_draft_revision_id } }, [
      statement(db, `INSERT INTO review_assignments (revision_id, reviewer_user_id, status, assigned_by, assigned_at, decided_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(revision_id, reviewer_user_id) DO UPDATE SET status = excluded.status, decided_at = CURRENT_TIMESTAMP`, guide.working_draft_revision_id, identity.userId, decision, identity.userId),
      ...(decision === "changes_requested"
        ? [statement(db, `UPDATE guide_revisions SET status = 'draft', submitted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ? AND status = 'review'`, guide.working_draft_revision_id, workspaceId)]
        : []),
    ]);
    return { reviewed: true };
  }

  if (actionName === "publishGuide") {
    const guideId = textValue(payload.guideId, "Guide", { min: 1, max: 128 });
    const guide = await first<{ working_draft_revision_id: string | null; current_published_revision_id: string | null; title: string }>(db, `SELECT working_draft_revision_id, current_published_revision_id, title FROM guides WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`, guideId, workspaceId);
    if (!guide?.working_draft_revision_id) throw new HttpError(409, "PUBLISH_NOT_AVAILABLE", "This guide has no review revision.");
    const facts = await repository.getGuideAccessFacts(workspaceId, guideId, identity.userId, guide.working_draft_revision_id);
    if (!facts) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    requireAuthorized("guide.publish", policyContext(access, isPlatformAdministrator, facts));
    const publishedAt = nowIso();
    const statements = [
      ...(guide.current_published_revision_id
        ? [statement(db, `UPDATE guide_revisions SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`, publishedAt, publishedAt, guide.current_published_revision_id, workspaceId)]
        : []),
      statement(db, `UPDATE guide_revisions SET status = 'published', published_by = ?, published_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`, identity.userId, publishedAt, publishedAt, guide.working_draft_revision_id, workspaceId),
      statement(db, `UPDATE guides SET current_published_revision_id = ?, working_draft_revision_id = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`, guide.working_draft_revision_id, publishedAt, guideId, workspaceId),
    ];
    await audit(repository, identity, workspaceId, { action: "guide.published", targetType: "guide", targetId: guideId, targetLabel: guide.title, summary: `${guide.title} published`, metadata: { revisionId: guide.working_draft_revision_id } }, statements);
    return { published: true };
  }

  if (actionName === "archiveGuide") {
    requireAuthorized("guide.archive", context);
    const guideId = textValue(payload.guideId, "Guide", { min: 1, max: 128 });
    const guide = await first<{ title: string }>(db, `SELECT title FROM guides WHERE id = ? AND workspace_id = ?`, guideId, workspaceId);
    if (!guide) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    await audit(repository, identity, workspaceId, { action: "guide.archived", targetType: "guide", targetId: guideId, targetLabel: guide.title, summary: `${guide.title} archived` }, [statement(db, `UPDATE guides SET working_draft_revision_id = NULL, archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?`, guideId, workspaceId), statement(db, `UPDATE guide_revisions SET status = 'archived', archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE guide_id = ? AND workspace_id = ? AND status IN ('draft','review','published')`, guideId, workspaceId)]);
    return { archived: true };
  }

  if (actionName === "deleteGuide") {
    const guideId = textValue(payload.guideId, "Guide", { min: 1, max: 128 });
    const guide = await first<{ title: string; author_user_id: string }>(
      db,
      `SELECT title, author_user_id FROM guides WHERE id = ? AND workspace_id = ?`,
      guideId,
      workspaceId,
    );
    if (!guide) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    const everPublished = Boolean(
      await first<{ id: string }>(
        db,
        `SELECT id FROM guide_revisions WHERE guide_id = ? AND workspace_id = ? AND published_at IS NOT NULL LIMIT 1`,
        guideId,
        workspaceId,
      ),
    );
    const isAuthor = guide.author_user_id === identity.userId;
    const canDelete =
      isPlatformAdministrator ||
      access.roles.includes("administrator") ||
      access.roles.includes("publisher") ||
      (isAuthor && access.roles.includes("creator") && !everPublished);
    if (!canDelete) {
      throw new HttpError(
        403,
        "GUIDE_DELETE_FORBIDDEN",
        everPublished
          ? "Only an administrator or publisher can delete a guide that has been published."
          : "You cannot delete this guide.",
      );
    }
    const mediaObjectKeys = (
      await rows<{ object_key: string }>(
        db,
        `SELECT object_key FROM guide_media
         WHERE workspace_id = ? AND revision_id IN (SELECT id FROM guide_revisions WHERE guide_id = ?)`,
        workspaceId,
        guideId,
      )
    ).map((row) => row.object_key);
    await audit(
      repository,
      identity,
      workspaceId,
      {
        action: "guide.deleted",
        targetType: "guide",
        targetId: guideId,
        targetLabel: guide.title,
        summary: `${guide.title} deleted`,
      },
      [statement(db, `DELETE FROM guides WHERE id = ? AND workspace_id = ?`, guideId, workspaceId)],
    );
    if (mediaObjectKeys.length) {
      const bucket = requireR2Binding(env.MEDIA);
      for (const objectKey of mediaObjectKeys) {
        await deletePrivateMedia(bucket, objectKey, workspaceId).catch(() => undefined);
      }
    }
    return { deleted: true };
  }

  if (actionName === "restoreRevision") {
    const guideId = textValue(payload.guideId, "Guide", { min: 1, max: 128 });
    const sourceRevisionId = textValue(payload.revisionId, "Revision", { min: 1, max: 128 });
    const guide = await first<{ author_user_id: string; title: string; working_draft_revision_id: string | null }>(db, `SELECT author_user_id, title, working_draft_revision_id FROM guides WHERE id = ? AND workspace_id = ?`, guideId, workspaceId);
    if (!guide) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    if (guide.working_draft_revision_id) throw new HttpError(409, "WORKING_DRAFT_EXISTS", "Archive or finish the current draft before restoring another revision.");
    if (!(access.roles.includes("administrator") || (access.roles.includes("creator") && guide.author_user_id === identity.userId))) throw new HttpError(403, "DRAFT_EDITOR_REQUIRED", "You cannot restore this guide.");
    const source = await first<RevisionRow>(db, `SELECT id, guide_id, workspace_id, version, status, source_type, title, summary, category, tags_json, system_references_json, privacy_reviewed_at, created_by, created_at, updated_at, published_by, published_at FROM guide_revisions WHERE id = ? AND guide_id = ? AND workspace_id = ?`, sourceRevisionId, guideId, workspaceId);
    if (!source) throw new HttpError(404, "REVISION_NOT_FOUND", "Revision not found.");
    const nextVersion = Number((await first<{ version: number }>(db, `SELECT MAX(version) AS version FROM guide_revisions WHERE guide_id = ?`, guideId))?.version ?? 0) + 1;
    const revisionId = id("revision");
    const sourceSteps = await rows<{ id: string; position: number; kind: string; title: string; body: string; expected_result: string | null; requires_confirmation: number; annotation_json: string }>(db, `SELECT id, position, kind, title, body, expected_result, requires_confirmation, annotation_json FROM guide_steps WHERE revision_id = ? ORDER BY position`, sourceRevisionId);
    const sourceAudiences = await rows<{ subject_type: string; subject_id: string }>(db, `SELECT subject_type, subject_id FROM guide_audiences WHERE revision_id = ?`, sourceRevisionId);
    const sourceMedia = await rows<{
      id: string;
      object_key: string;
      content_type: "image/png" | "image/jpeg" | "image/webp";
      byte_size: number;
      width: number;
      height: number;
      sha256: string;
    }>(
      db,
      `SELECT id, object_key, content_type, byte_size, width, height, sha256
       FROM guide_media WHERE revision_id = ? AND workspace_id = ?`,
      sourceRevisionId,
      workspaceId,
    );
    const referencedMediaIds = [
      ...new Set(
        sourceSteps
          .map((step) =>
            safeJson<{ screenshotMediaId?: unknown }>(step.annotation_json, {})
              .screenshotMediaId,
          )
          .filter((item): item is string => typeof item === "string"),
      ),
    ];
    if (referencedMediaIds.some((mediaId) => !sourceMedia.some((item) => item.id === mediaId))) {
      throw new HttpError(
        409,
        "REVISION_MEDIA_INCOMPLETE",
        "The revision cannot be restored because a private screenshot is missing.",
      );
    }
    const clonedObjectKeys: string[] = [];
    try {
      const mediaIdMap = new Map<
        string,
        { id: string; objectKey: string; redactionState: "pending" | "redacted" }
      >();
      if (referencedMediaIds.length) {
        const bucket = requireR2Binding(env.MEDIA);
        for (const sourceMediaId of referencedMediaIds) {
          const media = sourceMedia.find((item) => item.id === sourceMediaId)!;
          const cloned = await clonePrivateMedia(bucket, {
            sourceObjectKey: media.object_key,
            workspaceId,
            revisionId,
            uploadedBy: identity.userId,
          });
          clonedObjectKeys.push(cloned.objectKey);
          mediaIdMap.set(sourceMediaId, {
            id: id("media"),
            objectKey: cloned.objectKey,
            redactionState: cloned.redactionState,
          });
        }
      }
      const restoredSteps = sourceSteps.map((step) => {
        const annotation = safeJson<Record<string, unknown>>(step.annotation_json, {});
        const sourceMediaId =
          typeof annotation.screenshotMediaId === "string"
            ? annotation.screenshotMediaId
            : null;
        const cloned = sourceMediaId ? mediaIdMap.get(sourceMediaId) : undefined;
        return {
          ...step,
          id: `step_${revisionId}_${step.position}`,
          annotation_json: JSON.stringify({
            ...annotation,
            ...(cloned ? { screenshotMediaId: cloned.id } : {}),
          }),
        };
      });
      const restoredMedia = referencedMediaIds.map((sourceMediaId) => {
        const sourceRow = sourceMedia.find((item) => item.id === sourceMediaId)!;
        const cloned = mediaIdMap.get(sourceMediaId)!;
        const sourceStep = sourceSteps.find(
          (step) =>
            safeJson<{ screenshotMediaId?: unknown }>(step.annotation_json, {})
              .screenshotMediaId === sourceMediaId,
        );
        return {
          id: cloned.id,
          stepId: sourceStep ? `step_${revisionId}_${sourceStep.position}` : null,
          objectKey: cloned.objectKey,
          contentType: sourceRow.content_type,
          byteSize: sourceRow.byte_size,
          width: sourceRow.width,
          height: sourceRow.height,
          sha256: sourceRow.sha256,
          redactionState: cloned.redactionState,
        };
      });
      const statements: D1PreparedStatementLike[] = [
        statement(db, `INSERT INTO guide_revisions (id, guide_id, workspace_id, version, status, source_type, title, summary, category, tags_json, system_references_json, privacy_reviewed_at, privacy_reviewed_by, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, revisionId, guideId, workspaceId, nextVersion, source.source_type, source.title, source.summary, source.category, source.tags_json, source.system_references_json, identity.userId),
        statement(db, `UPDATE guides SET working_draft_revision_id = ?, archived_at = NULL, title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?`, revisionId, source.title, guideId, workspaceId),
        statement(
          db,
          `INSERT INTO guide_steps
             (id, revision_id, position, kind, title, body, expected_result,
              requires_confirmation, annotation_json, created_at, updated_at)
           SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.position'),
                  json_extract(value, '$.kind'), json_extract(value, '$.title'),
                  json_extract(value, '$.body'), json_extract(value, '$.expected_result'),
                  json_extract(value, '$.requires_confirmation'),
                  json_extract(value, '$.annotation_json'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           FROM json_each(?)`,
          revisionId,
          JSON.stringify(restoredSteps),
        ),
        statement(
          db,
          `INSERT INTO guide_audiences
             (revision_id, subject_type, subject_id, granted_by, granted_at)
           SELECT ?, json_extract(value, '$.subject_type'),
                  json_extract(value, '$.subject_id'), ?, CURRENT_TIMESTAMP
           FROM json_each(?)`,
          revisionId,
          identity.userId,
          JSON.stringify(sourceAudiences),
        ),
        statement(
          db,
          `INSERT INTO guide_media
             (id, workspace_id, revision_id, step_id, object_key, content_type,
              byte_size, width, height, sha256, redaction_state, source_rasterized,
              uploaded_by, created_at)
           SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.stepId'),
                  json_extract(value, '$.objectKey'), json_extract(value, '$.contentType'),
                  json_extract(value, '$.byteSize'), json_extract(value, '$.width'),
                  json_extract(value, '$.height'), json_extract(value, '$.sha256'),
                  json_extract(value, '$.redactionState'), 1, ?, CURRENT_TIMESTAMP
           FROM json_each(?)`,
          workspaceId,
          revisionId,
          identity.userId,
          JSON.stringify(restoredMedia),
        ),
      ];
      await audit(repository, identity, workspaceId, { action: "guide.restored", targetType: "guide", targetId: guideId, targetLabel: source.title, summary: `${source.title} revision ${source.version} restored as draft`, metadata: { sourceRevisionId, revisionId, version: nextVersion, clonedMediaCount: restoredMedia.length } }, statements);
    } catch (error) {
      if (clonedObjectKeys.length) {
        const bucket = requireR2Binding(env.MEDIA);
        for (const objectKey of clonedObjectKeys) {
          await deletePrivateMedia(bucket, objectKey, workspaceId).catch(() => undefined);
        }
      }
      throw error;
    }
    return { revisionId };
  }

  if (actionName === "recordGuideView") {
    const guideId = textValue(payload.guideId, "Guide", { min: 1, max: 128 });
    const facts = await repository.getGuideAccessFacts(workspaceId, guideId, identity.userId);
    if (!facts) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    requireAuthorized("guide.read", policyContext(access, isPlatformAdministrator, facts));
    if (facts.isAudienceMember && facts.revisionStatus === "published") {
      const restricted = !(await first<{ matched: number }>(db, `SELECT 1 AS matched FROM guide_audiences WHERE revision_id = ? AND subject_type = 'workspace' LIMIT 1`, facts.revisionId));
      if (restricted) await audit(repository, identity, workspaceId, { action: "guide.restricted-viewed", targetType: "guide", targetId: guideId, summary: "Restricted guide viewed", metadata: { revisionId: facts.revisionId } });
      await run(db, `INSERT INTO workspace_metrics_daily (workspace_id, metric_date, views, updated_at) VALUES (?, date('now'), 1, CURRENT_TIMESTAMP) ON CONFLICT(workspace_id, metric_date) DO UPDATE SET views = views + 1, updated_at = CURRENT_TIMESTAMP`, workspaceId);
    }
    return { recorded: true };
  }

  if (actionName === "recordGuideCompletion") {
    const guideId = textValue(payload.guideId, "Guide", { min: 1, max: 128 });
    const facts = await repository.getGuideAccessFacts(workspaceId, guideId, identity.userId);
    if (!facts) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    requireAuthorized("guide.read", policyContext(access, isPlatformAdministrator, facts));
    if (!facts.isAudienceMember || facts.revisionStatus !== "published") {
      throw new HttpError(409, "PUBLISHED_GUIDE_REQUIRED", "Only a published guide can be completed.");
    }
    await audit(
      repository,
      identity,
      workspaceId,
      {
        action: "guide.completed",
        targetType: "guide",
        targetId: guideId,
        summary: "Published guide completed",
        metadata: { revisionId: facts.revisionId },
      },
      [
        statement(
          db,
          `INSERT INTO workspace_metrics_daily
             (workspace_id, metric_date, completions, updated_at)
           VALUES (?, date('now'), 1, CURRENT_TIMESTAMP)
           ON CONFLICT(workspace_id, metric_date) DO UPDATE SET
             completions = completions + 1, updated_at = CURRENT_TIMESTAMP`,
          workspaceId,
        ),
      ],
    );
    return { completed: true };
  }

  throw new HttpError(404, "ACTION_NOT_FOUND", "This action is not available.");
}

export async function GET(request: Request) {
  const id = requestId();
  try {
    return jsonResponse(await bootstrap(request));
  } catch (error) {
    return toErrorResponse(error, id);
  }
}

export async function POST(request: Request) {
  const id = requestId();
  try {
    assertMutationRequest(request);
    const body = await readJsonObject(request, 1_500_000);
    const actionName = textValue(body.action, "Action", { min: 2, max: 100 });
    const payload = asObject(body.payload ?? {}, "Payload");
    return jsonResponse(await handleCommand(request, actionName, payload));
  } catch (error) {
    return toErrorResponse(error, id);
  }
}
