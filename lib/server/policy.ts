import type { RevisionStatus, WorkspaceRole, WorkspaceStatus } from "../knowhow-types";
import type { LifecycleAccess } from "./domain-records";
import { HttpError } from "./http-security";

export type PolicyAction =
  | "platform.metrics.read"
  | "platform.workspaces.manage"
  | "platform.settings.read"
  | "platform.settings.manage"
  | "workspace.read"
  | "workspace.settings.manage"
  | "workspace.members.manage"
  | "workspace.groups.manage"
  | "workspace.invitations.manage"
  | "workspace.audit.read"
  | "workspace.support.decide"
  | "workspace.support.revoke"
  | "guide.list"
  | "guide.read"
  | "guide.create"
  | "guide.update"
  | "guide.submit"
  | "guide.review"
  | "guide.publish"
  | "guide.unpublish"
  | "guide.archive"
  | "guide.export"
  | "capture.create"
  | "capture.update";

export interface GuideAuthorizationFacts {
  revisionStatus?: RevisionStatus;
  sourceType?: "manual" | "capture" | "import";
  isAuthor?: boolean;
  isAssignedReviewer?: boolean;
  isAudienceMember?: boolean;
  exportAllowed?: boolean;
  privacyReviewed?: boolean;
  reviewApproved?: boolean;
  requireReviewBeforePublish?: boolean;
}

export interface SupportGrantFacts {
  role: WorkspaceRole;
  expiresAt: string;
}

export interface AuthorizationContext {
  isPlatformAdministrator?: boolean;
  isVerifiedIdentity: boolean;
  membershipStatus?: "active" | "suspended";
  workspaceStatus?: WorkspaceStatus;
  lifecycleAccess?: LifecycleAccess;
  roles: readonly WorkspaceRole[];
  guide?: GuideAuthorizationFacts;
  /**
   * Present when the actor is inside the workspace through a temporary,
   * customer-approved support grant instead of permanent membership. Support
   * actors remain transient identities even when the granted role is
   * administrator: they may operate the workspace but never change its
   * membership or governance.
   */
  supportGrant?: SupportGrantFacts;
}

export interface PolicyDecision {
  allowed: boolean;
  code: string;
  reason: string;
}

const allow = (reason: string): PolicyDecision => ({
  allowed: true,
  code: "ALLOWED",
  reason,
});

const deny = (code: string, reason: string): PolicyDecision => ({
  allowed: false,
  code,
  reason,
});

function hasAnyRole(
  roles: ReadonlySet<WorkspaceRole>,
  ...required: WorkspaceRole[]
): boolean {
  return required.some((role) => roles.has(role));
}

function checkPlatformAccess(
  action: PolicyAction,
  context: AuthorizationContext,
): PolicyDecision | null {
  if (!action.startsWith("platform.")) {
    return null;
  }
  if (context.supportGrant) {
    return deny(
      "SUPPORT_GRANT_NOT_PLATFORM",
      "Temporary support access cannot exercise platform administration.",
    );
  }
  return context.isPlatformAdministrator
    ? allow("The actor is a platform administrator.")
    : deny("PLATFORM_ADMIN_REQUIRED", "Platform administration is required.");
}

function checkLifecycleAndStatus(
  action: PolicyAction,
  context: AuthorizationContext,
  roles: ReadonlySet<WorkspaceRole>,
): PolicyDecision | null {
  if (context.membershipStatus !== "active") {
    return deny("MEMBERSHIP_REQUIRED", "An active workspace membership is required.");
  }

  if (context.lifecycleAccess === "deleted" || context.lifecycleAccess === "deleting") {
    return deny("WORKSPACE_DELETED", "The workspace is no longer available.");
  }
  if (context.lifecycleAccess === "deletion_pending" || context.lifecycleAccess === "suspended") {
    return deny("SUBSCRIPTION_SUSPENDED", "The subscription is suspended.");
  }
  if (
    context.lifecycleAccess === "read_only" &&
    !["workspace.read", "guide.list", "guide.read", "guide.export", "workspace.audit.read"].includes(action)
  ) {
    return deny("SUBSCRIPTION_READ_ONLY", "The subscription is in read-only grace.");
  }

  if (roles.size === 0) {
    return deny("ROLE_REQUIRED", "No active workspace role grants this action.");
  }

  if (context.workspaceStatus !== "active") {
    if (
      context.workspaceStatus === "suspended" &&
      roles.has("administrator") &&
      action === "workspace.read"
    ) {
      return allow("Workspace administrators may inspect a suspended workspace.");
    }
    return deny("WORKSPACE_UNAVAILABLE", "The workspace is not active.");
  }

  return null;
}

function checkSupportGrantRestrictions(
  action: PolicyAction,
  context: AuthorizationContext,
): PolicyDecision | null {
  if (!context.supportGrant) {
    return null;
  }
  if (
    action === "workspace.members.manage" ||
    action === "workspace.groups.manage" ||
    action === "workspace.invitations.manage" ||
    action === "workspace.support.decide"
  ) {
    return deny(
      "SUPPORT_GRANT_RESTRICTED",
      "Temporary support access cannot change membership, invitations, groups, or support governance.",
    );
  }
  return null;
}

function checkWorkspaceManagementActions(
  action: PolicyAction,
  context: AuthorizationContext,
  roles: ReadonlySet<WorkspaceRole>,
): PolicyDecision | null {
  if (action === "workspace.read" || action === "guide.list") {
    return allow("Active workspace members may access the workspace shell.");
  }

  if (
    action === "workspace.settings.manage" ||
    action === "workspace.invitations.manage" ||
    action === "workspace.audit.read"
  ) {
    return roles.has("administrator")
      ? allow("Workspace administrators may manage workspace administration.")
      : deny("WORKSPACE_ADMIN_REQUIRED", "Workspace administration is required.");
  }

  if (
    action === "workspace.members.manage" ||
    action === "workspace.groups.manage" ||
    action === "workspace.support.decide"
  ) {
    return roles.has("administrator") && !context.supportGrant
      ? allow("Workspace administrators may manage workspace identity and governance.")
      : deny("WORKSPACE_ADMIN_REQUIRED", "Workspace administration is required.");
  }

  if (action === "workspace.support.revoke") {
    // The command layer additionally allows grant holders to revoke their own
    // grant; policy only authorizes administrator-driven revocation here.
    return roles.has("administrator") && !context.supportGrant
      ? allow("Workspace administrators may revoke temporary support access.")
      : deny("WORKSPACE_ADMIN_REQUIRED", "Workspace administration is required.");
  }

  return null;
}

function checkGuideRead(
  context: AuthorizationContext,
  roles: ReadonlySet<WorkspaceRole>,
): PolicyDecision {
  const guide = context.guide;
  if (!guide?.revisionStatus) {
    return deny("GUIDE_CONTEXT_REQUIRED", "Guide authorization context is required.");
  }
  if (
    (guide.revisionStatus === "published" || guide.revisionStatus === "archived") &&
    guide.isAudienceMember
  ) {
    return allow("This published revision is shared with the actor.");
  }
  if (guide.isAuthor && hasAnyRole(roles, "creator", "administrator")) {
    return allow("Guide authors may read their own working revisions.");
  }
  if (guide.isAssignedReviewer && roles.has("reviewer")) {
    return allow("Assigned reviewers may read the review revision.");
  }
  if (guide.revisionStatus === "review" && roles.has("publisher")) {
    return allow("Publishers may inspect a revision that is ready to publish.");
  }
  return deny("GUIDE_NOT_SHARED", "The guide is not available to this actor.");
}

function checkGuidePublish(
  context: AuthorizationContext,
  roles: ReadonlySet<WorkspaceRole>,
): PolicyDecision {
  const guide = context.guide;
  if (guide?.sourceType === "capture" && guide.privacyReviewed !== true) {
    return deny(
      "PRIVACY_REVIEW_REQUIRED",
      "Captured guides require a privacy review before publishing.",
    );
  }
  const requireReview = guide?.requireReviewBeforePublish === true;
  const isPublisher = roles.has("publisher");
  const isAuthorCreator =
    guide?.isAuthor === true && hasAnyRole(roles, "creator", "administrator");
  const mayShareDirect = isPublisher || isAuthorCreator;

  if (guide?.revisionStatus === "draft") {
    if (!requireReview && mayShareDirect) {
      return allow("The actor may share this draft with the selected audience.");
    }
    return deny(
      requireReview ? "GUIDE_REVIEW_STATE_REQUIRED" : "PUBLISHER_REQUIRED",
      requireReview
        ? "Only a review revision may be published."
        : "Publisher access is required.",
    );
  }

  if (guide?.revisionStatus !== "review") {
    return deny("GUIDE_REVIEW_STATE_REQUIRED", "Only a review revision may be published.");
  }
  if (guide.reviewApproved !== true) {
    return deny("REVIEW_APPROVAL_REQUIRED", "An approved review is required before publishing.");
  }
  return isPublisher
    ? allow("Publishers may publish an approved, privacy-safe review revision.")
    : deny("PUBLISHER_REQUIRED", "Publisher access is required.");
}

function checkGuideActions(
  action: PolicyAction,
  context: AuthorizationContext,
  roles: ReadonlySet<WorkspaceRole>,
): PolicyDecision | null {
  if (action === "guide.create" || action === "capture.create") {
    return hasAnyRole(roles, "administrator", "creator")
      ? allow("Creators may create drafts and captures.")
      : deny("CREATOR_REQUIRED", "Creator access is required.");
  }

  if (action === "capture.update") {
    return hasAnyRole(roles, "administrator", "creator") && context.guide?.isAuthor
      ? allow("The capture owner may update the capture.")
      : deny("CAPTURE_OWNER_REQUIRED", "Only the capture owner may update it.");
  }

  if (action === "guide.read") {
    return checkGuideRead(context, roles);
  }

  if (action === "guide.update" || action === "guide.submit") {
    const isDraft = context.guide?.revisionStatus === "draft";
    const mayEdit =
      context.guide?.isAuthor === true &&
      hasAnyRole(roles, "creator", "administrator");
    return isDraft && mayEdit
      ? allow("The actor may change this draft.")
      : deny("DRAFT_EDITOR_REQUIRED", "Only an authorized draft editor may do this.");
  }

  if (action === "guide.review") {
    const mayReview =
      roles.has("reviewer") && context.guide?.isAssignedReviewer === true;
    return context.guide?.revisionStatus === "review" && mayReview
      ? allow("The actor may review this submitted revision.")
      : deny("REVIEWER_REQUIRED", "An assigned reviewer is required.");
  }

  if (action === "guide.publish") {
    return checkGuidePublish(context, roles);
  }

  // Taking a guide down for editing is the mirror of putting it up, so it is
  // granted to exactly whoever could have published it in the first place:
  // publishers always, and an author who is allowed to share their own work
  // directly when the workspace does not require review.
  if (action === "guide.unpublish") {
    const guide = context.guide;
    if (roles.has("publisher")) {
      return allow("Publishers may return a guide to draft.");
    }
    const isAuthorCreator =
      guide?.isAuthor === true && hasAnyRole(roles, "creator", "administrator");
    if (isAuthorCreator && guide?.requireReviewBeforePublish !== true) {
      return allow("The author may return their own directly-shared guide to draft.");
    }
    return deny("PUBLISHER_REQUIRED", "Publisher access is required.");
  }

  if (action === "guide.archive") {
    return roles.has("publisher")
      ? allow("Publishers may archive guide revisions.")
      : deny("PUBLISHER_REQUIRED", "Publisher access is required.");
  }

  if (action === "guide.export") {
    const guide = context.guide;
    const canRead = authorize("guide.read", context).allowed;
    const isWorkingRevision =
      guide?.revisionStatus === "draft" || guide?.revisionStatus === "review";
    return canRead && (isWorkingRevision || guide?.exportAllowed === true)
      ? allow("The actor may read the guide and its export policy permits export.")
      : deny("EXPORT_NOT_ALLOWED", "This guide cannot be exported by the actor.");
  }

  return null;
}

export function authorize(
  action: PolicyAction,
  context: AuthorizationContext,
): PolicyDecision {
  if (!context.isVerifiedIdentity) {
    return deny("EMAIL_NOT_VERIFIED", "A verified identity is required.");
  }

  const platformDecision = checkPlatformAccess(action, context);
  if (platformDecision) {
    return platformDecision;
  }

  const roles = new Set(context.roles);
  const lifecycleDecision = checkLifecycleAndStatus(action, context, roles);
  if (lifecycleDecision) {
    return lifecycleDecision;
  }

  const supportGrantDecision = checkSupportGrantRestrictions(action, context);
  if (supportGrantDecision) {
    return supportGrantDecision;
  }

  const workspaceDecision = checkWorkspaceManagementActions(action, context, roles);
  if (workspaceDecision) {
    return workspaceDecision;
  }

  const guideDecision = checkGuideActions(action, context, roles);
  if (guideDecision) {
    return guideDecision;
  }

  return deny("DEFAULT_DENY", "No policy grants this action.");
}

export function requireAuthorized(
  action: PolicyAction,
  context: AuthorizationContext,
): void {
  const decision = authorize(action, context);
  if (!decision.allowed) {
    throw new HttpError(403, decision.code, decision.reason);
  }
}
