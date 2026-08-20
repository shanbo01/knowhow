import type {
  AuditEvent,
  BootstrapResponse,
  Guide,
  GuideRevisionView,
  Invitation,
  OrganizationAdministration,
  OrganizationRole,
  SelfServiceSetup,
  SupportAccessGrant,
  SupportAccessRequest,
  SupportTicket,
  VaultItem,
  WorkspaceBundle,
  WorkspaceGroup,
  WorkspaceMember,
  WorkspaceMetrics,
  WorkspaceSettings,
  WorkspaceSummary,
} from "../knowhow-types";
import { isCapturedGuideSource } from "../guide-contracts";
import type { DesktopDeviceDetails } from "./desktop-auth-service";
import {
  AccessService,
  type PlatformRole,
  type WorkspaceAccess,
} from "./access-service";
import { BetaAccessService } from "./beta-access-service";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  decodePayload,
  type GuideAudienceRecord,
  type GuideRecord,
  type OrganizationRecord,
  type GuideStepRecord,
  type RevisionRecord,
  type SupportGrantRecord,
  type WorkspaceGroupRecord,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
} from "./domain-records";
import { TABLES } from "./appwrite-resources";
import { authorize } from "./policy";
import type { RecordData, RecordStore, StoredRecord } from "./record-store";
import type { AuthenticatedIdentity } from "./session-identity";
import { PricingCatalogService } from "./pricing-catalog-service";
import { PlatformQueryService } from "./platform-query-service";
import { toWorkspaceSubscriptionView } from "./commercial-plan";
import { EntitlementService } from "./entitlement-service";
import type { WorkspaceEntitlements } from "../knowhow-types";

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function memberView(row: StoredRecord<RecordData>): WorkspaceMember {
  const details = decodePayload<WorkspaceMemberRecord>(row, {
    name: stringValue(row.email),
    roles: [],
    capabilities: [],
    groupIds: [],
  });
  return {
    id: row.$id,
    userId: stringValue(row.user_id),
    email: stringValue(row.email),
    name: details.name,
    status:
      row.status === "suspended"
        ? "suspended"
        : row.status === "invited"
          ? "invited"
          : "active",
    roles: details.roles,
    capabilities: details.capabilities,
    groupIds: details.groupIds,
    joinedAt: details.joinedAt,
  };
}

function groupView(
  row: StoredRecord<RecordData>,
  membershipRows: Array<StoredRecord<RecordData>>,
): WorkspaceGroup {
  const details = decodePayload<WorkspaceGroupRecord>(row, {
    name: "Group",
    description: "",
    sensitive: false,
    kind: "custom",
    createdAt: row.$createdAt,
  });
  const memberIds = membershipRows
    .filter((membership) => membership.subject_id === row.$id)
    .map((membership) => stringValue(membership.user_id))
    .filter(Boolean);
  return { id: row.$id, ...details, memberIds, memberCount: memberIds.length };
}

function summary(
  row: StoredRecord<RecordData>,
  workspace: WorkspaceRecord,
  roles: WorkspaceSummary["roles"],
  memberCount: number,
  guides: Guide[],
  lifecycle?: WorkspaceAccess["lifecycle"],
  subscription?: WorkspaceAccess["subscription"],
): WorkspaceSummary {
  const subscriptionView = toWorkspaceSubscriptionView(
    subscription ?? null,
    lifecycle ?? {
      access: "active",
      expiresAt: null,
      graceEndsAt: null,
      deletionEligibleAt: null,
    },
  );
  return {
    id: row.$id,
    organizationId: workspace.organizationId,
    name: workspace.name,
    slug: workspace.slug,
    status: workspace.status,
    roles,
    memberCount,
    publishedCount: guides.filter((guide) => guide.publishedRevision).length,
    draftCount: guides.filter((guide) => guide.workingRevision).length,
    createdAt: workspace.createdAt,
    ...(subscriptionView ? { subscription: subscriptionView } : {}),
  };
}

type GuideRows = {
  guides: Array<StoredRecord<RecordData>>;
  revisions: Array<StoredRecord<RecordData>>;
  steps: Array<StoredRecord<RecordData>>;
  audiences: Array<StoredRecord<RecordData>>;
  reviews: Array<StoredRecord<RecordData>>;
};

function revisionView(
  row: StoredRecord<RecordData>,
  source: RevisionRecord,
  rows: GuideRows,
  memberNames: Map<string, string>,
): GuideRevisionView {
  const steps = rows.steps
    .filter((step) => step.subject_id === row.$id)
    .sort(
      (left, right) => numberValue(left.sequence) - numberValue(right.sequence),
    )
    .map((step) => decodePayload<GuideStepRecord>(step, null as never))
    .filter(Boolean);
  const audiences = rows.audiences
    .filter((audience) => audience.subject_id === row.$id)
    .map((audience) =>
      decodePayload<GuideAudienceRecord>(audience, null as never),
    )
    .filter(Boolean);
  return {
    id: row.$id,
    number: source.number,
    status: source.status,
    title: source.title,
    summary: source.summary,
    category: source.category,
    tags: source.tags,
    systemReferences: source.systemReferences,
    steps,
    audiences,
    authorId: source.authorId,
    authorName: memberNames.get(source.authorId) ?? "Former member",
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    reviewedBy: source.reviewedBy,
    reviewedAt: source.reviewedAt,
    publishedBy: source.publishedBy,
    publishedAt: source.publishedAt,
    privacyReviewedAt: source.privacyReviewedAt,
    source: source.source,
  };
}

function isAudienceMember(
  revisionId: string,
  userId: string,
  groupIds: ReadonlySet<string>,
  rows: GuideRows,
) {
  return rows.audiences
    .filter((row) => row.subject_id === revisionId)
    .some((row) => {
      const audience = decodePayload<GuideAudienceRecord>(row, null as never);
      if (!audience) return false;
      if (audience.kind === "workspace") return true;
      if (audience.kind === "user") return audience.subjectId === userId;
      return Boolean(audience.subjectId && groupIds.has(audience.subjectId));
    });
}

function reviewApproved(revisionId: string, rows: GuideRows) {
  return rows.reviews.some(
    (row) => row.subject_id === revisionId && row.status === "approved",
  );
}

function assignedReviewer(revisionId: string, userId: string, rows: GuideRows) {
  return rows.reviews.some(
    (row) => row.subject_id === revisionId && row.user_id === userId,
  );
}

async function loadGuideRows(
  store: RecordStore,
  workspaceId: string,
): Promise<GuideRows> {
  const filters = [{ field: "workspace_id", value: workspaceId }] as const;
  const [guides, revisions, steps, audiences, reviews] = await Promise.all([
    store.list(TABLES.guides, { filters }),
    store.list(TABLES.guideRevisions, { filters }),
    store.list(TABLES.guideSteps, { filters }),
    store.list(TABLES.guideAudiences, { filters }),
    store.list(TABLES.reviewAssignments, { filters }),
  ]);
  return { guides, revisions, steps, audiences, reviews };
}

function guideEngagement(
  guideId: string,
  userId: string,
  usageRows: Array<StoredRecord<RecordData>>,
) {
  const viewers = new Set<string>();
  let likeCount = 0;
  let dislikeCount = 0;
  let viewerReaction: "like" | "dislike" | null = null;
  for (const row of usageRows) {
    if (stringValue(row.subject_id) !== guideId) continue;
    if (row.kind === "guide.viewed") {
      viewers.add(stringValue(row.user_id));
    } else if (row.kind === "guide.liked") {
      likeCount += 1;
      if (stringValue(row.user_id) === userId) viewerReaction = "like";
    } else if (row.kind === "guide.disliked") {
      dislikeCount += 1;
      if (stringValue(row.user_id) === userId) viewerReaction = "dislike";
    }
  }
  return {
    viewCount: viewers.size,
    likeCount,
    dislikeCount,
    viewerReaction,
  };
}

function hydrateGuides(
  identity: AuthenticatedIdentity,
  access: WorkspaceAccess,
  rows: GuideRows,
  members: WorkspaceMember[],
  requireReviewBeforePublish: boolean,
  usageRows: Array<StoredRecord<RecordData>> = [],
) {
  const accessServiceContext = {
    isVerifiedIdentity: true,
    membershipStatus: access.membershipStatus,
    workspaceStatus: access.workspace.status,
    roles: access.roles,
    capabilities: access.capabilities,
    ...(access.supportGrant
      ? {
          supportGrant: {
            role: access.supportGrant.role,
            expiresAt: access.supportGrant.expiresAt,
          },
        }
      : {}),
  } as const;
  const memberNames = new Map(
    members.map((member) => [member.userId, member.name]),
  );
  const viewer = members.find((member) => member.userId === identity.userId);
  const groupIds = new Set(viewer?.groupIds ?? []);
  const guides: Guide[] = [];

  for (const row of rows.guides) {
    const source = decodePayload<GuideRecord>(row, null as never);
    if (!source || source.deletedAt || row.status === "deleted") continue;
    const revisionRows = rows.revisions
      .filter((revision) => revision.subject_id === row.$id)
      .sort(
        (left, right) => numberValue(left.version) - numberValue(right.version),
      );
    const revisionSources = new Map(
      revisionRows.map((revision) => [
        revision.$id,
        decodePayload<RevisionRecord>(revision, null as never),
      ]),
    );
    const permitted = (revisionId: string | null) => {
      if (!revisionId) return null;
      const revisionRow = revisionRows.find(
        (revision) => revision.$id === revisionId,
      );
      const revision = revisionSources.get(revisionId);
      if (!revisionRow || !revision) return null;
      const facts = {
        revisionStatus: revision.status,
        sourceType:
          isCapturedGuideSource(revision.source)
            ? ("capture" as const)
            : ("manual" as const),
        isAuthor: revision.authorId === identity.userId,
        isAssignedReviewer: assignedReviewer(revisionId, identity.userId, rows),
        isAudienceMember: isAudienceMember(
          revisionId,
          identity.userId,
          groupIds,
          rows,
        ),
        exportAllowed: true,
        privacyReviewed:
          revision.source === "manual" || Boolean(revision.privacyReviewedAt),
        reviewApproved: reviewApproved(revisionId, rows),
        requireReviewBeforePublish,
      };
      if (
        !authorize("guide.read", { ...accessServiceContext, guide: facts })
          .allowed
      )
        return null;
      return { row: revisionRow, source: revision, facts };
    };
    const working = permitted(source.workingRevisionId);
    const published = permitted(source.publishedRevisionId);
    if (!working && !published) continue;
    const active = (working ?? published)!;
    const workingView = working
      ? revisionView(working.row, working.source, rows, memberNames)
      : null;
    const publishedView = published
      ? revisionView(published.row, published.source, rows, memberNames)
      : null;
    const editFacts = working?.facts ?? {
      revisionStatus: "draft" as const,
      isAuthor: source.authorUserId === identity.userId,
      requireReviewBeforePublish,
    };
    const canPublishWorking = working
      ? authorize("guide.publish", {
          ...accessServiceContext,
          guide: working.facts,
        }).allowed
      : false;
    const canChangeLiveAudience =
      Boolean(published) &&
      (access.roles.includes("publisher") ||
        (source.authorUserId === identity.userId &&
          (access.roles.includes("creator") || access.roles.includes("administrator")) &&
          !requireReviewBeforePublish));
    guides.push({
      id: row.$id,
      workspaceId: access.workspaceRow.$id,
      title: source.title,
      status: active.source.status,
      restricted: Boolean(
        publishedView &&
        !publishedView.audiences.some(
          (audience) => audience.kind === "workspace",
        ),
      ),
      canEdit: authorize("guide.update", {
        ...accessServiceContext,
        guide: editFacts,
      }).allowed,
      canReview: working
        ? authorize("guide.review", {
            ...accessServiceContext,
            guide: working.facts,
          }).allowed
        : false,
      canPublish: canPublishWorking,
      canShare: canPublishWorking || canChangeLiveAudience,
      canArchive: authorize("guide.archive", accessServiceContext).allowed,
      canDelete:
        access.roles.includes("publisher") ||
        (source.authorUserId === identity.userId &&
          (access.roles.includes("creator") || access.roles.includes("administrator")) &&
          !source.publishedRevisionId),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      screenshotsLockedAt: source.screenshotsLockedAt ?? undefined,
      publishedRevision: publishedView,
      workingRevision: workingView,
      ...guideEngagement(row.$id, identity.userId, usageRows),
      revisionHistory: revisionRows.map((revisionRow) => {
        const revision = revisionSources.get(revisionRow.$id)!;
        return {
          id: revisionRow.$id,
          number: revision.number,
          status: revision.status,
          authorName: memberNames.get(revision.authorId) ?? "Former member",
          createdAt: revision.createdAt,
          reviewedAt: revision.reviewedAt,
          publishedAt: revision.publishedAt,
          source: revision.source,
        };
      }),
    });
  }
  return guides;
}

function metricView(
  members: WorkspaceMember[],
  groups: WorkspaceGroup[],
  guides: Guide[],
  usageRows: Array<StoredRecord<RecordData>>,
  mediaRows: Array<StoredRecord<RecordData>>,
): WorkspaceMetrics {
  const count = (kind: string) =>
    usageRows.filter((row) => row.kind === kind).length;
  return {
    members: members.filter((member) => member.status === "active").length,
    groups: groups.length,
    drafts: guides.filter((guide) => guide.workingRevision?.status === "draft")
      .length,
    reviews: guides.filter(
      (guide) => guide.workingRevision?.status === "review",
    ).length,
    published: guides.filter((guide) => guide.publishedRevision).length,
    captures: count("capture.completed"),
    views: count("guide.viewed"),
    completions: count("guide.completed"),
    exports: count("guide.exported"),
    storageBytes: mediaRows.reduce((total, row) => {
      const value = decodePayload<{ byteSize?: number }>(row, {});
      return total + numberValue(value.byteSize);
    }, 0),
    failedOperations: count("operation.failed"),
  };
}

export class BootstrapService {
  private readonly access: AccessService;

  constructor(private readonly store: RecordStore) {
    this.access = new AccessService(store);
  }

  private async workspaceBundle(
    identity: AuthenticatedIdentity,
    access: WorkspaceAccess,
  ): Promise<WorkspaceBundle> {
    const workspaceId = access.workspaceRow.$id;
    const filters = [{ field: "workspace_id", value: workspaceId }] as const;
    const [
      settingRows,
      memberRows,
      groupRows,
      groupMembershipRows,
      guideRows,
      invitationRows,
      supportCases,
      supportGrantRows,
      supportTicketRows,
      supportMessageRows,
      auditRows,
      usageRows,
      mediaRows,
      onboardingRows,
      extensionDeviceRows,
      desktopDeviceRows,
    ] = await Promise.all([
      this.store.list(TABLES.workspaceSettings, { filters, limit: 1 }),
      this.store.list(TABLES.workspaceMembers, { filters }),
      this.store.list(TABLES.workspaceGroups, { filters }),
      this.store.list(TABLES.groupMemberships, { filters }),
      loadGuideRows(this.store, workspaceId),
      this.store.list(TABLES.invitations, { filters }),
      this.store.list(TABLES.supportCases, { filters }),
      this.store.list(TABLES.supportGrants, { filters }),
      this.store.list(TABLES.supportTickets, { filters, order: "desc" }),
      this.store.list(TABLES.supportMessages, {
        filters,
        orderBy: "sequence",
        order: "asc",
      }),
      this.store.list(TABLES.auditSegments, {
        filters,
        orderBy: "sequence",
        order: "desc",
        limit: 500,
      }),
      this.store.list(TABLES.usageEvents, { filters }),
      this.store.list(TABLES.privateMedia, { filters }),
      this.store.list(TABLES.onboardingProgress, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: identity.userId },
        ],
        limit: 1,
      }),
      this.store.list(TABLES.extensionDevices, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: identity.userId },
          { field: "status", value: "active" },
          { field: "kind", value: "browser-extension" },
        ],
        limit: 20,
      }),
      this.store.list(TABLES.extensionDevices, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: identity.userId },
          { field: "status", value: "active" },
          { field: "kind", value: "desktop-windows" },
        ],
        order: "desc",
        limit: 20,
      }),
    ]);
    const members = memberRows.map(memberView);
    const groups = groupRows.map((row) => groupView(row, groupMembershipRows));
    const publishedRevisionIds = new Set(
      guideRows.guides
        .map((row) => decodePayload<GuideRecord>(row, null as never)?.publishedRevisionId)
        .filter((id): id is string => Boolean(id)),
    );
    for (const group of groups) {
      group.publishedGuideCount = guideRows.audiences.filter((row) => {
        if (!publishedRevisionIds.has(stringValue(row.subject_id))) return false;
        const audience = decodePayload<GuideAudienceRecord>(row, null as never);
        return audience?.kind === "group" && audience.subjectId === group.id;
      }).length;
    }
    for (const member of members) {
      member.groupIds = groupMembershipRows
        .filter((row) => row.user_id === member.userId)
        .map((row) => stringValue(row.subject_id));
    }
    const settings = settingRows[0]
      ? {
          ...DEFAULT_WORKSPACE_SETTINGS,
          ...decodePayload<Partial<WorkspaceSettings>>(settingRows[0], {}),
        }
      : DEFAULT_WORKSPACE_SETTINGS;
    const guides = hydrateGuides(
      identity,
      access,
      guideRows,
      members,
      settings.requireReviewBeforePublish,
      usageRows,
    );
    const isAdmin =
      access.roles.includes("administrator") && !access.supportGrant;
    const metrics = metricView(members, groups, guides, usageRows, mediaRows);
    const workspace = summary(
      access.workspaceRow,
      access.workspace,
      access.roles,
      members.length,
      guides,
      access.lifecycle,
      access.subscription,
    );
    const entitlements =
      (await new EntitlementService(this.store, workspaceId).snapshot()) as WorkspaceEntitlements;
    const onboardingRecord = onboardingRows[0]
      ? decodePayload<{
          startedAt?: string;
          readinessConfirmedAt?: string;
          dismissedAt?: string;
          extensionPinnedAt?: string;
        }>(onboardingRows[0], {})
      : {};
    const firstUsageAt = (kind: string) =>
      usageRows
        .filter((row) => row.kind === kind)
        .map((row) => stringValue(row.occurred_at, row.$createdAt))
        .sort()[0] ?? null;
    const invitedAt =
      [
        ...invitationRows.map((row) => row.$createdAt),
        ...memberRows
          .filter((row) => row.user_id !== identity.userId)
          .map((row) => row.$createdAt),
      ].sort()[0] ?? null;
    const firstPublishedAt =
      firstUsageAt("activation.first_guide_published") ??
      firstUsageAt("guide.published");
    const firstGuideAt =
      guideRows.guides
        .map((row) => stringValue(row.$createdAt))
        .filter(Boolean)
        .sort()[0] ?? firstUsageAt("capture.completed");
    const pinnedAt =
      [
        ...(typeof onboardingRecord.extensionPinnedAt === "string"
          ? [onboardingRecord.extensionPinnedAt]
          : []),
        ...extensionDeviceRows
          .map(
            (row) =>
              decodePayload<{ toolbarPinnedAt?: string }>(row, {}).toolbarPinnedAt,
          )
          .filter((value): value is string => Boolean(value)),
      ].sort()[0] ?? null;
    const onboardingSteps: WorkspaceBundle["onboarding"]["steps"] = [
      {
        id: "workspace_readiness",
        completed: Boolean(onboardingRecord.readinessConfirmedAt),
        completedAt: onboardingRecord.readinessConfirmedAt ?? null,
      },
      {
        id: "teammate_invitation",
        completed: Boolean(invitedAt),
        completedAt: invitedAt,
      },
      ...(entitlements.extensionEnabled
        ? ([
            {
              id: "extension_installation" as const,
              completed: extensionDeviceRows.length > 0,
              completedAt: extensionDeviceRows[0]?.$createdAt ?? null,
            },
            {
              id: "extension_pin" as const,
              completed: Boolean(pinnedAt),
              completedAt: pinnedAt,
            },
            {
              id: "first_capture" as const,
              completed: Boolean(firstUsageAt("capture.completed")),
              completedAt: firstUsageAt("capture.completed"),
            },
          ] as const)
        : ([
            {
              id: "first_guide" as const,
              completed: Boolean(firstGuideAt),
              completedAt: firstGuideAt,
            },
          ] as const)),
      {
        id: "first_publication",
        completed: Boolean(firstPublishedAt),
        completedAt: firstPublishedAt,
      },
    ];
    const onboardingCompletedAt = onboardingSteps.every(
      (step) => step.completed,
    )
      ? (onboardingSteps
          .map((step) => step.completedAt!)
          .sort()
          .at(-1) ?? null)
      : null;

    const invitations: Invitation[] = isAdmin
      ? invitationRows.map((row) => {
          const details = decodePayload<Partial<Invitation>>(row, {});
          return {
            id: row.$id,
            label: details.label ?? "Invitation",
            role: details.role ?? "viewer",
            expiresAt: stringValue(row.expires_at),
            maxUses: numberValue(details.maxUses, 1),
            useCount: numberValue(details.useCount),
            revokedAt: row.status === "revoked" ? row.$updatedAt : null,
            createdAt: row.$createdAt,
          };
        })
      : [];
    const supportRequests: SupportAccessRequest[] = isAdmin
      ? supportCases.map((row) => {
          const details = decodePayload<Partial<SupportAccessRequest>>(row, {});
          return {
            id: row.$id,
            workspaceId,
            requesterUserId: stringValue(row.user_id),
            requesterEmail: details.requesterEmail ?? stringValue(row.email),
            requesterName: details.requesterName ?? "Support operator",
            requestedRole: details.requestedRole ?? "viewer",
            reason: details.reason ?? "",
            requestedDurationHours: numberValue(
              details.requestedDurationHours,
              1,
            ),
            status: stringValue(
              row.status,
              "pending",
            ) as SupportAccessRequest["status"],
            grantedRole: details.grantedRole ?? null,
            createdAt: row.$createdAt,
          };
        })
      : [];
    const supportGrants: SupportAccessGrant[] = isAdmin
      ? supportGrantRows.map((row) => {
          const details = decodePayload<SupportGrantRecord>(row, null as never);
          return {
            id: row.$id,
            requestId: details.requestId,
            workspaceId,
            userId: stringValue(row.user_id),
            email: details.email,
            displayName: details.displayName,
            role: details.role,
            status: stringValue(
              row.status,
              "expired",
            ) as SupportAccessGrant["status"],
            approvedBy: details.approvedBy,
            grantedAt: details.grantedAt,
            expiresAt: details.expiresAt,
            endedAt: details.endedAt,
            revokedBy: details.revokedBy,
          };
        })
      : [];
    const supportTickets: SupportTicket[] = supportTicketRows
      .filter(
        (row) =>
          isAdmin ||
          row.user_id === identity.userId ||
          Boolean(access.supportGrant),
      )
      .map((row) => {
        const details = decodePayload<Partial<SupportTicket>>(row, {});
        return {
          id: row.$id,
          subject: details.subject ?? "Support request",
          status: stringValue(row.status, "open") as SupportTicket["status"],
          requesterUserId: stringValue(row.user_id),
          requesterName: details.requesterName ?? "Workspace member",
          createdAt: details.createdAt ?? row.$createdAt,
          updatedAt: details.updatedAt ?? row.$updatedAt,
          responseTargetAt: details.responseTargetAt ?? row.$createdAt,
          messages: supportMessageRows
            .filter((message) => message.subject_id === row.$id)
            .map((message) => {
              const content = decodePayload<{
                authorName?: string;
                authorKind?: "customer" | "support";
                body?: string;
              }>(message, {});
              return {
                id: message.$id,
                sequence: numberValue(message.sequence),
                authorUserId: stringValue(message.user_id),
                authorName: content.authorName ?? "Support participant",
                authorKind: content.authorKind ?? "customer",
                body: content.body ?? "",
                createdAt: message.$createdAt,
              };
            }),
        };
      });
    const audits: AuditEvent[] = isAdmin
      ? auditRows.map((row) => {
          const event = decodePayload<Record<string, unknown>>(row, {});
          return {
            id: row.$id,
            sequence: numberValue(row.sequence),
            action: stringValue(event.action),
            actorName: stringValue(event.actorName),
            actorEmail: stringValue(event.actorEmail),
            targetType: stringValue(event.targetType),
            targetId: stringValue(event.targetId),
            targetLabel: stringValue(event.targetLabel),
            summary: stringValue(event.summary),
            occurredAt: stringValue(event.occurredAt, row.$createdAt),
            metadata:
              typeof event.metadata === "object" && event.metadata !== null
                ? (event.metadata as Record<string, unknown>)
                : undefined,
          };
        })
      : [];

    return {
      workspace: { ...workspace, settings },
      desktopCaptureDevices: desktopDeviceRows.flatMap((row) => {
        const details = decodePayload<DesktopDeviceDetails>(row, null as never);
        if (!details?.deviceId) return [];
        return [
          {
            id: row.$id,
            deviceId: details.deviceId,
            name: details.deviceName,
            architecture: details.architecture,
            version: details.desktopVersion,
            minimumVersion: details.minimumVersion,
            status: "active" as const,
            pairedAt: details.pairedAt ?? null,
            lastUsedAt: details.lastUsedAt ?? null,
            refreshExpiresAt: details.refreshExpiresAt ?? null,
          },
        ];
      }),
      entitlements: {
        maximumUsers: entitlements.maximumUsers,
        maximumCreators: entitlements.maximumCreators,
        storageBytes: entitlements.storageBytes,
        extensionEnabled: entitlements.extensionEnabled,
        desktopCaptureEnabled: entitlements.desktopCaptureEnabled,
        supportEnabled: entitlements.supportEnabled,
        removeBranding: entitlements.removeBranding,
        privacyToolsEnabled: entitlements.privacyToolsEnabled,
        customSubdomainEnabled: entitlements.customSubdomainEnabled,
        fileExportsEnabled: entitlements.fileExportsEnabled,
      },
      metrics,
      members,
      groups,
      guides,
      invitations,
      supportRequests,
      supportGrants,
      supportTickets,
      audits,
      vaultItems: [] as VaultItem[],
      onboarding: {
        startedAt:
          onboardingRecord.startedAt ??
          onboardingRows[0]?.$createdAt ??
          access.workspace.createdAt,
        completedAt: onboardingCompletedAt,
        dismissedAt:
          typeof onboardingRecord.dismissedAt === "string"
            ? onboardingRecord.dismissedAt
            : null,
        steps: onboardingSteps,
      },
    };
  }

  private async organizations(
    membershipRows: Array<StoredRecord<RecordData>>,
  ): Promise<OrganizationAdministration[]> {
    const result: OrganizationAdministration[] = [];
    for (const membershipRow of membershipRows) {
      if (membershipRow.status !== "active") continue;
      const organizationId = stringValue(membershipRow.organization_id);
      if (!organizationId) continue;
      const membership = decodePayload<{ roles?: string[] }>(membershipRow, {});
      const roles = (membership.roles ?? []).filter(
        (role): role is OrganizationRole =>
          ["owner", "administrator", "billing", "security_auditor"].includes(
            role,
          ),
      );
      if (!roles.length) continue;
      const [
        organizationRow,
        memberRows,
        workspaceRows,
        brandingRows,
        appointmentRows,
      ] = await Promise.all([
        this.store.get(TABLES.organizations, organizationId),
        this.store.list(TABLES.organizationMemberships, {
          filters: [{ field: "organization_id", value: organizationId }],
        }),
        this.store.list(TABLES.workspaces, {
          filters: [{ field: "organization_id", value: organizationId }],
        }),
        this.store.list(TABLES.organizationBranding, {
          filters: [{ field: "organization_id", value: organizationId }],
          order: "desc",
          limit: 1,
        }),
        this.store.list(TABLES.initialAdminAppointments, {
          filters: [
            { field: "organization_id", value: organizationId },
            { field: "status", value: "active" },
          ],
        }),
      ]);
      if (!organizationRow) continue;
      const organization = decodePayload<OrganizationRecord>(
        organizationRow,
        null as never,
      );
      const canInspectMemberships = roles.some((role) =>
        ["owner", "administrator", "security_auditor"].includes(role),
      );
      const branding = brandingRows[0]
        ? decodePayload<{ logoMediaId?: string; accentColor?: string }>(
            brandingRows[0],
            {},
          )
        : {};
      result.push({
        id: organizationId,
        legalName: organization.legalName,
        displayName: organization.displayName,
        country: organization.country,
        status: stringValue(organizationRow.status, organization.status),
        roles,
        branding: {
          logoMediaId: branding.logoMediaId ?? null,
          accentColor: branding.accentColor ?? "#2f6fed",
        },
        members: canInspectMemberships
          ? memberRows.map((row) => {
              const details = decodePayload<{
                name?: string;
                roles?: string[];
              }>(row, {});
              return {
                id: row.$id,
                userId: stringValue(row.user_id),
                email: stringValue(row.email),
                name: details.name ?? stringValue(row.email),
                roles: (details.roles ?? []).filter(
                  (role): role is OrganizationRole =>
                    [
                      "owner",
                      "administrator",
                      "billing",
                      "security_auditor",
                    ].includes(role),
                ),
                status: stringValue(row.status, "active"),
              };
            })
          : [],
        workspaces: workspaceRows.map((row) => {
          const workspace = decodePayload<WorkspaceRecord>(row, null as never);
          return {
            id: row.$id,
            name: workspace.name,
            slug: workspace.slug,
            status: stringValue(row.status, workspace.status),
          };
        }),
        appointments: canInspectMemberships
          ? appointmentRows.flatMap((row) => {
              const details = decodePayload<{
                organizationOwner?: boolean;
                organizationRoles?: OrganizationRole[];
              }>(row, {});
              if (
                !details.organizationOwner &&
                !details.organizationRoles?.length
              ) {
                return [];
              }
              return [
                {
                  id: row.$id,
                  workspaceId: stringValue(row.workspace_id),
                  email: stringValue(row.email),
                  status: "active" as const,
                  expiresAt: stringValue(row.expires_at),
                  createdAt: row.$createdAt,
                },
              ];
            })
          : [],
      });
    }
    return result;
  }

  private async platform(
    identity: AuthenticatedIdentity,
    roles: PlatformRole[],
  ) {
    if (!roles.length) return undefined;
    const queues = await new PlatformQueryService(this.store).queues(identity);
    const [appointmentRows, provisioningRows, pricingCatalogs] = await Promise.all([
      this.store.list(TABLES.initialAdminAppointments, {
        filters: [{ field: "status", value: "active" }],
      }),
      this.store.list(TABLES.provisioningRuns, {
        filters: [
          { field: "user_id", value: identity.userId },
          { field: "status", value: "draft" },
        ],
        order: "desc",
        limit: 25,
      }),
      new PricingCatalogService(this.store).list(),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      settings: queues.settings,
      queueCounts: queues.counts,
      appointments: appointmentRows.map((row) => ({
        id: row.$id,
        workspaceId: stringValue(row.workspace_id),
        email: stringValue(row.email),
        status: "active" as const,
        expiresAt: stringValue(row.expires_at),
        createdAt: row.$createdAt,
      })),
      provisioningRuns: provisioningRows.map((row) => {
        const run = decodePayload<{
          currentStep?: number;
          completedSteps?: number[];
          updatedAt?: string;
          steps?: Record<string, Record<string, unknown>>;
        }>(row, {});
        return {
          id: row.$id,
          currentStep: numberValue(run.currentStep, 1),
          completedSteps: run.completedSteps ?? [],
          updatedAt: run.updatedAt ?? row.$updatedAt,
          steps: run.steps,
        };
      }),
      pricingCatalogs,
    };
  }

  async workspaceGuides(
    identity: AuthenticatedIdentity,
    workspaceId: string,
  ): Promise<Guide[]> {
    const access = await this.access.requireWorkspace(workspaceId, identity);
    const filters = [{ field: "workspace_id", value: workspaceId }] as const;
    const [memberRows, groupMembershipRows, guideRows, settingRows] = await Promise.all([
      this.store.list(TABLES.workspaceMembers, { filters }),
      this.store.list(TABLES.groupMemberships, { filters }),
      loadGuideRows(this.store, workspaceId),
      this.store.list(TABLES.workspaceSettings, { filters, limit: 1 }),
    ]);
    const members = memberRows.map(memberView);
    for (const member of members) {
      member.groupIds = groupMembershipRows
        .filter((row) => row.user_id === member.userId)
        .map((row) => stringValue(row.subject_id));
    }
    const settings = settingRows[0]
      ? {
          ...DEFAULT_WORKSPACE_SETTINGS,
          ...decodePayload<Partial<WorkspaceSettings>>(settingRows[0], {}),
        }
      : DEFAULT_WORKSPACE_SETTINGS;
    return hydrateGuides(
      identity,
      access,
      guideRows,
      members,
      settings.requireReviewBeforePublish,
    );
  }

  async bootstrap(
    identity: AuthenticatedIdentity,
    requestedWorkspaceId?: string,
  ): Promise<BootstrapResponse> {
    const [
      membershipRows,
      grantRows,
      platformRoles,
      preferenceRows,
      organizationMembershipRows,
      betaAdmission,
      setupRows,
    ] = await Promise.all([
      this.store.list(TABLES.workspaceMembers, {
        filters: [{ field: "user_id", value: identity.userId }],
      }),
      this.store.list(TABLES.supportGrants, {
        filters: [
          { field: "user_id", value: identity.userId },
          { field: "status", value: "active" },
        ],
      }),
      this.access.platformRoles(identity.userId),
      this.store.list(TABLES.userPreferences, {
        filters: [{ field: "user_id", value: identity.userId }],
        limit: 1,
      }),
      this.store.list(TABLES.organizationMemberships, {
        filters: [
          { field: "user_id", value: identity.userId },
          { field: "status", value: "active" },
        ],
      }),
      new BetaAccessService(this.store).getConsumedGrantForUser(
        identity.userId,
        identity.email,
      ),
      this.store.list(TABLES.provisioningRuns, {
        filters: [{ field: "user_id", value: identity.userId }],
        order: "desc",
        limit: 25,
      }),
    ]);
    const selfServiceSetupRow = setupRows.find(
      (row) => row.kind === "self_service",
    );
    const selfServiceSetup = selfServiceSetupRow
      ? (() => {
          const setup = decodePayload<{
            draft?: SelfServiceSetup["draft"];
            result?: SelfServiceSetup["result"];
          }>(selfServiceSetupRow, {});
          return {
            runId: selfServiceSetupRow.$id,
            status:
              selfServiceSetupRow.status === "completed"
                ? "completed"
                : "draft",
            draft: setup.draft ?? {},
            ...(setup.result ? { result: setup.result } : {}),
          } satisfies SelfServiceSetup;
        })()
      : null;
    const workspaceIds = [
      ...new Set(
        [
          ...membershipRows.map((row) => stringValue(row.workspace_id)),
          ...grantRows
            .filter(
              (row) => Date.parse(stringValue(row.expires_at)) > Date.now(),
            )
            .map((row) => stringValue(row.workspace_id)),
        ].filter(Boolean),
      ),
    ];
    const accesses = (
      await Promise.all(
        workspaceIds.map((id) => this.access.workspaceAccess(id, identity)),
      )
    ).filter((access): access is WorkspaceAccess => Boolean(access));
    const summaries: WorkspaceSummary[] = [];
    for (const access of accesses) {
      const memberCount = (
        await this.store.list(TABLES.workspaceMembers, {
          filters: [{ field: "workspace_id", value: access.workspaceRow.$id }],
        })
      ).length;
      const guides = await loadGuideRows(this.store, access.workspaceRow.$id);
      summaries.push(
        summary(
          access.workspaceRow,
          access.workspace,
          access.roles,
          memberCount,
          guides.guides.map((row) => {
            const value = decodePayload<GuideRecord>(row, null as never);
            return {
              id: row.$id,
              workspaceId: access.workspaceRow.$id,
              title: value.title,
              status: stringValue(row.status, "draft") as Guide["status"],
              restricted: false,
              canEdit: false,
              canReview: false,
              canPublish: false,
              canShare: false,
              canArchive: false,
              canDelete: false,
              createdAt: value.createdAt,
              updatedAt: value.updatedAt,
              publishedRevision: null,
              workingRevision: null,
            };
          }),
          access.lifecycle,
          access.subscription,
        ),
      );
    }
    const selectedCandidate = requestedWorkspaceId
      ? accesses.find(
          (access) => access.workspaceRow.$id === requestedWorkspaceId,
        )
      : accesses.find(
          (access) =>
            access.workspace.status === "active" &&
            (access.lifecycleAccess === "active" ||
              access.lifecycleAccess === "read_only"),
        );
    const selected =
      selectedCandidate &&
      (selectedCandidate.lifecycleAccess === "active" ||
        selectedCandidate.lifecycleAccess === "read_only")
        ? selectedCandidate
        : undefined;
    const recoveryAccess = selected
      ? undefined
      : accesses.find((access) =>
          ["suspended", "deletion_pending", "deleting"].includes(
            access.lifecycleAccess,
          ),
        );
    const preference = preferenceRows[0]
      ? decodePayload<{ theme?: "light" | "dark" | "system" }>(
          preferenceRows[0],
          {},
        )
      : {};
    return {
      viewer: {
        id: identity.userId,
        email: identity.email,
        name: identity.name,
        emailVerified: identity.emailVerified,
        mfaEnabled: identity.mfaEnabled,
        platformAdministrator: platformRoles.length > 0,
        platformRoles,
        themePreference: preference.theme,
        ...(betaAdmission ? { betaAdmission } : {}),
        ...(selfServiceSetup ? { selfServiceSetup } : {}),
      },
      workspaces: summaries,
      activeWorkspace: selected
        ? await this.workspaceBundle(identity, selected)
        : null,
      organizations: await this.organizations(organizationMembershipRows),
      ...(recoveryAccess
        ? {
            recovery: {
              workspace: summaries.find(
                (item) => item.id === recoveryAccess.workspaceRow.$id,
              )!,
              message:
                recoveryAccess.lifecycleAccess === "deletion_pending"
                  ? "The retention period has ended and deletion awaits explicit platform-owner approval. Contact KnowHow to recover or convert this workspace."
                  : recoveryAccess.lifecycleAccess === "deleting"
                    ? "Approved deletion is in progress. This workspace can no longer be recovered from the application."
                    : "The subscription grace period has ended. Contact KnowHow to extend or convert this workspace before its deletion-eligibility date.",
              contactEnabled: recoveryAccess.lifecycleAccess !== "deleting",
              extensionActionsEnabled: true,
            },
          }
        : {}),
      platform: await this.platform(identity, platformRoles),
    };
  }
}
