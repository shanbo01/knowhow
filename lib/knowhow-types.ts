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

export type OrganizationRole =
  "owner" | "administrator" | "billing" | "security_auditor";

export type OrganizationAdministration = {
  id: string;
  legalName: string;
  displayName: string;
  country: string;
  status: string;
  roles: OrganizationRole[];
  branding: { logoMediaId: string | null; accentColor: string };
  members: Array<{
    id: string;
    userId: string;
    email: string;
    name: string;
    roles: OrganizationRole[];
    status: string;
  }>;
  workspaces: Array<{
    id: string;
    name: string;
    slug: string;
    status: string;
  }>;
  appointments: AdminAppointment[];
};

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
  organizationId: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  roles: WorkspaceRole[];
  memberCount: number;
  publishedCount: number;
  draftCount: number;
  createdAt: string;
  subscription?: {
    access:
      | "active"
      | "read_only"
      | "suspended"
      | "deletion_pending"
      | "deleting"
      | "deleted";
    expiresAt: string | null;
    graceEndsAt: string | null;
    deletionEligibleAt: string | null;
  };
};

export type WorkspaceSettings = {
  logoUrl: string | null;
  accentColor: string;
  clickTargetColor: string;
  removeBranding: boolean;
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

export type SupportMessage = {
  id: string;
  sequence: number;
  authorUserId: string;
  authorName: string;
  authorKind: "customer" | "support";
  body: string;
  createdAt: string;
};

export type SupportTicket = {
  id: string;
  subject: string;
  status: "open" | "waiting_customer" | "waiting_support" | "closed";
  requesterUserId: string;
  requesterName: string;
  createdAt: string;
  updatedAt: string;
  responseTargetAt: string;
  messages: SupportMessage[];
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

export type BetaAccessGrant = {
  id: string;
  label: string;
  exactEmail: string | null;
  status: "active" | "exhausted" | "expired" | "revoked";
  maxUses: number;
  usedCount: number;
  reservedCount: number;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
};

export type BetaAccessEvent = {
  id: string;
  grantId: string;
  kind: "created" | "reservation" | "consumed" | "released" | "revoked";
  status: "recorded" | "reserved" | "consumed" | "released";
  email: string | null;
  userId: string | null;
  occurredAt: string;
  expiresAt: string | null;
  reason: string | null;
};

export type BetaAdmissionSummary = {
  grantId: string;
  email: string;
  consumedAt: string;
  maxUses: number;
  usedCount: number;
};

export type SelfServiceSetup = {
  runId: string;
  status: "draft" | "completed";
  draft: {
    organizationName?: string;
    legalName?: string;
    country?: string;
    workspaceName?: string;
    accentColor?: string;
    inviteEmail?: string;
  };
  result?: {
    organizationId: string;
    workspaceId: string;
    workspaceSlug: string;
  };
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
  simulation?: {
    synthetic: true;
    disposable: true;
    lastState: string;
    lastSimulatedAt: string | null;
  };
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

export type PlatformPricingCatalog = {
  id: string;
  slug: string;
  schemaVersion: 1;
  catalogVersion: string;
  name: string;
  description: string;
  status: "draft" | "scheduled" | "active" | "retired";
  currency: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  selfServiceTrial: boolean;
  trial: { days: number; graceDays: number; retentionDays: number };
  baseWorkspace: {
    amountMinor: number | null;
    unit: "workspace_month";
    includedActiveCreators: number;
    includedActiveUsers: number;
    includedStorageBytes: number;
  };
  additionalUsage: {
    creator: {
      amountMinor: number | null;
      unit: "active_creator_month";
    };
    user: { amountMinor: number | null; unit: "active_user_month" };
    storage: { amountMinor: number | null; unit: "storage_gb_month" };
  };
  features: Array<{
    key: string;
    label: string;
    included: boolean;
    note: string;
  }>;
  services: Array<{
    key: string;
    label: string;
    included: boolean;
    note: string;
  }>;
  futureOptions: {
    ssoScim: {
      amountMinor: number | null;
      unit: "manual_contract";
      available: boolean;
      included: boolean;
    };
    supportSla: {
      amountMinor: number | null;
      unit: "manual_contract";
      available: boolean;
      included: boolean;
      level: string;
      responseTargetHours: number | null;
    };
    sovereignDeployment: {
      amountMinor: number | null;
      unit: "manual_contract";
      available: boolean;
      included: boolean;
    };
    dedicatedDeployment: {
      amountMinor: number | null;
      unit: "manual_contract";
      available: boolean;
      included: boolean;
    };
  };
  securityFundamentalsIncluded: true;
  paymentsEnabled: false;
  manualContractAllowed: true;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  retiredAt?: string;
  retiredBy?: string;
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

export type PlatformProvisioningRun = {
  id: string;
  currentStep: number;
  completedSteps: number[];
  updatedAt: string;
  steps?: Record<string, Record<string, unknown>>;
};

export type PlatformProvisioningResult = {
  organizationId: string;
  workspaceId: string;
  runId: string;
  workspaces: Array<{
    workspaceId: string;
    appointments: Array<{ email: string; token: string }>;
  }>;
  invitations: Array<{
    email: string;
    workspaceId: string;
    token: string;
    role: WorkspaceRole;
  }>;
};

export type Viewer = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  platformAdministrator: boolean;
  platformRoles?: Array<
    "owner" | "operations" | "support" | "billing" | "auditor"
  >;
  themePreference?: ThemeMode;
  betaAdmission?: BetaAdmissionSummary;
  selfServiceSetup?: SelfServiceSetup;
};

export type WorkspaceBundle = {
  workspace: WorkspaceSummary & { settings: WorkspaceSettings };
  metrics: WorkspaceMetrics;
  members: WorkspaceMember[];
  groups: WorkspaceGroup[];
  guides: Guide[];
  invitations: Invitation[];
  supportRequests: SupportAccessRequest[];
  supportGrants: SupportAccessGrant[];
  supportTickets: SupportTicket[];
  audits: AuditEvent[];
  vaultItems: VaultItem[];
  onboarding: {
    startedAt: string;
    completedAt: string | null;
    dismissedAt: string | null;
    steps: Array<{
      id:
        | "workspace_readiness"
        | "teammate_invitation"
        | "extension_installation"
        | "first_capture"
        | "first_edit"
        | "first_publication"
        | "teammate_completion";
      completed: boolean;
      completedAt: string | null;
    }>;
  };
};

export type BootstrapResponse = {
  viewer: Viewer;
  workspaces: WorkspaceSummary[];
  activeWorkspace: WorkspaceBundle | null;
  recovery?: {
    workspace: WorkspaceSummary;
    message: string;
    contactEnabled: boolean;
    extensionActionsEnabled: boolean;
  };
  organizations?: OrganizationAdministration[];
  platform?: {
    generatedAt: string;
    metrics: PlatformMetrics;
    workspaces: PlatformWorkspace[];
    settings: PlatformSettings;
    appointments: AdminAppointment[];
    organizations: Array<{
      id: string;
      displayName: string;
      legalName: string;
      country: string;
      status: string;
      workspaceCount: number;
      createdAt: string;
    }>;
    subscriptions: Array<{
      id: string;
      workspaceId: string;
      kind: string;
      status: string;
      access: string;
      startsAt: string;
      expiresAt: string | null;
      graceEndsAt: string | null;
      deletionEligibleAt: string | null;
    }>;
    entitlements: Array<{
      id: string;
      workspaceId: string;
      kind: string;
      value: string | number | boolean;
    }>;
    leads: Array<{
      id: string;
      kind: string;
      status: string;
      organization: string;
      contactName: string;
      email: string;
      occurredAt: string;
    }>;
    activation: Array<{
      workspaceId: string;
      firstPublishedAt: string | null;
      firstTeammateViewAt: string | null;
      firstTeammateCompletionAt: string | null;
    }>;
    support: Array<{
      id: string;
      workspaceId: string;
      status: string;
      requesterName: string;
      responseTargetAt: string;
      updatedAt: string;
    }>;
    notificationFailures: Array<{
      id: string;
      workspaceId: string;
      kind: string;
      attempts: number;
      lastFailedAt: string;
    }>;
    deletionCases: Array<{
      id: string;
      organizationId: string;
      workspaceId: string;
      status: string;
      eligibleAt: string;
      confirmationText?: string;
    }>;
    provisioningRuns: PlatformProvisioningRun[];
    betaAccess: {
      grants: BetaAccessGrant[];
      events: BetaAccessEvent[];
    };
    pricingCatalogs?: PlatformPricingCatalog[];
    lifecycleSimulation?: {
      enabled: boolean;
      environment: string;
      productionForbidden: true;
      createConfirmation: string;
      states: ReadonlyArray<
        | "trial_active"
        | "near_expiry"
        | "read_only"
        | "suspended"
        | "retention"
        | "deletion_eligible"
        | "pending_deletion"
      >;
    };
    systemHealth: {
      failedNotifications: number;
      overdueSupport: number;
      expiringWithinSevenDays: number;
      deletionApprovals: number;
      failedOperations: number;
    };
    platformAudits: Array<{
      id: string;
      workspaceId: string;
      action: string;
      occurredAt: string;
    }>;
  };
};

export type ApiErrorPayload = {
  error: string;
  code?: string;
  requestId?: string;
};
