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
  | "workspace.domains.manage"
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
  | "guide.archive"
  | "guide.export"
  | "capture.create"
  | "capture.update"
  | "vault.use";

export interface GuideAuthorizationFacts {
  revisionStatus?: RevisionStatus;
  sourceType?: "manual" | "capture" | "import";
  isAuthor?: boolean;
  isAssignedReviewer?: boolean;
  isAudienceMember?: boolean;
  exportAllowed?: boolean;
  privacyReviewed?: boolean;
  reviewApproved?: boolean;
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
  capabilities?: readonly ("vault")[];
  guide?: GuideAuthorizationFacts;
  /**
   * Present when the actor is inside the workspace through a temporary,
   * customer-approved support grant instead of permanent membership. Support
   * actors remain transient identities even when the granted role is
   * administrator: they may operate the workspace but never change its
   * membership, identity eligibility, or governance.
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

export function authorize(
  action: PolicyAction,
  context: AuthorizationContext,
): PolicyDecision {
  if (!context.isVerifiedIdentity) {
    return deny("EMAIL_NOT_VERIFIED", "A verified identity is required.");
  }

  if (action.startsWith("platform.")) {
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

  const roles = new Set(context.roles);
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

  if (context.supportGrant) {
    if (
      action === "workspace.members.manage" ||
      action === "workspace.groups.manage" ||
      action === "workspace.invitations.manage" ||
      action === "workspace.domains.manage" ||
      action === "workspace.support.decide"
    ) {
      return deny(
        "SUPPORT_GRANT_RESTRICTED",
        "Temporary support access cannot change membership, invitations, domains, groups, or support governance.",
      );
    }
  }

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
    action === "workspace.domains.manage" ||
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
    const guide = context.guide;
    if (!guide?.revisionStatus) {
      return deny("GUIDE_CONTEXT_REQUIRED", "Guide authorization context is required.");
    }
    if (roles.has("administrator")) {
      return allow("Workspace administrators may inspect all guide states.");
    }
    if (
      (guide.revisionStatus === "published" || guide.revisionStatus === "archived") &&
      guide.isAudienceMember
    ) {
      return allow("This published revision is shared with the actor.");
    }
    if (guide.isAuthor && roles.has("creator")) {
      return allow("Creators may read their own working revisions.");
    }
    if (guide.isAssignedReviewer && roles.has("reviewer")) {
      return allow("Assigned reviewers may read the review revision.");
    }
    if (guide.revisionStatus === "review" && roles.has("publisher")) {
      return allow("Publishers may inspect a revision that is ready to publish.");
    }
    return deny("GUIDE_NOT_SHARED", "The guide is not available to this actor.");
  }

  if (action === "guide.update" || action === "guide.submit") {
    const isDraft = context.guide?.revisionStatus === "draft";
    const mayEdit =
      roles.has("administrator") ||
      (roles.has("creator") && context.guide?.isAuthor === true);
    return isDraft && mayEdit
      ? allow("The actor may change this draft.")
      : deny("DRAFT_EDITOR_REQUIRED", "Only an authorized draft editor may do this.");
  }

  if (action === "guide.review") {
    const mayReview =
      roles.has("administrator") ||
      (roles.has("reviewer") && context.guide?.isAssignedReviewer === true);
    return context.guide?.revisionStatus === "review" && mayReview
      ? allow("The actor may review this submitted revision.")
      : deny("REVIEWER_REQUIRED", "An assigned reviewer is required.");
  }

  if (action === "guide.publish") {
    const guide = context.guide;
    if (guide?.revisionStatus !== "review") {
      return deny("GUIDE_REVIEW_STATE_REQUIRED", "Only a review revision may be published.");
    }
    if (guide.reviewApproved !== true) {
      return deny("REVIEW_APPROVAL_REQUIRED", "An approved review is required before publishing.");
    }
    if (guide.sourceType === "capture" && guide.privacyReviewed !== true) {
      return deny(
        "PRIVACY_REVIEW_REQUIRED",
        "Captured guides require a privacy review before publishing.",
      );
    }
    return hasAnyRole(roles, "administrator", "publisher")
      ? allow("Publishers may publish an approved, privacy-safe review revision.")
      : deny("PUBLISHER_REQUIRED", "Publisher access is required.");
  }

  if (action === "guide.archive") {
    return hasAnyRole(roles, "administrator", "publisher")
      ? allow("Publishers may archive guide revisions.")
      : deny("PUBLISHER_REQUIRED", "Publisher access is required.");
  }

  if (action === "guide.export") {
    const guide = context.guide;
    const canRead = authorize("guide.read", context).allowed;
    return canRead && guide?.exportAllowed === true
      ? allow("The actor may read the guide and its export policy permits export.")
      : deny("EXPORT_NOT_ALLOWED", "This guide cannot be exported by the actor.");
  }

  if (action === "vault.use") {
    return context.capabilities?.includes("vault") || roles.has("administrator")
      ? allow("The actor has the vault capability.")
      : deny("VAULT_CAPABILITY_REQUIRED", "Vault access is required.");
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
