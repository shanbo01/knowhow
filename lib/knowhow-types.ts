// These are UI/API view models. Governed persistence and exports use the
// immutable contract in guide-contracts.ts; the server adapter is the only
// place that converts editable view blocks into that canonical contract.
export { WORKSPACE_ROLES } from "./guide-contracts";
export type { WorkspaceRole } from "./guide-contracts";
import type { WorkspaceRole } from "./guide-contracts";
export type WorkspaceStatus = "active" | "suspended" | "archived";
export type RevisionStatus = "draft" | "review" | "published" | "archived";
export type AudienceKind = "workspace" | "group" | "user";
export type ThemeMode = "light" | "dark" | "system";

export type EditorBlockKind = "action" | "heading" | "note" | "warning";

export type EditorBlock = {
  id: string;
  kind: EditorBlockKind;
  title: string;
  description: string;
  screenshotMediaId?: string;
  screenshotUrl?: string;
  crop?: { x: number; y: number; width: number; height: number };
  annotations?: Array<{
    id: string;
    kind: "click" | "arrow" | "box" | "text";
    x: number;
    y: number;
    width?: number;
    height?: number;
    // Arrow tail/head, normalized to the full screenshot. When present, the
    // arrow is drawn from (x, y) to (x2, y2) in the exact dragged direction
    // instead of the fixed bottom-left-to-top-right diagonal fallback.
    x2?: number;
    y2?: number;
    text?: string;
    color?: string;
  }>;
  /**
   * Non-destructive blur regions. While the guide is not yet
   * `screenshotsLocked`, these render as a live blur overlay and can be
   * freely added/removed. The first time the guide is submitted for review,
   * the editor flattens them into the image pixels and marks them `applied`;
   * after that they can never be reverted for this guide.
   */
  redactions?: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    applied: boolean;
  }>;
};

export type Audience = {
  id?: string;
  kind: AudienceKind;
  subjectId?: string;
  label?: string;
};

export type GuideRevisionView = {
  id: string;
  number: number;
  status: RevisionStatus;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  systemReferences: string[];
  steps: EditorBlock[];
  audiences: Audience[];
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  publishedBy?: string;
  publishedAt?: string;
  privacyReviewedAt?: string;
  source: "manual" | "browser-capture";
};

export type Guide = {
  id: string;
  workspaceId: string;
  title: string;
  status: RevisionStatus;
  restricted: boolean;
  canEdit: boolean;
  canReview: boolean;
  canPublish: boolean;
  canDelete: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * Set once this guide's first review was ever submitted. From then on,
   * screenshot redactions are permanent and the redact tool becomes
   * read-only for existing regions.
   */
  screenshotsLockedAt?: string;
  publishedRevision: GuideRevisionView | null;
  workingRevision: GuideRevisionView | null;
  revisionHistory?: Array<
    Pick<
      GuideRevisionView,
      | "id"
      | "number"
      | "status"
      | "authorName"
      | "createdAt"
      | "reviewedAt"
      | "publishedAt"
      | "source"
    >
  >;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  roles: WorkspaceRole[];
  memberCount: number;
  publishedCount: number;
  draftCount: number;
  createdAt: string;
};

export type WorkspaceSettings = {
  logoUrl: string | null;
  accentColor: string;
  clickTargetColor: string;
  removeBranding: boolean;
  allowedDomains: string[];
  excludedCaptureHosts: string[];
  allowRestrictedExports: boolean;
  watermarkExports: boolean;
};

export type WorkspaceMember = {
  id: string;
  userId: string;
  email: string;
  name: string;
  status: "active" | "invited" | "suspended";
  roles: WorkspaceRole[];
  capabilities: Array<"vault">;
  groupIds: string[];
  joinedAt?: string;
};

export type WorkspaceGroup = {
  id: string;
  name: string;
  description: string;
  sensitive: boolean;
  kind?: "all_members" | "custom";
  memberCount: number;
  memberIds: string[];
  createdAt: string;
};

export type Invitation = {
  id: string;
  label: string;
  role: WorkspaceRole;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  revokedAt: string | null;
  createdAt: string;
  inviteUrl?: string;
};

export type VaultItem = {
  id: string;
  title: string;
  encryptedEnvelopeJson: string;
  metadataJson: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type JoinRequest = {
  id: string;
  userId: string;
  email: string;
  name: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
};

export type SupportAccessRequest = {
  id: string;
  workspaceId: string;
  requesterUserId: string;
  requesterEmail: string;
  requesterName: string;
  requestedRole: WorkspaceRole;
  reason: string;
  requestedDurationHours: number;
  status: "pending" | "approved" | "denied" | "cancelled";
  grantedRole: WorkspaceRole | null;
  createdAt: string;
};

export type SupportAccessGrant = {
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
};

export type AdminAppointment = {
  id: string;
  workspaceId: string;
  email: string;
  status: "active" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
};

export type PlatformSettings = {
  selfServiceWorkspaceLimit: number;
};

export type GuideSearchResult = {
  guideId: string;
  revisionId: string;
  title: string;
  excerpt: string;
  status: RevisionStatus;
  restricted: boolean;
  updatedAt: string;
};

export type AuditEvent = {
  id: string;
  sequence: number;
  action: string;
  actorName: string;
  actorEmail: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  summary: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
};

export type WorkspaceMetrics = {
  members: number;
  groups: number;
  drafts: number;
  reviews: number;
  published: number;
  captures: number;
  views: number;
  completions: number;
  exports: number;
  storageBytes: number;
  failedOperations: number;
};

export type PlatformWorkspace = WorkspaceSummary & {
  administrators: Array<{ userId: string; name: string; email: string }>;
  captures: number;
  views: number;
  completions: number;
  exports: number;
  storageBytes: number;
  failedOperations: number;
  /** The platform administrator's most recent support request, if any. */
  supportRequest?: {
    id: string;
    status: "pending" | "approved" | "denied" | "cancelled";
    requestedRole: WorkspaceRole;
    requestedDurationHours: number;
    reason: string;
    createdAt: string;
  } | null;
  /** An active support grant the platform administrator holds, if any. */
  supportGrant?: {
    id: string;
    role: WorkspaceRole;
    grantedAt: string;
    expiresAt: string;
  } | null;
};

export type PlatformMetrics = {
  users: number;
  activeWorkspaces: number;
  suspendedWorkspaces: number;
  archivedWorkspaces: number;
  drafts: number;
  published: number;
  captures: number;
  views: number;
  completions: number;
  exports: number;
  storageBytes: number;
  failedOperations: number;
};

export type Viewer = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  platformAdministrator: boolean;
  themePreference?: ThemeMode;
};

export type WorkspaceBundle = {
  workspace: WorkspaceSummary & { settings: WorkspaceSettings };
  metrics: WorkspaceMetrics;
  members: WorkspaceMember[];
  groups: WorkspaceGroup[];
  guides: Guide[];
  invitations: Invitation[];
  joinRequests: JoinRequest[];
  supportRequests: SupportAccessRequest[];
  supportGrants: SupportAccessGrant[];
  audits: AuditEvent[];
  vaultItems: VaultItem[];
};

export type BootstrapResponse = {
  viewer: Viewer;
  workspaces: WorkspaceSummary[];
  eligibleWorkspaces?: WorkspaceSummary[];
  activeWorkspace: WorkspaceBundle | null;
  platform?: {
    metrics: PlatformMetrics;
    workspaces: PlatformWorkspace[];
    settings: PlatformSettings;
    appointments: AdminAppointment[];
  };
};

export type ApiErrorPayload = {
  error: string;
  code?: string;
  requestId?: string;
};
