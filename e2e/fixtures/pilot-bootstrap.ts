import type {
  BootstrapResponse,
  Guide,
  GuideRevisionView,
  WorkspaceSummary,
} from "../../lib/knowhow-types";

export const PILOT_WORKSPACE_ID = "workspace_alpha_ops";
export const PILOT_WORKSPACE_SLUG = "alpha-ops";
export const PUBLISHED_GUIDE_ID = "guide_published_onboarding";
export const REVIEW_GUIDE_ID = "guide_review_capture";
export const DELETION_CONFIRMATION = "DELETE BETA ARCHIVE";

const NOW = "2026-08-10T09:00:00.000Z";

function revision(
  input: Partial<GuideRevisionView> &
    Pick<GuideRevisionView, "id" | "number" | "status" | "title">,
): GuideRevisionView {
  return {
    summary: "A synthetic ordinary-business workflow used only for browser rehearsal.",
    category: "Pilot operations",
    tags: ["synthetic", "pilot"],
    systemReferences: ["Example portal"],
    steps: [
      {
        id: `${input.id}_step_1`,
        kind: "action",
        title: "Open the synthetic request",
        description: "Use only the generated example record and confirm its status.",
      },
    ],
    audiences: [{ kind: "workspace", label: "Entire workspace" }],
    authorId: "user_owner",
    authorName: "Pilot Owner",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: NOW,
    source: "manual",
    ...input,
  };
}

const publishedGuide: Guide = {
  id: PUBLISHED_GUIDE_ID,
  workspaceId: PILOT_WORKSPACE_ID,
  title: "Complete a synthetic access request",
  status: "published",
  restricted: false,
  canEdit: true,
  canReview: true,
  canPublish: true,
  canDelete: true,
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: NOW,
  publishedRevision: revision({
    id: "revision_published_1",
    number: 1,
    status: "published",
    title: "Complete a synthetic access request",
    reviewedBy: "user_reviewer",
    reviewedAt: "2026-08-09T10:00:00.000Z",
    publishedBy: "user_owner",
    publishedAt: "2026-08-09T11:00:00.000Z",
  }),
  workingRevision: null,
  revisionHistory: [
    {
      id: "revision_published_1",
      number: 1,
      status: "published",
      authorName: "Pilot Owner",
      createdAt: "2026-08-01T08:00:00.000Z",
      reviewedAt: "2026-08-09T10:00:00.000Z",
      publishedAt: "2026-08-09T11:00:00.000Z",
      source: "manual",
    },
  ],
};

const reviewGuide: Guide = {
  id: REVIEW_GUIDE_ID,
  workspaceId: PILOT_WORKSPACE_ID,
  title: "Review the captured onboarding flow",
  status: "review",
  restricted: true,
  canEdit: true,
  canReview: true,
  canPublish: true,
  canDelete: true,
  createdAt: "2026-08-08T08:00:00.000Z",
  updatedAt: NOW,
  screenshotsLockedAt: "2026-08-10T08:55:00.000Z",
  publishedRevision: null,
  workingRevision: revision({
    id: "revision_review_1",
    number: 1,
    status: "review",
    title: "Review the captured onboarding flow",
    source: "browser-capture",
    privacyReviewedAt: "2026-08-10T08:55:00.000Z",
    audiences: [{ kind: "group", subjectId: "group_operations", label: "Operations" }],
  }),
  revisionHistory: [
    {
      id: "revision_review_1",
      number: 1,
      status: "review",
      authorName: "Pilot Owner",
      createdAt: "2026-08-08T08:00:00.000Z",
      reviewedAt: undefined,
      publishedAt: undefined,
      source: "browser-capture",
    },
  ],
};

const activeSummary: WorkspaceSummary = {
  id: PILOT_WORKSPACE_ID,
  organizationId: "organization_alpha",
  name: "Alpha Operations",
  slug: PILOT_WORKSPACE_SLUG,
  status: "active",
  roles: ["administrator", "creator", "reviewer", "publisher", "viewer"],
  memberCount: 2,
  publishedCount: 1,
  draftCount: 1,
  createdAt: "2026-08-01T07:00:00.000Z",
  subscription: {
    access: "active",
    expiresAt: "2026-10-31T23:59:59.000Z",
    graceEndsAt: null,
    deletionEligibleAt: null,
  },
};

const suspendedSummary: WorkspaceSummary = {
  id: "workspace_beta_archive",
  organizationId: "organization_beta",
  name: "Beta Archive",
  slug: "beta-archive",
  status: "suspended",
  roles: [],
  memberCount: 3,
  publishedCount: 2,
  draftCount: 0,
  createdAt: "2026-01-01T07:00:00.000Z",
  subscription: {
    access: "deletion_pending",
    expiresAt: "2026-03-01T00:00:00.000Z",
    graceEndsAt: "2026-03-15T00:00:00.000Z",
    deletionEligibleAt: "2026-06-15T00:00:00.000Z",
  },
};

export function pilotBootstrap(): BootstrapResponse {
  return structuredClone({
    viewer: {
      id: "user_owner",
      email: "owner@alpha.example",
      name: "Pilot Owner",
      emailVerified: true,
      mfaEnabled: false,
      platformAdministrator: true,
      platformRoles: ["owner"],
      themePreference: "light",
    },
    workspaces: [activeSummary],
    activeWorkspace: {
      workspace: {
        ...activeSummary,
        settings: {
          logoUrl: null,
          accentColor: "#2563eb",
          clickTargetColor: "#f97316",
          removeBranding: false,
          allowRestrictedExports: false,
          watermarkExports: true,
        },
      },
      metrics: {
        members: 2,
        groups: 2,
        drafts: 0,
        reviews: 1,
        published: 1,
        captures: 1,
        views: 4,
        completions: 1,
        exports: 1,
        storageBytes: 4096,
        failedOperations: 0,
      },
      members: [
        {
          id: "member_owner",
          userId: "user_owner",
          email: "owner@alpha.example",
          name: "Pilot Owner",
          status: "active",
          roles: ["administrator", "creator", "reviewer", "publisher", "viewer"],
          capabilities: ["vault"],
          groupIds: ["group_all_members", "group_operations"],
          joinedAt: "2026-08-01T08:00:00.000Z",
        },
        {
          id: "member_teammate",
          userId: "user_teammate",
          email: "teammate@alpha.example",
          name: "Pilot Teammate",
          status: "active",
          roles: ["viewer"],
          capabilities: [],
          groupIds: ["group_all_members", "group_operations"],
          joinedAt: "2026-08-02T08:00:00.000Z",
        },
      ],
      groups: [
        {
          id: "group_all_members",
          name: "All members",
          description: "Automatic workspace audience",
          sensitive: false,
          kind: "all_members",
          memberCount: 2,
          memberIds: ["member_owner", "member_teammate"],
          createdAt: "2026-08-01T08:00:00.000Z",
        },
        {
          id: "group_operations",
          name: "Operations",
          description: "Synthetic pilot group",
          sensitive: false,
          kind: "custom",
          memberCount: 2,
          memberIds: ["member_owner", "member_teammate"],
          createdAt: "2026-08-01T08:00:00.000Z",
        },
      ],
      guides: [publishedGuide, reviewGuide],
      invitations: [
        {
          id: "invitation_existing",
          label: "Existing teammate rehearsal",
          role: "viewer",
          expiresAt: "2026-08-13T09:00:00.000Z",
          maxUses: 1,
          useCount: 0,
          revokedAt: null,
          createdAt: NOW,
        },
      ],
      supportRequests: [
        {
          id: "support_access_request",
          workspaceId: PILOT_WORKSPACE_ID,
          requesterUserId: "user_support",
          requesterEmail: "support@knowhow.example",
          requesterName: "KnowHow Support",
          requestedRole: "viewer",
          reason: "Investigate a synthetic failed operation without opening content.",
          requestedDurationHours: 2,
          status: "pending",
          grantedRole: null,
          createdAt: NOW,
        },
      ],
      supportGrants: [],
      supportTickets: [
        {
          id: "ticket_synthetic",
          subject: "Synthetic pilot question",
          status: "waiting_support",
          requesterUserId: "user_owner",
          requesterName: "Pilot Owner",
          createdAt: "2026-08-10T08:00:00.000Z",
          updatedAt: NOW,
          responseTargetAt: "2026-08-11T12:00:00.000Z",
          messages: [
            {
              id: "message_synthetic",
              sequence: 1,
              authorUserId: "user_owner",
              authorName: "Pilot Owner",
              authorKind: "customer",
              body: "Please confirm the synthetic rehearsal schedule.",
              createdAt: "2026-08-10T08:00:00.000Z",
            },
          ],
        },
      ],
      audits: [
        {
          id: "audit_publication",
          sequence: 1,
          action: "guide.published",
          actorName: "Pilot Owner",
          actorEmail: "owner@alpha.example",
          targetType: "guide",
          targetId: PUBLISHED_GUIDE_ID,
          targetLabel: "Complete a synthetic access request",
          summary: "Published synthetic guide revision 1.",
          occurredAt: "2026-08-09T11:00:00.000Z",
        },
      ],
      vaultItems: [],
      onboarding: {
        startedAt: "2026-08-01T08:00:00.000Z",
        completedAt: null,
        dismissedAt: null,
        steps: (
          [
            "workspace_readiness",
            "teammate_invitation",
            "extension_installation",
            "first_capture",
            "first_edit",
            "first_publication",
            "teammate_completion",
          ] as const
        ).map((id) => ({ id, completed: false, completedAt: null })),
      },
    },
    organizations: [
      {
        id: "organization_alpha",
        legalName: "Alpha Operations W.L.L.",
        displayName: "Alpha Operations",
        country: "QA",
        status: "active",
        roles: ["owner", "administrator"],
        branding: { logoMediaId: null, accentColor: "#2563eb" },
        members: [
          {
            id: "organization_member_owner",
            userId: "user_owner",
            email: "owner@alpha.example",
            name: "Pilot Owner",
            roles: ["owner", "administrator"],
            status: "active",
          },
        ],
        workspaces: [
          {
            id: PILOT_WORKSPACE_ID,
            name: "Alpha Operations",
            slug: PILOT_WORKSPACE_SLUG,
            status: "active",
          },
        ],
        appointments: [],
      },
    ],
    platform: {
      generatedAt: NOW,
      metrics: {
        users: 5,
        activeWorkspaces: 1,
        suspendedWorkspaces: 1,
        archivedWorkspaces: 0,
        drafts: 1,
        published: 3,
        captures: 2,
        views: 10,
        completions: 4,
        exports: 2,
        storageBytes: 8192,
        failedOperations: 0,
      },
      workspaces: [
        {
          ...activeSummary,
          administrators: [
            {
              userId: "user_owner",
              name: "Pilot Owner",
              email: "owner@alpha.example",
            },
          ],
          captures: 1,
          views: 4,
          completions: 1,
          exports: 1,
          storageBytes: 4096,
          failedOperations: 0,
          supportRequest: null,
          supportGrant: null,
        },
        {
          ...suspendedSummary,
          administrators: [
            {
              userId: "user_beta_owner",
              name: "Beta Owner",
              email: "owner@beta.example",
            },
          ],
          captures: 1,
          views: 6,
          completions: 3,
          exports: 1,
          storageBytes: 4096,
          failedOperations: 0,
          supportRequest: null,
          supportGrant: null,
        },
      ],
      settings: { selfServiceWorkspaceLimit: 0 },
      appointments: [],
      organizations: [
        {
          id: "organization_alpha",
          displayName: "Alpha Operations",
          legalName: "Alpha Operations W.L.L.",
          country: "QA",
          status: "active",
          workspaceCount: 1,
          createdAt: "2026-08-01T07:00:00.000Z",
        },
        {
          id: "organization_beta",
          displayName: "Beta Archive",
          legalName: "Beta Archive W.L.L.",
          country: "QA",
          status: "active",
          workspaceCount: 1,
          createdAt: "2026-01-01T07:00:00.000Z",
        },
      ],
      subscriptions: [
        {
          id: "subscription_alpha",
          workspaceId: PILOT_WORKSPACE_ID,
          kind: "pilot",
          status: "active",
          access: "active",
          startsAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-10-31T23:59:59.000Z",
          graceEndsAt: null,
          deletionEligibleAt: null,
        },
        {
          id: "subscription_beta",
          workspaceId: suspendedSummary.id,
          kind: "pilot",
          status: "expired",
          access: "deletion_pending",
          startsAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-03-01T00:00:00.000Z",
          graceEndsAt: "2026-03-15T00:00:00.000Z",
          deletionEligibleAt: "2026-06-15T00:00:00.000Z",
        },
      ],
      entitlements: [
        {
          id: "entitlement_members",
          workspaceId: PILOT_WORKSPACE_ID,
          kind: "member_limit",
          value: 25,
        },
      ],
      leads: [],
      activation: [
        {
          workspaceId: PILOT_WORKSPACE_ID,
          firstPublishedAt: "2026-08-09T11:00:00.000Z",
          firstTeammateViewAt: "2026-08-09T12:00:00.000Z",
          firstTeammateCompletionAt: "2026-08-09T12:30:00.000Z",
        },
      ],
      support: [
        {
          id: "ticket_synthetic",
          workspaceId: PILOT_WORKSPACE_ID,
          status: "waiting_support",
          requesterName: "Pilot Owner",
          responseTargetAt: "2026-08-11T12:00:00.000Z",
          updatedAt: NOW,
        },
      ],
      notificationFailures: [],
      deletionCases: [
        {
          id: "deletion_case_beta",
          organizationId: "organization_beta",
          workspaceId: suspendedSummary.id,
          status: "awaiting_approval",
          eligibleAt: "2026-06-15T00:00:00.000Z",
          confirmationText: DELETION_CONFIRMATION,
        },
      ],
      provisioningRuns: [
        {
          id: "provisioning_synthetic",
          currentStep: 3,
          completedSteps: [1, 2],
          updatedAt: NOW,
          steps: {},
        },
      ],
      betaAccess: { grants: [], events: [] },
      systemHealth: {
        failedNotifications: 0,
        overdueSupport: 0,
        expiringWithinSevenDays: 0,
        deletionApprovals: 1,
        failedOperations: 0,
      },
      platformAudits: [
        {
          id: "platform_audit_synthetic",
          workspaceId: suspendedSummary.id,
          action: "deletion.awaiting_approval",
          occurredAt: NOW,
        },
      ],
    },
  } satisfies BootstrapResponse);
}

export function recoveryBootstrap(): BootstrapResponse {
  const bootstrap = pilotBootstrap();
  const recoveryWorkspace = structuredClone(suspendedSummary);
  if (recoveryWorkspace.subscription) {
    recoveryWorkspace.subscription.access = "suspended";
  }
  return {
    viewer: bootstrap.viewer,
    workspaces: [recoveryWorkspace],
    activeWorkspace: null,
    recovery: {
      workspace: recoveryWorkspace,
      message:
        "This synthetic workspace is suspended while its retained export and extension-device recovery controls remain available.",
      contactEnabled: true,
      extensionActionsEnabled: true,
    },
  };
}
