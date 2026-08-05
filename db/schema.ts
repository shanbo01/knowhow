import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
};

export const platformAdmins = sqliteTable("platform_admins", {
  userId: text("user_id").primaryKey(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const platformSettings = sqliteTable("platform_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status", {
      enum: ["active", "suspended", "archived"],
    })
      .notNull()
      .default("active"),
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      "entities_status_check",
      sql`${table.status} IN ('active', 'suspended', 'archived')`,
    ),
    index("idx_entities_status").on(table.status),
  ],
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status", {
      enum: ["active", "suspended", "archived"],
    })
      .notNull()
      .default("active"),
    selfServe: integer("self_serve").notNull().default(0),
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      "workspaces_status_check",
      sql`${table.status} IN ('active', 'suspended', 'archived')`,
    ),
    index("idx_workspaces_entity_status").on(table.entityId, table.status),
    uniqueIndex("uq_workspaces_entity_slug").on(table.entityId, table.slug),
  ],
);

export const workspaceSettings = sqliteTable("workspace_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  logoObjectKey: text("logo_object_key"),
  accentColor: text("accent_color").notNull().default("#2563eb"),
  clickTargetColor: text("click_target_color").notNull().default("#ef4444"),
  removeBranding: integer("remove_branding", { mode: "boolean" })
    .notNull()
    .default(false),
  restrictedExportsEnabled: integer("restricted_exports_enabled", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  watermarkRestrictedExports: integer("watermark_restricted_exports", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  capturePolicyJson: text("capture_policy_json").notNull().default("{}"),
  ...timestamps,
});

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    status: text("status", { enum: ["active", "suspended"] })
      .notNull()
      .default("active"),
    joinedAt: text("joined_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    check(
      "workspace_members_status_check",
      sql`${table.status} IN ('active', 'suspended')`,
    ),
    index("idx_workspace_members_user_status").on(table.userId, table.status),
    uniqueIndex("uq_workspace_members_workspace_email").on(
      table.workspaceId,
      table.email,
    ),
  ],
);

export const workspaceMemberRoles = sqliteTable(
  "workspace_member_roles",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", {
      enum: ["administrator", "creator", "reviewer", "publisher", "viewer"],
    }).notNull(),
    grantedBy: text("granted_by").notNull(),
    grantedAt: text("granted_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId, table.role] }),
    check(
      "workspace_member_roles_role_check",
      sql`${table.role} IN ('administrator', 'creator', 'reviewer', 'publisher', 'viewer')`,
    ),
    index("idx_workspace_member_roles_user").on(table.userId, table.workspaceId),
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
      name: "fk_workspace_member_roles_member",
    }).onDelete("cascade"),
  ],
);

export const workspaceMemberCapabilities = sqliteTable(
  "workspace_member_capabilities",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    capability: text("capability", { enum: ["vault"] }).notNull(),
    grantedBy: text("granted_by").notNull(),
    grantedAt: text("granted_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId, table.capability] }),
    check(
      "workspace_member_capabilities_check",
      sql`${table.capability} = 'vault'`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
      name: "fk_workspace_member_capabilities_member",
    }).onDelete("cascade"),
  ],
);

export const workspaceDomains = sqliteTable(
  "workspace_domains",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    domainAscii: text("domain_ascii").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_workspace_domains_workspace_domain").on(
      table.workspaceId,
      table.domainAscii,
    ),
    index("idx_workspace_domains_domain_enabled").on(
      table.domainAscii,
      table.enabled,
    ),
  ],
);

export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    sensitive: integer("sensitive", { mode: "boolean" })
      .notNull()
      .default(false),
    kind: text("kind", { enum: ["all_members", "custom"] })
      .notNull()
      .default("custom"),
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_groups_workspace_slug").on(table.workspaceId, table.slug),
    uniqueIndex("uq_groups_id_workspace").on(table.id, table.workspaceId),
    uniqueIndex("uq_groups_workspace_all_members")
      .on(table.workspaceId)
      .where(sql`${table.kind} = 'all_members'`),
    check(
      "groups_kind_check",
      sql`${table.kind} IN ('all_members', 'custom')`,
    ),
    index("idx_groups_workspace_kind").on(table.workspaceId, table.kind),
  ],
);

export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: text("added_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index("idx_group_members_user_group").on(table.userId, table.groupId),
    foreignKey({
      columns: [table.groupId, table.workspaceId],
      foreignColumns: [groups.id, groups.workspaceId],
      name: "fk_group_members_group_workspace",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
      name: "fk_group_members_workspace_member",
    }).onDelete("cascade"),
  ],
);

export const joinRequests = sqliteTable(
  "join_requests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    status: text("status", { enum: ["pending", "approved", "denied"] })
      .notNull()
      .default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    ...timestamps,
  },
  (table) => [
    check(
      "join_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'denied')`,
    ),
    uniqueIndex("uq_join_requests_workspace_user").on(
      table.workspaceId,
      table.userId,
    ),
    index("idx_join_requests_workspace_status").on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const guides = sqliteTable(
  "guides",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    authorUserId: text("author_user_id").notNull(),
    currentPublishedRevisionId: text("current_published_revision_id"),
    workingDraftRevisionId: text("working_draft_revision_id"),
    archivedAt: text("archived_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_guides_workspace_slug").on(table.workspaceId, table.slug),
    uniqueIndex("uq_guides_id_workspace").on(table.id, table.workspaceId),
    index("idx_guides_workspace_updated").on(table.workspaceId, table.updatedAt),
    index("idx_guides_workspace_archived").on(table.workspaceId, table.archivedAt),
  ],
);

export const guideRevisions = sqliteTable(
  "guide_revisions",
  {
    id: text("id").primaryKey(),
    guideId: text("guide_id")
      .notNull()
      .references(() => guides.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status", {
      enum: ["draft", "review", "published", "archived"],
    })
      .notNull()
      .default("draft"),
    sourceType: text("source_type", { enum: ["manual", "capture", "import"] })
      .notNull()
      .default("manual"),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    category: text("category"),
    tagsJson: text("tags_json").notNull().default("[]"),
    systemReferencesJson: text("system_references_json").notNull().default("[]"),
    privacyReviewedAt: text("privacy_reviewed_at"),
    privacyReviewedBy: text("privacy_reviewed_by"),
    createdBy: text("created_by").notNull(),
    submittedAt: text("submitted_at"),
    publishedBy: text("published_by"),
    publishedAt: text("published_at"),
    archivedAt: text("archived_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_guide_revisions_guide_version").on(
      table.guideId,
      table.version,
    ),
    uniqueIndex("uq_guide_revisions_id_workspace").on(table.id, table.workspaceId),
    check(
      "guide_revisions_version_check",
      sql`${table.version} > 0`,
    ),
    check(
      "guide_revisions_status_check",
      sql`${table.status} IN ('draft', 'review', 'published', 'archived')`,
    ),
    check(
      "guide_revisions_source_check",
      sql`${table.sourceType} IN ('manual', 'capture', 'import')`,
    ),
    index("idx_guide_revisions_workspace_status").on(
      table.workspaceId,
      table.status,
      table.updatedAt,
    ),
    index("idx_guide_revisions_guide_status").on(table.guideId, table.status),
    foreignKey({
      columns: [table.guideId, table.workspaceId],
      foreignColumns: [guides.id, guides.workspaceId],
      name: "fk_guide_revisions_guide_workspace",
    }).onDelete("cascade"),
  ],
);

export const guideSteps = sqliteTable(
  "guide_steps",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => guideRevisions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: text("kind", { enum: ["action", "heading", "note", "warning"] })
      .notNull()
      .default("action"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    expectedResult: text("expected_result"),
    requiresConfirmation: integer("requires_confirmation", { mode: "boolean" })
      .notNull()
      .default(false),
    annotationJson: text("annotation_json").notNull().default("{}"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_guide_steps_revision_position").on(
      table.revisionId,
      table.position,
    ),
    uniqueIndex("uq_guide_steps_id_revision").on(table.id, table.revisionId),
    check("guide_steps_position_check", sql`${table.position} >= 0`),
    check(
      "guide_steps_kind_check",
      sql`${table.kind} IN ('action', 'heading', 'note', 'warning')`,
    ),
  ],
);

export const guideAudiences = sqliteTable(
  "guide_audiences",
  {
    revisionId: text("revision_id")
      .notNull()
      .references(() => guideRevisions.id, { onDelete: "cascade" }),
    subjectType: text("subject_type", {
      enum: ["workspace", "group", "user"],
    }).notNull(),
    subjectId: text("subject_id").notNull(),
    grantedBy: text("granted_by").notNull(),
    grantedAt: text("granted_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({
      columns: [table.revisionId, table.subjectType, table.subjectId],
    }),
    check(
      "guide_audiences_subject_type_check",
      sql`${table.subjectType} IN ('workspace', 'group', 'user')`,
    ),
    index("idx_guide_audiences_subject").on(
      table.subjectType,
      table.subjectId,
      table.revisionId,
    ),
  ],
);

export const reviewAssignments = sqliteTable(
  "review_assignments",
  {
    revisionId: text("revision_id")
      .notNull()
      .references(() => guideRevisions.id, { onDelete: "cascade" }),
    reviewerUserId: text("reviewer_user_id").notNull(),
    status: text("status", {
      enum: ["pending", "approved", "changes_requested"],
    })
      .notNull()
      .default("pending"),
    note: text("note"),
    assignedBy: text("assigned_by").notNull(),
    assignedAt: text("assigned_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    decidedAt: text("decided_at"),
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.reviewerUserId] }),
    check(
      "review_assignments_status_check",
      sql`${table.status} IN ('pending', 'approved', 'changes_requested')`,
    ),
    index("idx_review_assignments_reviewer_status").on(
      table.reviewerUserId,
      table.status,
    ),
  ],
);

export const captureSessions = sqliteTable(
  "capture_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    deviceTokenId: text("device_token_id"),
    status: text("status", {
      enum: ["recording", "paused", "finished", "discarded"],
    })
      .notNull()
      .default("recording"),
    lastSequence: integer("last_sequence").notNull().default(0),
    captureScope: text("capture_scope").notNull(),
    excludedOrigin: text("excluded_origin"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    pausedAt: text("paused_at"),
    finishedAt: text("finished_at"),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "capture_sessions_status_check",
      sql`${table.status} IN ('recording', 'paused', 'finished', 'discarded')`,
    ),
    check(
      "capture_sessions_sequence_check",
      sql`${table.lastSequence} >= 0`,
    ),
    index("idx_capture_sessions_workspace_user_status").on(
      table.workspaceId,
      table.userId,
      table.status,
    ),
    uniqueIndex("uq_capture_sessions_id_workspace").on(
      table.id,
      table.workspaceId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
      name: "fk_capture_sessions_workspace_member",
    }).onDelete("cascade"),
  ],
);

export const guideMedia = sqliteTable(
  "guide_media",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    revisionId: text("revision_id")
      .notNull()
      .references(() => guideRevisions.id, { onDelete: "cascade" }),
    stepId: text("step_id").references(() => guideSteps.id, {
      onDelete: "set null",
    }),
    captureSessionId: text("capture_session_id").references(
      () => captureSessions.id,
      { onDelete: "set null" },
    ),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type", {
      enum: ["image/png", "image/jpeg", "image/webp"],
    }).notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sha256: text("sha256").notNull(),
    redactionState: text("redaction_state", { enum: ["redacted"] })
      .notNull()
      .default("redacted"),
    sourceRasterized: integer("source_rasterized", { mode: "boolean" })
      .notNull()
      .default(true),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_guide_media_object_key").on(table.objectKey),
    check(
      "guide_media_content_type_check",
      sql`${table.contentType} IN ('image/png', 'image/jpeg', 'image/webp')`,
    ),
    check(
      "guide_media_redaction_check",
      sql`${table.redactionState} = 'redacted' AND ${table.sourceRasterized} = 1`,
    ),
    check(
      "guide_media_dimensions_check",
      sql`${table.byteSize} > 0 AND ${table.width} > 0 AND ${table.height} > 0`,
    ),
    index("idx_guide_media_revision_step").on(table.revisionId, table.stepId),
    index("idx_guide_media_workspace_created").on(
      table.workspaceId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.revisionId, table.workspaceId],
      foreignColumns: [guideRevisions.id, guideRevisions.workspaceId],
      name: "fk_guide_media_revision_workspace",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.stepId, table.revisionId],
      foreignColumns: [guideSteps.id, guideSteps.revisionId],
      name: "fk_guide_media_step_revision",
    }),
    foreignKey({
      columns: [table.captureSessionId, table.workspaceId],
      foreignColumns: [captureSessions.id, captureSessions.workspaceId],
      name: "fk_guide_media_capture_workspace",
    }),
  ],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    label: text("label").notNull().default("Invite link"),
    email: text("email"),
    role: text("role", { enum: ["creator", "reviewer", "publisher", "viewer"] })
      .notNull()
      .default("viewer"),
    status: text("status", { enum: ["active", "revoked", "exhausted"] })
      .notNull()
      .default("active"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: text("expires_at").notNull(),
    createdBy: text("created_by").notNull(),
    createdVia: text("created_via", { enum: ["standard", "support-access"] })
      .notNull()
      .default("standard"),
    revokedBy: text("revoked_by"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_invitations_token_hash").on(table.tokenHash),
    check(
      "invitations_role_check",
      sql`${table.role} IN ('creator', 'reviewer', 'publisher', 'viewer')`,
    ),
    check(
      "invitations_created_via_check",
      sql`${table.createdVia} IN ('standard', 'support-access')`,
    ),
    check(
      "invitations_status_check",
      sql`${table.status} IN ('active', 'revoked', 'exhausted')`,
    ),
    check(
      "invitations_uses_check",
      sql`${table.maxUses} > 0 AND ${table.useCount} >= 0 AND ${table.useCount} <= ${table.maxUses}`,
    ),
    index("idx_invitations_workspace_status_expiry").on(
      table.workspaceId,
      table.status,
      table.expiresAt,
    ),
  ],
);

export const inviteRedemptions = sqliteTable(
  "invite_redemptions",
  {
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    redeemedAt: text("redeemed_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.invitationId, table.userId] }),
    index("idx_invite_redemptions_user").on(table.userId, table.redeemedAt),
  ],
);

export const supportAccessRequests = sqliteTable(
  "support_access_requests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requesterUserId: text("requester_user_id").notNull(),
    requesterEmail: text("requester_email").notNull(),
    requesterName: text("requester_name").notNull(),
    requestedRole: text("requested_role", {
      enum: ["administrator", "creator", "reviewer", "publisher", "viewer"],
    }).notNull(),
    reason: text("reason").notNull(),
    requestedDurationHours: integer("requested_duration_hours").notNull(),
    status: text("status", {
      enum: ["pending", "approved", "denied", "cancelled"],
    })
      .notNull()
      .default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    grantedRole: text("granted_role", {
      enum: ["administrator", "creator", "reviewer", "publisher", "viewer"],
    }),
    grantId: text("grant_id"),
    ...timestamps,
  },
  (table) => [
    check(
      "support_access_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'denied', 'cancelled')`,
    ),
    check(
      "support_access_requests_duration_check",
      sql`${table.requestedDurationHours} BETWEEN 1 AND 168`,
    ),
    check(
      "support_access_requests_reason_check",
      sql`length(${table.reason}) BETWEEN 10 AND 2000`,
    ),
    index("idx_support_access_requests_workspace_status").on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const supportAccessGrants = sqliteTable(
  "support_access_grants",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => supportAccessRequests.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role", {
      enum: ["administrator", "creator", "reviewer", "publisher", "viewer"],
    }).notNull(),
    status: text("status", { enum: ["active", "expired", "revoked"] })
      .notNull()
      .default("active"),
    approvedBy: text("approved_by").notNull(),
    grantedAt: text("granted_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    endedAt: text("ended_at"),
    revokedBy: text("revoked_by"),
  },
  (table) => [
    uniqueIndex("uq_support_access_grants_request").on(table.requestId),
    check(
      "support_access_grants_status_check",
      sql`${table.status} IN ('active', 'expired', 'revoked')`,
    ),
    index("idx_support_access_grants_workspace_user").on(
      table.workspaceId,
      table.userId,
      table.status,
    ),
    index("idx_support_access_grants_expiry").on(table.expiresAt),
  ],
);

export const adminAppointments = sqliteTable(
  "admin_appointments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    email: text("email").notNull(),
    status: text("status", {
      enum: ["active", "accepted", "revoked", "expired"],
    })
      .notNull()
      .default("active"),
    expiresAt: text("expires_at").notNull(),
    createdBy: text("created_by").notNull(),
    acceptedBy: text("accepted_by"),
    acceptedAt: text("accepted_at"),
    revokedBy: text("revoked_by"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_admin_appointments_token_hash").on(table.tokenHash),
    check(
      "admin_appointments_status_check",
      sql`${table.status} IN ('active', 'accepted', 'revoked', 'expired')`,
    ),
    index("idx_admin_appointments_workspace_status").on(
      table.workspaceId,
      table.status,
    ),
  ],
);

export const deviceTokens = sqliteTable(
  "device_tokens",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_device_tokens_hash").on(table.tokenHash),
    index("idx_device_tokens_workspace_user").on(
      table.workspaceId,
      table.userId,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
      name: "fk_device_tokens_workspace_member",
    }).onDelete("cascade"),
  ],
);

export const auditHeads = sqliteTable("audit_heads", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  lastSequence: integer("last_sequence").notNull().default(0),
  lastHash: text("last_hash").notNull().default(""),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    previousHash: text("previous_hash").notNull(),
    eventHash: text("event_hash").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    actorEmail: text("actor_email"),
    actorName: text("actor_name"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    targetLabel: text("target_label"),
    summary: text("summary").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_audit_events_workspace_sequence").on(
      table.workspaceId,
      table.sequence,
    ),
    uniqueIndex("uq_audit_events_workspace_hash").on(
      table.workspaceId,
      table.eventHash,
    ),
    check("audit_events_sequence_check", sql`${table.sequence} > 0`),
    index("idx_audit_events_workspace_occurred").on(
      table.workspaceId,
      table.occurredAt,
    ),
    index("idx_audit_events_workspace_action").on(
      table.workspaceId,
      table.action,
      table.occurredAt,
    ),
  ],
);

export const workspaceMetricsDaily = sqliteTable(
  "workspace_metrics_daily",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    metricDate: text("metric_date").notNull(),
    drafts: integer("drafts").notNull().default(0),
    publishedGuides: integer("published_guides").notNull().default(0),
    captures: integer("captures").notNull().default(0),
    views: integer("views").notNull().default(0),
    completions: integer("completions").notNull().default(0),
    exports: integer("exports").notNull().default(0),
    storageBytes: integer("storage_bytes").notNull().default(0),
    failedOperations: integer("failed_operations").notNull().default(0),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.metricDate] }),
    index("idx_workspace_metrics_date").on(table.metricDate, table.workspaceId),
  ],
);

export const exports = sqliteTable(
  "exports",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    revisionId: text("revision_id")
      .notNull()
      .references(() => guideRevisions.id, { onDelete: "cascade" }),
    format: text("format", { enum: ["pdf", "html", "markdown"] }).notNull(),
    status: text("status", { enum: ["pending", "ready", "failed"] })
      .notNull()
      .default("pending"),
    objectKey: text("object_key"),
    watermarked: integer("watermarked", { mode: "boolean" })
      .notNull()
      .default(false),
    createdBy: text("created_by").notNull(),
    errorCode: text("error_code"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [
    check(
      "exports_format_check",
      sql`${table.format} IN ('pdf', 'html', 'markdown')`,
    ),
    check(
      "exports_status_check",
      sql`${table.status} IN ('pending', 'ready', 'failed')`,
    ),
    index("idx_exports_workspace_created").on(table.workspaceId, table.createdAt),
    foreignKey({
      columns: [table.revisionId, table.workspaceId],
      foreignColumns: [guideRevisions.id, guideRevisions.workspaceId],
      name: "fk_exports_revision_workspace",
    }).onDelete("cascade"),
  ],
);

export const vaultItems = sqliteTable(
  "vault_items",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    encryptedEnvelopeJson: text("encrypted_envelope_json").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  (table) => [
    index("idx_vault_items_workspace_updated").on(
      table.workspaceId,
      table.updatedAt,
    ),
  ],
);

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id").primaryKey(),
  theme: text("theme", { enum: ["light", "dark", "system"] })
    .notNull()
    .default("system"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

/**
 * Drizzle does not currently model SQLite triggers. Apply these statements
 * after migrations (and safely on every Worker start) using one D1 prepared
 * statement per entry. These guards validate and advance the hash chain while
 * keeping audit events insert-only, even for privileged application queries.
 */
export const auditAppendOnlyTriggerStatements = [
  `CREATE TRIGGER IF NOT EXISTS audit_events_validate_chain
   BEFORE INSERT ON audit_events
   BEGIN
     SELECT CASE
       WHEN NOT EXISTS (
         SELECT 1 FROM audit_heads WHERE workspace_id = NEW.workspace_id
       )
       THEN RAISE(ABORT, 'audit head missing')
     END;
     SELECT CASE
       WHEN NEW.sequence != (
         SELECT last_sequence + 1
         FROM audit_heads
         WHERE workspace_id = NEW.workspace_id
       )
       THEN RAISE(ABORT, 'audit sequence mismatch')
     END;
     SELECT CASE
       WHEN NEW.previous_hash != (
         SELECT CASE
           WHEN last_hash = '' THEN '${"0".repeat(64)}'
           ELSE last_hash
         END
         FROM audit_heads
         WHERE workspace_id = NEW.workspace_id
       )
       THEN RAISE(ABORT, 'audit previous hash mismatch')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS audit_events_advance_head
   AFTER INSERT ON audit_events
   BEGIN
     UPDATE audit_heads
     SET last_sequence = NEW.sequence,
         last_hash = NEW.event_hash,
         updated_at = NEW.occurred_at
     WHERE workspace_id = NEW.workspace_id
       AND last_sequence = NEW.sequence - 1
       AND (CASE WHEN last_hash = '' THEN '${"0".repeat(64)}' ELSE last_hash END) = NEW.previous_hash;
     SELECT CASE
       WHEN changes() != 1
       THEN RAISE(ABORT, 'audit head advance failed')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS audit_events_reject_update
   BEFORE UPDATE ON audit_events
   BEGIN
     SELECT RAISE(ABORT, 'audit_events are append-only');
   END`,
  `CREATE TRIGGER IF NOT EXISTS audit_events_reject_delete
   BEFORE DELETE ON audit_events
   BEGIN
     SELECT RAISE(ABORT, 'audit_events are append-only');
   END`,
] as const;

/**
 * Conditional tenant relationships cannot be represented as ordinary SQLite
 * foreign keys because an audience subject may be a workspace, group, or user.
 * These guards reject cross-workspace audience and reviewer links even if an
 * application route accidentally prepares an unsafe statement.
 */
export const tenantBoundaryTriggerStatements = [
  `CREATE TRIGGER IF NOT EXISTS guide_audiences_validate_insert
   BEFORE INSERT ON guide_audiences
   BEGIN
     SELECT CASE
       WHEN NEW.subject_type = 'workspace'
         AND NEW.subject_id != (
           SELECT workspace_id FROM guide_revisions WHERE id = NEW.revision_id
         )
       THEN RAISE(ABORT, 'audience workspace mismatch')
       WHEN NEW.subject_type = 'group'
         AND NOT EXISTS (
           SELECT 1
           FROM groups g
           JOIN guide_revisions r ON r.id = NEW.revision_id
           WHERE g.id = NEW.subject_id AND g.workspace_id = r.workspace_id
         )
       THEN RAISE(ABORT, 'audience group workspace mismatch')
       WHEN NEW.subject_type = 'user'
         AND NOT EXISTS (
           SELECT 1
           FROM workspace_members wm
           JOIN guide_revisions r ON r.id = NEW.revision_id
           WHERE wm.user_id = NEW.subject_id AND wm.workspace_id = r.workspace_id
         )
       THEN RAISE(ABORT, 'audience user workspace mismatch')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS guide_audiences_validate_update
   BEFORE UPDATE ON guide_audiences
   BEGIN
     SELECT CASE
       WHEN NEW.subject_type = 'workspace'
         AND NEW.subject_id != (
           SELECT workspace_id FROM guide_revisions WHERE id = NEW.revision_id
         )
       THEN RAISE(ABORT, 'audience workspace mismatch')
       WHEN NEW.subject_type = 'group'
         AND NOT EXISTS (
           SELECT 1
           FROM groups g
           JOIN guide_revisions r ON r.id = NEW.revision_id
           WHERE g.id = NEW.subject_id AND g.workspace_id = r.workspace_id
         )
       THEN RAISE(ABORT, 'audience group workspace mismatch')
       WHEN NEW.subject_type = 'user'
         AND NOT EXISTS (
           SELECT 1
           FROM workspace_members wm
           JOIN guide_revisions r ON r.id = NEW.revision_id
           WHERE wm.user_id = NEW.subject_id AND wm.workspace_id = r.workspace_id
         )
       THEN RAISE(ABORT, 'audience user workspace mismatch')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS review_assignments_validate_insert
   BEFORE INSERT ON review_assignments
   BEGIN
     SELECT CASE
       WHEN NOT EXISTS (
         SELECT 1
         FROM workspace_members wm
         JOIN guide_revisions r ON r.id = NEW.revision_id
         WHERE wm.user_id = NEW.reviewer_user_id
           AND wm.workspace_id = r.workspace_id
       )
       THEN RAISE(ABORT, 'reviewer workspace mismatch')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS review_assignments_validate_update
   BEFORE UPDATE ON review_assignments
   BEGIN
     SELECT CASE
       WHEN NOT EXISTS (
         SELECT 1
         FROM workspace_members wm
         JOIN guide_revisions r ON r.id = NEW.revision_id
         WHERE wm.user_id = NEW.reviewer_user_id
           AND wm.workspace_id = r.workspace_id
       )
       THEN RAISE(ABORT, 'reviewer workspace mismatch')
     END;
   END`,
] as const;

/**
 * Concurrency-sensitive workflow invariants live in SQLite so a stale request
 * cannot partially redeem an invitation, unpublish a guide, reuse a pairing
 * code, or remove the final active workspace administrator.
 */
export const workflowIntegrityTriggerStatements = [
  `CREATE TRIGGER IF NOT EXISTS invite_redemptions_validate_insert
   BEFORE INSERT ON invite_redemptions
   BEGIN
     SELECT CASE
       WHEN NOT EXISTS (
         SELECT 1
         FROM invitations i
         JOIN workspaces w ON w.id = i.workspace_id
         WHERE i.id = NEW.invitation_id
           AND i.status = 'active'
           AND i.use_count < i.max_uses
           AND unixepoch(i.expires_at) > unixepoch('now')
           AND w.status = 'active'
           AND (i.email IS NULL OR lower(i.email) = lower(NEW.email))
       )
       THEN RAISE(ABORT, 'invitation unavailable')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS invite_redemptions_increment_use
   AFTER INSERT ON invite_redemptions
   BEGIN
     UPDATE invitations
     SET use_count = use_count + 1,
         status = CASE
           WHEN use_count + 1 >= max_uses THEN 'exhausted'
           ELSE status
         END
     WHERE id = NEW.invitation_id;
     SELECT CASE
       WHEN changes() != 1
       THEN RAISE(ABORT, 'invitation redemption failed')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS guides_validate_publish_pointer
   BEFORE UPDATE OF current_published_revision_id ON guides
   WHEN NEW.current_published_revision_id IS NOT OLD.current_published_revision_id
   BEGIN
     SELECT CASE
       WHEN NEW.current_published_revision_id IS NULL
         OR OLD.working_draft_revision_id IS NULL
         OR NEW.current_published_revision_id != OLD.working_draft_revision_id
         OR NEW.working_draft_revision_id IS NOT NULL
         OR NOT EXISTS (
           SELECT 1 FROM guide_revisions r
           WHERE r.id = NEW.current_published_revision_id
             AND r.guide_id = OLD.id
             AND r.workspace_id = OLD.workspace_id
             AND r.status = 'published'
         )
       THEN RAISE(ABORT, 'invalid guide publish transition')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS guide_revisions_validate_publish
   BEFORE UPDATE OF status ON guide_revisions
   WHEN NEW.status = 'published'
   BEGIN
     SELECT CASE
       WHEN OLD.status != 'review'
         OR NOT EXISTS (
           SELECT 1 FROM review_assignments ra
           WHERE ra.revision_id = OLD.id AND ra.status = 'approved'
         )
         OR EXISTS (
           SELECT 1 FROM review_assignments ra
           WHERE ra.revision_id = OLD.id AND ra.status != 'approved'
         )
         OR (OLD.source_type = 'capture' AND OLD.privacy_reviewed_at IS NULL)
       THEN RAISE(ABORT, 'revision is not publishable')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS device_pairing_code_single_use
   BEFORE UPDATE OF device_id, token_hash ON device_tokens
   WHEN OLD.device_id LIKE 'pair:%'
   BEGIN
     SELECT CASE
       WHEN unixepoch(OLD.expires_at) <= unixepoch('now')
         OR NEW.device_id LIKE 'pair:%'
         OR NEW.token_hash = OLD.token_hash
       THEN RAISE(ABORT, 'pairing code unavailable')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS device_pairing_reject_rebind
   BEFORE UPDATE OF device_id, token_hash ON device_tokens
   WHEN OLD.device_id NOT LIKE 'pair:%'
     AND (NEW.device_id != OLD.device_id OR NEW.token_hash != OLD.token_hash)
   BEGIN
     SELECT RAISE(ABORT, 'device token cannot be rebound');
   END`,
  `CREATE TRIGGER IF NOT EXISTS workspace_roles_keep_last_active_admin
   BEFORE DELETE ON workspace_member_roles
   WHEN OLD.role = 'administrator'
     AND EXISTS (
       SELECT 1 FROM workspace_members m
       WHERE m.workspace_id = OLD.workspace_id
         AND m.user_id = OLD.user_id
         AND m.status = 'active'
     )
     AND (
       SELECT COUNT(*)
       FROM workspace_member_roles r
       JOIN workspace_members m
         ON m.workspace_id = r.workspace_id AND m.user_id = r.user_id
       WHERE r.workspace_id = OLD.workspace_id
         AND r.role = 'administrator'
         AND m.status = 'active'
     ) <= 1
   BEGIN
     SELECT RAISE(ABORT, 'last active administrator required');
   END`,
  `CREATE TRIGGER IF NOT EXISTS workspace_members_keep_last_active_admin
   BEFORE UPDATE OF status ON workspace_members
   WHEN OLD.status = 'active' AND NEW.status != 'active'
     AND EXISTS (
       SELECT 1 FROM workspace_member_roles r
       WHERE r.workspace_id = OLD.workspace_id
         AND r.user_id = OLD.user_id
         AND r.role = 'administrator'
     )
     AND (
       SELECT COUNT(*)
       FROM workspace_member_roles r
       JOIN workspace_members m
         ON m.workspace_id = r.workspace_id AND m.user_id = r.user_id
       WHERE r.workspace_id = OLD.workspace_id
         AND r.role = 'administrator'
         AND m.status = 'active'
     ) <= 1
   BEGIN
     SELECT RAISE(ABORT, 'last active administrator required');
   END`,
  `CREATE TRIGGER IF NOT EXISTS capture_sessions_validate_status_transition
   BEFORE UPDATE OF status ON capture_sessions
   WHEN NEW.status != OLD.status
   BEGIN
     SELECT CASE
       WHEN NOT (
         (OLD.status = 'recording' AND NEW.status IN ('paused', 'finished', 'discarded'))
         OR (OLD.status = 'paused' AND NEW.status IN ('recording', 'discarded'))
       )
       THEN RAISE(ABORT, 'invalid capture status transition')
     END;
     SELECT CASE
       WHEN NEW.status = 'discarded'
         AND EXISTS (
           SELECT 1 FROM guides g
           WHERE g.id = json_extract(NEW.capture_scope, '$.guideId')
             AND g.workspace_id = NEW.workspace_id
         )
       THEN RAISE(ABORT, 'capture draft must be deleted before discard')
     END;
     SELECT CASE
       WHEN NEW.status = 'finished'
         AND (
           json_type(NEW.capture_scope, '$.expectedSteps') != 'integer'
           OR json_extract(NEW.capture_scope, '$.expectedSteps') < 1
           OR NEW.last_sequence != json_extract(NEW.capture_scope, '$.expectedSteps')
           OR (
             SELECT COUNT(*) FROM guide_media m
             WHERE m.capture_session_id = OLD.id
               AND m.workspace_id = OLD.workspace_id
               AND m.revision_id = json_extract(OLD.capture_scope, '$.revisionId')
           ) != json_extract(NEW.capture_scope, '$.expectedSteps')
         )
       THEN RAISE(ABORT, 'capture is incomplete')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS capture_sessions_validate_scope_update
   BEFORE UPDATE OF capture_scope ON capture_sessions
   BEGIN
     SELECT CASE
       WHEN OLD.status NOT IN ('recording', 'paused')
         OR json_extract(NEW.capture_scope, '$.guideId') IS NOT json_extract(OLD.capture_scope, '$.guideId')
         OR json_extract(NEW.capture_scope, '$.revisionId') IS NOT json_extract(OLD.capture_scope, '$.revisionId')
         OR json_extract(NEW.capture_scope, '$.title') IS NOT json_extract(OLD.capture_scope, '$.title')
         OR json_extract(NEW.capture_scope, '$.policyVersion') IS NOT json_extract(OLD.capture_scope, '$.policyVersion')
         OR json_type(NEW.capture_scope, '$.expectedSteps') != 'integer'
         OR json_extract(NEW.capture_scope, '$.expectedSteps') NOT BETWEEN 0 AND 100
         OR (
           json_extract(NEW.capture_scope, '$.expectedSteps') != json_extract(OLD.capture_scope, '$.expectedSteps')
           AND EXISTS (
             SELECT 1 FROM guide_media m
             WHERE m.capture_session_id = OLD.id AND m.workspace_id = OLD.workspace_id
           )
         )
       THEN RAISE(ABORT, 'invalid capture scope update')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS guide_media_validate_capture_insert
   BEFORE INSERT ON guide_media
   WHEN NEW.capture_session_id IS NOT NULL
   BEGIN
     SELECT CASE
       WHEN NOT EXISTS (
         SELECT 1 FROM capture_sessions c
         WHERE c.id = NEW.capture_session_id
           AND c.workspace_id = NEW.workspace_id
           AND c.status = 'recording'
           AND c.user_id = NEW.uploaded_by
           AND json_extract(c.capture_scope, '$.revisionId') = NEW.revision_id
           AND json_type(c.capture_scope, '$.expectedSteps') = 'integer'
           AND json_extract(c.capture_scope, '$.expectedSteps') BETWEEN 1 AND 100
           AND (
             SELECT COUNT(*) FROM guide_media existing
             WHERE existing.capture_session_id = c.id
               AND existing.workspace_id = c.workspace_id
               AND existing.revision_id = NEW.revision_id
           ) < json_extract(c.capture_scope, '$.expectedSteps')
       )
       THEN RAISE(ABORT, 'capture media unavailable')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS capture_sessions_require_live_draft_on_finish
   BEFORE UPDATE OF status ON capture_sessions
   WHEN NEW.status = 'finished' AND OLD.status != 'finished'
   BEGIN
     SELECT CASE
       WHEN NOT EXISTS (
         SELECT 1
         FROM guide_revisions r
         JOIN guides g
           ON g.id = r.guide_id AND g.workspace_id = r.workspace_id
         WHERE r.id = json_extract(NEW.capture_scope, '$.revisionId')
           AND r.workspace_id = NEW.workspace_id
           AND r.guide_id = json_extract(NEW.capture_scope, '$.guideId')
           AND r.status = 'draft'
           AND g.archived_at IS NULL
           AND g.working_draft_revision_id = r.id
       )
       THEN RAISE(ABORT, 'live capture draft required')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS guide_media_require_live_capture_draft
   BEFORE INSERT ON guide_media
   WHEN NEW.capture_session_id IS NOT NULL
   BEGIN
     SELECT CASE
       WHEN NOT EXISTS (
         SELECT 1
         FROM capture_sessions c
         JOIN guide_revisions r
           ON r.id = NEW.revision_id AND r.workspace_id = c.workspace_id
         JOIN guides g
           ON g.id = r.guide_id AND g.workspace_id = r.workspace_id
         WHERE c.id = NEW.capture_session_id
           AND c.workspace_id = NEW.workspace_id
           AND json_extract(c.capture_scope, '$.revisionId') = r.id
           AND json_extract(c.capture_scope, '$.guideId') = g.id
           AND r.status = 'draft'
           AND g.archived_at IS NULL
           AND g.working_draft_revision_id = r.id
       )
       THEN RAISE(ABORT, 'live capture draft required')
     END;
   END`,
] as const;

/**
 * Governed-access invariants keep self-serve workspace creation, temporary
 * support grants, and administrator appointments transient and accountable:
 * the self-serve limit is enforced inside the creation transaction, support
 * grants cannot be self-approved or stacked, and an appointment can only be
 * accepted once by the exact verified email it was issued to.
 */
export const governedAccessTriggerStatements = [
  `CREATE TRIGGER IF NOT EXISTS workspaces_limit_self_serve
   BEFORE INSERT ON workspaces
   WHEN NEW.self_serve = 1
   BEGIN
     SELECT CASE
       WHEN (
         SELECT COUNT(*)
         FROM workspaces
         WHERE created_by = NEW.created_by AND self_serve = 1
       ) >= CAST(COALESCE(
         (
           SELECT json_extract(value_json, '$')
           FROM platform_settings
           WHERE key = 'selfServiceWorkspaceLimit'
         ),
         1
       ) AS INTEGER)
       THEN RAISE(ABORT, 'self-serve workspace limit reached')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS support_access_requests_validate_decision
   BEFORE UPDATE OF status ON support_access_requests
   WHEN NEW.status != OLD.status
   BEGIN
     SELECT CASE
       WHEN OLD.status != 'pending'
         OR NEW.status NOT IN ('approved', 'denied', 'cancelled')
         OR NEW.decided_by IS NULL
         OR NEW.decided_at IS NULL
         OR (
           NEW.status = 'approved'
           AND (NEW.granted_role IS NULL OR NEW.grant_id IS NULL)
         )
         OR (NEW.status = 'approved' AND NEW.decided_by = NEW.requester_user_id)
       THEN RAISE(ABORT, 'invalid support request decision')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS support_access_grants_validate_insert
   BEFORE INSERT ON support_access_grants
   BEGIN
     SELECT CASE
       WHEN NOT EXISTS (
         SELECT 1
         FROM support_access_requests r
         WHERE r.id = NEW.request_id
           AND r.workspace_id = NEW.workspace_id
           AND r.status = 'approved'
           AND r.requester_user_id = NEW.user_id
           AND r.decided_by IS NOT NULL
           AND r.decided_by != r.requester_user_id
       )
       THEN RAISE(ABORT, 'support grant requires an approved request')
     END;
     SELECT CASE
       WHEN NEW.approved_by IS NULL OR NEW.approved_by = NEW.user_id
       THEN RAISE(ABORT, 'support grant cannot be self-approved')
     END;
     SELECT CASE
       WHEN unixepoch(NEW.expires_at) <= unixepoch('now')
       THEN RAISE(ABORT, 'support grant is already expired')
     END;
     SELECT CASE
       WHEN EXISTS (
         SELECT 1
         FROM support_access_grants g
         WHERE g.workspace_id = NEW.workspace_id
           AND g.user_id = NEW.user_id
           AND g.status = 'active'
       )
       THEN RAISE(ABORT, 'an active support grant already exists')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS support_access_grants_validate_update
   BEFORE UPDATE OF status ON support_access_grants
   WHEN NEW.status != OLD.status
   BEGIN
     SELECT CASE
       WHEN OLD.status != 'active'
         OR NEW.status NOT IN ('expired', 'revoked')
         OR NEW.ended_at IS NULL
         OR (NEW.status = 'revoked' AND NEW.revoked_by IS NULL)
       THEN RAISE(ABORT, 'invalid support grant transition')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS admin_appointments_single_accept
   BEFORE UPDATE OF accepted_by ON admin_appointments
   WHEN NEW.accepted_by IS NOT NULL
     AND (OLD.accepted_by IS NULL OR NEW.accepted_by != OLD.accepted_by)
   BEGIN
     SELECT CASE
       WHEN OLD.status != 'active'
         OR unixepoch(OLD.expires_at) <= unixepoch('now')
         OR NOT EXISTS (
           SELECT 1
           FROM workspace_members wm
           WHERE wm.workspace_id = OLD.workspace_id
             AND wm.user_id = NEW.accepted_by
             AND wm.status = 'active'
             AND lower(wm.email) = lower(OLD.email)
         )
       THEN RAISE(ABORT, 'appointment unavailable')
     END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS admin_appointments_status_transitions
   BEFORE UPDATE OF status ON admin_appointments
   WHEN NEW.status != OLD.status
   BEGIN
     SELECT CASE
       WHEN NOT (
         OLD.status = 'active'
         AND NEW.status IN ('accepted', 'revoked', 'expired')
       )
       THEN RAISE(ABORT, 'invalid appointment transition')
     END;
     SELECT CASE
       WHEN NEW.status = 'accepted'
         AND (NEW.accepted_by IS NULL OR NEW.accepted_at IS NULL)
       THEN RAISE(ABORT, 'appointment acceptance incomplete')
     END;
     SELECT CASE
       WHEN NEW.status = 'revoked'
         AND (NEW.revoked_by IS NULL OR NEW.revoked_at IS NULL)
       THEN RAISE(ABORT, 'appointment revocation incomplete')
     END;
   END`,
] as const;

export const securityTriggerStatements = [
  ...auditAppendOnlyTriggerStatements,
  ...tenantBoundaryTriggerStatements,
  ...workflowIntegrityTriggerStatements,
  ...governedAccessTriggerStatements,
] as const;
