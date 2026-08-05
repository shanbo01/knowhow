import type {
  Audience,
  EditorBlock,
  Guide,
  GuideRevisionView,
  RevisionStatus,
  WorkspaceMember,
  WorkspaceSettings,
} from "../rivet-types";
import { authorize } from "./policy";
import type { GuideAccessFacts, WorkspaceAccess } from "./repository";
import type { AuthenticatedIdentity } from "./appwrite-identity";

/**
 * Shared guide-visibility evaluation. Both the workspace guide list and the
 * global search endpoint run candidate guides through this exact logic, so a
 * search result can never expose a guide the listing would hide: per-revision
 * `guide.read` authorization, active-capture suppression, and archived-guide
 * rules. The two surfaces cannot drift apart.
 */

export type RevisionRow = {
  id: string;
  guide_id: string;
  workspace_id: string;
  version: number;
  status: "draft" | "review" | "published" | "archived";
  source_type: "manual" | "capture" | "import";
  title: string;
  summary: string;
  category: string | null;
  tags_json: string;
  system_references_json: string;
  privacy_reviewed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_by: string | null;
  published_at: string | null;
  has_active_capture?: number;
};

export type RevisionStepRow = {
  revision_id: string;
  id: string;
  position: number;
  kind: EditorBlock["kind"];
  title: string;
  body: string;
  annotation_json: string;
};

export type RevisionAudienceRow = {
  revision_id: string;
  subject_type: Audience["kind"];
  subject_id: string;
};

export type RevisionReviewRow = {
  revision_id: string;
  reviewer_user_id: string;
  status: "pending" | "approved" | "changes_requested";
  decided_at: string | null;
};

export type RevisionMediaRow = {
  revision_id: string;
  id: string;
  step_id: string | null;
};

export type GuideRow = {
  id: string;
  workspace_id: string;
  title: string;
  author_user_id: string;
  current_published_revision_id: string | null;
  working_draft_revision_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export function latestApprovedReview(
  reviews: readonly RevisionReviewRow[],
): RevisionReviewRow | undefined {
  return reviews
    .filter(
      (item): item is RevisionReviewRow & { decided_at: string } =>
        item.status === "approved" && Boolean(item.decided_at),
    )
    .reduce<RevisionReviewRow | undefined>(
      (latest, item) =>
        !latest || !latest.decided_at || item.decided_at > latest.decided_at
          ? item
          : latest,
      undefined,
    );
}

export function loadRevisionFromRows(
  revision: RevisionRow | undefined,
  members: WorkspaceMember[],
  groupNames: ReadonlyMap<string, string>,
  stepRows: RevisionStepRow[],
  audienceRows: RevisionAudienceRow[],
  reviews: RevisionReviewRow[],
  mediaRows: RevisionMediaRow[],
): GuideRevisionView | null {
  if (!revision) return null;
  const approved = latestApprovedReview(reviews);
  const memberName = (userId: string | null) =>
    members.find((item) => item.userId === userId)?.name ?? userId ?? "Unknown";
  const audiences: Audience[] = audienceRows.map((item) => ({
    kind: item.subject_type,
    subjectId: item.subject_type === "workspace" ? undefined : item.subject_id,
    label:
      item.subject_type === "workspace"
        ? "Entire workspace"
        : item.subject_type === "group"
          ? groupNames.get(item.subject_id) ?? "Group"
          : memberName(item.subject_id),
  }));
  return {
    id: revision.id,
    number: revision.version,
    status: revision.status,
    title: revision.title,
    summary: revision.summary,
    category: revision.category ?? "",
    tags: safeJson<string[]>(revision.tags_json, []),
    systemReferences: safeJson<string[]>(revision.system_references_json, []),
    steps: stepRows.map((step) => {
      const annotations = safeJson<Record<string, unknown>>(step.annotation_json, {});
      const linkedMedia = mediaRows.find((item) => item.step_id === step.id)?.id;
      return {
        id: step.id,
        kind: step.kind,
        title: step.title,
        description: step.body,
        ...(typeof annotations.screenshotMediaId === "string" || linkedMedia
          ? { screenshotMediaId: (annotations.screenshotMediaId as string | undefined) ?? linkedMedia }
          : {}),
        ...(annotations.crop && typeof annotations.crop === "object"
          ? { crop: annotations.crop as EditorBlock["crop"] }
          : {}),
        ...(Array.isArray(annotations.annotations)
          ? { annotations: annotations.annotations as NonNullable<EditorBlock["annotations"]> }
          : {}),
      };
    }),
    audiences,
    authorId: revision.created_by,
    authorName: memberName(revision.created_by),
    createdAt: revision.created_at,
    updatedAt: revision.updated_at,
    reviewedBy: approved ? memberName(approved.reviewer_user_id) : undefined,
    reviewedAt: approved?.decided_at ?? undefined,
    publishedBy: revision.published_by ? memberName(revision.published_by) : undefined,
    publishedAt: revision.published_at ?? undefined,
    privacyReviewedAt: revision.privacy_reviewed_at ?? undefined,
    source: revision.source_type === "capture" ? "browser-capture" : "manual",
  };
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function policyContextFor(
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

export interface GuideVisibilityInput {
  guide: GuideRow;
  revisions: RevisionRow[];
  steps: RevisionStepRow[];
  audiences: RevisionAudienceRow[];
  reviews: RevisionReviewRow[];
  media: RevisionMediaRow[];
  activeCaptureRevisionIds: ReadonlySet<string>;
  access: WorkspaceAccess;
  identity: Pick<AuthenticatedIdentity, "userId">;
  isPlatformAdministrator: boolean;
  settings: WorkspaceSettings;
  members: WorkspaceMember[];
  groupNames: ReadonlyMap<string, string>;
}

export interface GuideVisibilityResult {
  working: GuideRevisionView | null;
  published: GuideRevisionView | null;
  canSeeWorking: boolean;
  canSeePublished: boolean;
  status: RevisionStatus;
  restricted: boolean;
  canEdit: boolean;
  canReview: boolean;
  canPublish: boolean;
  revisionHistory: Guide["revisionHistory"];
}

export function evaluateGuideVisibility(
  input: GuideVisibilityInput,
): GuideVisibilityResult | null {
  const {
    guide,
    revisions,
    steps,
    audiences,
    reviews,
    media,
    activeCaptureRevisionIds,
    access,
    identity,
    isPlatformAdministrator,
    settings,
    members,
    groupNames,
  } = input;
  const hasActiveCapture = Boolean(
    guide.working_draft_revision_id &&
      activeCaptureRevisionIds.has(guide.working_draft_revision_id),
  );
  const revisionView = (revisionId: string | null) =>
    revisionId
      ? loadRevisionFromRows(
          revisions.find((item) => item.id === revisionId),
          members,
          groupNames,
          steps.filter((item) => item.revision_id === revisionId),
          audiences.filter((item) => item.revision_id === revisionId),
          reviews.filter((item) => item.revision_id === revisionId),
          media.filter((item) => item.revision_id === revisionId),
        )
      : null;
  const working = hasActiveCapture ? null : revisionView(guide.working_draft_revision_id);
  const published = revisionView(guide.current_published_revision_id);
  const admin = access.roles.includes("administrator");
  const author = guide.author_user_id === identity.userId;
  const accessFacts = (revision: GuideRevisionView | null): GuideAccessFacts | null => {
    if (!revision) return null;
    const revisionAudiences = audiences.filter((item) => item.revision_id === revision.id);
    const revisionReviews = reviews.filter((item) => item.revision_id === revision.id);
    const workspaceAudience = revisionAudiences.some(
      (item) => item.subject_type === "workspace" && item.subject_id === access.workspaceId,
    );
    const isAudienceMember = revisionAudiences.some(
      (item) =>
        (item.subject_type === "workspace" && item.subject_id === access.workspaceId) ||
        (item.subject_type === "user" && item.subject_id === identity.userId) ||
        (item.subject_type === "group" && access.groupIds.includes(item.subject_id)),
    );
    return {
      guideId: guide.id,
      workspaceId: access.workspaceId,
      revisionId: revision.id,
      revisionStatus: revision.status,
      sourceType: revision.source === "browser-capture" ? "capture" : "manual",
      isAuthor: author,
      isAssignedReviewer: revisionReviews.some(
        (item) => item.reviewer_user_id === identity.userId,
      ),
      isAudienceMember,
      exportAllowed: workspaceAudience || settings.allowRestrictedExports,
      privacyReviewed: Boolean(revision.privacyReviewedAt),
      reviewApproved:
        revisionReviews.some((item) => item.status === "approved") &&
        revisionReviews.every((item) => item.status === "approved"),
    };
  };
  const workingFacts = accessFacts(working);
  const canSeeWorking = Boolean(
    working &&
      workingFacts &&
      authorize(
        "guide.read",
        policyContextFor(access, isPlatformAdministrator, workingFacts),
      ).allowed,
  );
  const publishedFacts = accessFacts(published);
  const canSeePublished = Boolean(
    publishedFacts &&
      authorize("guide.read", policyContextFor(access, isPlatformAdministrator, publishedFacts)).allowed,
  );
  if (guide.archived_at && !admin && !author) return null;
  if (!canSeeWorking && !canSeePublished) return null;
  const visibleWorking = canSeeWorking ? working : null;
  const visiblePublished = canSeePublished ? published : null;
  const display = visibleWorking ?? visiblePublished;
  if (!display) return null;
  const status = guide.archived_at ? "archived" : display.status;
  const canEdit =
    !guide.archived_at &&
    !hasActiveCapture &&
    access.workspaceStatus === "active" &&
    (admin || (author && access.roles.includes("creator"))) &&
    (!working || working.status === "draft");
  const canReview = Boolean(
    workingFacts &&
      authorize("guide.review", policyContextFor(access, isPlatformAdministrator, workingFacts)).allowed,
  );
  const canPublish = Boolean(
    workingFacts &&
      authorize("guide.publish", policyContextFor(access, isPlatformAdministrator, workingFacts)).allowed,
  );
  const historyRows = revisions.filter((item) => item.guide_id === guide.id);
  const restricted = !display.audiences.some((item) => item.kind === "workspace");
  return {
    working: visibleWorking,
    published: visiblePublished,
    canSeeWorking,
    canSeePublished,
    status,
    restricted,
    canEdit,
    canReview,
    canPublish,
    revisionHistory: historyRows
      .filter(
        (item) =>
          !activeCaptureRevisionIds.has(item.id) &&
          (canSeeWorking || Boolean(item.published_at)),
      )
      .map((item) => {
        const approved = latestApprovedReview(
          reviews.filter((review) => review.revision_id === item.id),
        );
        return {
          id: item.id,
          number: item.version,
          status: item.status,
          authorName:
            members.find((member) => member.userId === item.created_by)?.name ??
            item.created_by,
          createdAt: item.created_at,
          reviewedAt: approved?.decided_at ?? undefined,
          publishedAt: item.published_at ?? undefined,
          source: item.source_type === "capture" ? "browser-capture" : "manual",
        };
      }),
  };
}
