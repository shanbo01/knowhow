import assert from "node:assert/strict";
import test from "node:test";
import { authorize, requireAuthorized, type AuthorizationContext } from "./policy";
import { HttpError } from "./http-security";

const baseContext: AuthorizationContext = {
  isVerifiedIdentity: true,
  membershipStatus: "active",
  workspaceStatus: "active",
  roles: ["viewer"],
};

// Verification gates the actions that reach somebody else, not the product.
// An unverified person reads, captures and drafts; they cannot publish to an
// audience, export a copy out, or change who is in the workspace.
test("authorize - unverified identity gates only outbound actions", () => {
  const ctx: AuthorizationContext = {
    ...baseContext,
    isVerifiedIdentity: false,
    roles: ["administrator", "creator", "publisher"],
  };

  assert.equal(authorize("workspace.read", ctx).allowed, true);
  assert.equal(authorize("guide.list", ctx).allowed, true);
  assert.equal(authorize("guide.create", ctx).allowed, true);
  assert.equal(authorize("capture.create", ctx).allowed, true);
  assert.equal(
    authorize("guide.update", {
      ...ctx,
      guide: { revisionStatus: "draft", isAuthor: true },
    }).allowed,
    true,
  );

  for (const action of [
    "guide.publish",
    "guide.export",
    "workspace.invitations.manage",
    "workspace.members.manage",
    "workspace.groups.manage",
  ] as const) {
    assert.deepEqual(
      authorize(action, ctx),
      {
        allowed: false,
        code: "EMAIL_NOT_VERIFIED",
        reason: "Verify your email address to do this.",
      },
      `${action} must wait for a verified address`,
    );
  }
});

test("authorize - platform actions", () => {
  // Support grant cannot exercise platform administration
  const supportCtx: AuthorizationContext = {
    ...baseContext,
    isPlatformAdministrator: true,
    supportGrant: { role: "administrator", expiresAt: "2099-01-01T00:00:00Z" },
  };
  assert.deepEqual(authorize("platform.metrics.read", supportCtx), {
    allowed: false,
    code: "SUPPORT_GRANT_NOT_PLATFORM",
    reason: "Temporary support access cannot exercise platform administration.",
  });

  // Platform admin allowed
  const adminCtx: AuthorizationContext = {
    ...baseContext,
    isPlatformAdministrator: true,
  };
  assert.deepEqual(authorize("platform.metrics.read", adminCtx), {
    allowed: true,
    code: "ALLOWED",
    reason: "The actor is a platform administrator.",
  });

  // Non-platform admin denied
  const nonAdminCtx: AuthorizationContext = {
    ...baseContext,
    isPlatformAdministrator: false,
  };
  assert.deepEqual(authorize("platform.metrics.read", nonAdminCtx), {
    allowed: false,
    code: "PLATFORM_ADMIN_REQUIRED",
    reason: "Platform administration is required.",
  });
});

test("authorize - membership status check", () => {
  const ctx: AuthorizationContext = {
    ...baseContext,
    membershipStatus: "suspended",
  };
  assert.deepEqual(authorize("workspace.read", ctx), {
    allowed: false,
    code: "MEMBERSHIP_REQUIRED",
    reason: "An active workspace membership is required.",
  });
});

test("authorize - lifecycle access checks", () => {
  assert.deepEqual(
    authorize("workspace.read", { ...baseContext, lifecycleAccess: "deleted" }),
    {
      allowed: false,
      code: "WORKSPACE_DELETED",
      reason: "The workspace is no longer available.",
    },
  );
  assert.deepEqual(
    authorize("workspace.read", { ...baseContext, lifecycleAccess: "deleting" }),
    {
      allowed: false,
      code: "WORKSPACE_DELETED",
      reason: "The workspace is no longer available.",
    },
  );

  assert.deepEqual(
    authorize("workspace.read", { ...baseContext, lifecycleAccess: "deletion_pending" }),
    {
      allowed: false,
      code: "SUBSCRIPTION_SUSPENDED",
      reason: "The subscription is suspended.",
    },
  );
  assert.deepEqual(
    authorize("workspace.read", { ...baseContext, lifecycleAccess: "suspended" }),
    {
      allowed: false,
      code: "SUBSCRIPTION_SUSPENDED",
      reason: "The subscription is suspended.",
    },
  );

  // Read only allowed actions
  assert.equal(
    authorize("workspace.read", { ...baseContext, lifecycleAccess: "read_only" }).allowed,
    true,
  );
  assert.equal(
    authorize("guide.list", { ...baseContext, lifecycleAccess: "read_only" }).allowed,
    true,
  );

  // Read only disallowed action
  assert.deepEqual(
    authorize("workspace.settings.manage", {
      ...baseContext,
      roles: ["administrator"],
      lifecycleAccess: "read_only",
    }),
    {
      allowed: false,
      code: "SUBSCRIPTION_READ_ONLY",
      reason: "The subscription is in read-only grace.",
    },
  );
});

test("authorize - no active roles", () => {
  assert.deepEqual(authorize("workspace.read", { ...baseContext, roles: [] }), {
    allowed: false,
    code: "ROLE_REQUIRED",
    reason: "No active workspace role grants this action.",
  });
});

test("authorize - workspace status checks", () => {
  const suspendedAdmin: AuthorizationContext = {
    ...baseContext,
    roles: ["administrator"],
    workspaceStatus: "suspended",
  };
  assert.deepEqual(authorize("workspace.read", suspendedAdmin), {
    allowed: true,
    code: "ALLOWED",
    reason: "Workspace administrators may inspect a suspended workspace.",
  });

  const suspendedViewer: AuthorizationContext = {
    ...baseContext,
    roles: ["viewer"],
    workspaceStatus: "suspended",
  };
  assert.deepEqual(authorize("workspace.read", suspendedViewer), {
    allowed: false,
    code: "WORKSPACE_UNAVAILABLE",
    reason: "The workspace is not active.",
  });
});

test("authorize - support grant restrictions", () => {
  const supportCtx: AuthorizationContext = {
    ...baseContext,
    roles: ["administrator"],
    supportGrant: { role: "administrator", expiresAt: "2099-01-01T00:00:00Z" },
  };

  assert.deepEqual(authorize("workspace.members.manage", supportCtx), {
    allowed: false,
    code: "SUPPORT_GRANT_RESTRICTED",
    reason:
      "Temporary support access cannot change membership, invitations, groups, or support governance.",
  });

  assert.deepEqual(authorize("workspace.support.revoke", supportCtx), {
    allowed: false,
    code: "WORKSPACE_ADMIN_REQUIRED",
    reason: "Workspace administration is required.",
  });
});

test("authorize - workspace shell and administration actions", () => {
  // shell access
  assert.equal(authorize("workspace.read", baseContext).allowed, true);
  assert.equal(authorize("guide.list", baseContext).allowed, true);

  // settings manage
  assert.equal(
    authorize("workspace.settings.manage", { ...baseContext, roles: ["administrator"] }).allowed,
    true,
  );
  assert.equal(
    authorize("workspace.settings.manage", { ...baseContext, roles: ["viewer"] }).allowed,
    false,
  );

  // governance actions with admin vs non-admin
  assert.equal(
    authorize("workspace.members.manage", { ...baseContext, roles: ["administrator"] }).allowed,
    true,
  );
  assert.equal(
    authorize("workspace.members.manage", { ...baseContext, roles: ["viewer"] }).allowed,
    false,
  );

  // support revoke with admin vs non-admin
  assert.equal(
    authorize("workspace.support.revoke", { ...baseContext, roles: ["administrator"] }).allowed,
    true,
  );
  assert.equal(
    authorize("workspace.support.revoke", { ...baseContext, roles: ["viewer"] }).allowed,
    false,
  );
});

test("authorize - guide creation and capture updates", () => {
  const creatorCtx: AuthorizationContext = { ...baseContext, roles: ["creator"] };
  const viewerCtx: AuthorizationContext = { ...baseContext, roles: ["viewer"] };

  assert.equal(authorize("guide.create", creatorCtx).allowed, true);
  assert.equal(authorize("capture.create", creatorCtx).allowed, true);
  assert.equal(authorize("guide.create", viewerCtx).allowed, false);

  const captureOwnerCtx: AuthorizationContext = {
    ...creatorCtx,
    guide: { isAuthor: true },
  };
  const captureNotOwnerCtx: AuthorizationContext = {
    ...creatorCtx,
    guide: { isAuthor: false },
  };

  assert.equal(authorize("capture.update", captureOwnerCtx).allowed, true);
  assert.equal(authorize("capture.update", captureNotOwnerCtx).allowed, false);
});

test("authorize - guide.read", () => {
  const noGuideCtx = baseContext;
  assert.deepEqual(authorize("guide.read", noGuideCtx), {
    allowed: false,
    code: "GUIDE_CONTEXT_REQUIRED",
    reason: "Guide authorization context is required.",
  });

  const publishedAudience: AuthorizationContext = {
    ...baseContext,
    guide: { revisionStatus: "published", isAudienceMember: true },
  };
  assert.equal(authorize("guide.read", publishedAudience).allowed, true);

  const authorCreator: AuthorizationContext = {
    ...baseContext,
    roles: ["creator"],
    guide: { revisionStatus: "draft", isAuthor: true },
  };
  assert.equal(authorize("guide.read", authorCreator).allowed, true);

  const reviewerCtx: AuthorizationContext = {
    ...baseContext,
    roles: ["reviewer"],
    guide: { revisionStatus: "review", isAssignedReviewer: true },
  };
  assert.equal(authorize("guide.read", reviewerCtx).allowed, true);

  const publisherCtx: AuthorizationContext = {
    ...baseContext,
    roles: ["publisher"],
    guide: { revisionStatus: "review" },
  };
  assert.equal(authorize("guide.read", publisherCtx).allowed, true);

  const unshared: AuthorizationContext = {
    ...baseContext,
    roles: ["viewer"],
    guide: { revisionStatus: "draft", isAuthor: false },
  };
  assert.deepEqual(authorize("guide.read", unshared), {
    allowed: false,
    code: "GUIDE_NOT_SHARED",
    reason: "The guide is not available to this actor.",
  });
});

test("authorize - guide.update and guide.submit", () => {
  const authorCreatorDraft: AuthorizationContext = {
    ...baseContext,
    roles: ["creator"],
    guide: { revisionStatus: "draft", isAuthor: true },
  };
  assert.equal(authorize("guide.update", authorCreatorDraft).allowed, true);
  assert.equal(authorize("guide.submit", authorCreatorDraft).allowed, true);

  const authorCreatorReview: AuthorizationContext = {
    ...baseContext,
    roles: ["creator"],
    guide: { revisionStatus: "review", isAuthor: true },
  };
  assert.equal(authorize("guide.update", authorCreatorReview).allowed, false);
});

test("authorize - guide.review", () => {
  const reviewerCtx: AuthorizationContext = {
    ...baseContext,
    roles: ["reviewer"],
    guide: { revisionStatus: "review", isAssignedReviewer: true },
  };
  assert.equal(authorize("guide.review", reviewerCtx).allowed, true);

  const notReviewerCtx: AuthorizationContext = {
    ...baseContext,
    roles: ["viewer"],
    guide: { revisionStatus: "review", isAssignedReviewer: true },
  };
  assert.equal(authorize("guide.review", notReviewerCtx).allowed, false);
});

test("authorize - guide.publish", () => {
  // Capture source without privacy review
  const unreviewedCapture: AuthorizationContext = {
    ...baseContext,
    roles: ["publisher"],
    guide: { revisionStatus: "draft", sourceType: "capture", privacyReviewed: false },
  };
  assert.deepEqual(authorize("guide.publish", unreviewedCapture), {
    allowed: false,
    code: "PRIVACY_REVIEW_REQUIRED",
    reason: "Captured guides require a privacy review before publishing.",
  });

  // Draft publishing direct when review not required
  const directPublishDraft: AuthorizationContext = {
    ...baseContext,
    roles: ["publisher"],
    guide: { revisionStatus: "draft", requireReviewBeforePublish: false },
  };
  assert.equal(authorize("guide.publish", directPublishDraft).allowed, true);

  // Draft publishing when review required
  const reviewRequiredDraft: AuthorizationContext = {
    ...baseContext,
    roles: ["publisher"],
    guide: { revisionStatus: "draft", requireReviewBeforePublish: true },
  };
  assert.deepEqual(authorize("guide.publish", reviewRequiredDraft), {
    allowed: false,
    code: "GUIDE_REVIEW_STATE_REQUIRED",
    reason: "Only a review revision may be published.",
  });

  // Review status but unapproved
  const unapprovedReview: AuthorizationContext = {
    ...baseContext,
    roles: ["publisher"],
    guide: { revisionStatus: "review", reviewApproved: false },
  };
  assert.deepEqual(authorize("guide.publish", unapprovedReview), {
    allowed: false,
    code: "REVIEW_APPROVAL_REQUIRED",
    reason: "An approved review is required before publishing.",
  });

  // Approved review with publisher role
  const approvedReview: AuthorizationContext = {
    ...baseContext,
    roles: ["publisher"],
    guide: { revisionStatus: "review", reviewApproved: true },
  };
  assert.equal(authorize("guide.publish", approvedReview).allowed, true);
});

test("authorize - guide.unpublish", () => {
  const publisherCtx: AuthorizationContext = {
    ...baseContext,
    roles: ["publisher"],
  };
  assert.equal(authorize("guide.unpublish", publisherCtx).allowed, true);

  const authorDirectUnpublish: AuthorizationContext = {
    ...baseContext,
    roles: ["creator"],
    guide: { isAuthor: true, requireReviewBeforePublish: false },
  };
  assert.equal(authorize("guide.unpublish", authorDirectUnpublish).allowed, true);

  const authorRequireReviewUnpublish: AuthorizationContext = {
    ...baseContext,
    roles: ["creator"],
    guide: { isAuthor: true, requireReviewBeforePublish: true },
  };
  assert.equal(authorize("guide.unpublish", authorRequireReviewUnpublish).allowed, false);
});

test("authorize - guide.archive", () => {
  assert.equal(
    authorize("guide.archive", { ...baseContext, roles: ["publisher"] }).allowed,
    true,
  );
  assert.equal(
    authorize("guide.archive", { ...baseContext, roles: ["creator"] }).allowed,
    false,
  );
});

test("authorize - guide.export", () => {
  const readableWorkingGuide: AuthorizationContext = {
    ...baseContext,
    roles: ["creator"],
    guide: { revisionStatus: "draft", isAuthor: true },
  };
  assert.equal(authorize("guide.export", readableWorkingGuide).allowed, true);

  const readablePublishedAllowed: AuthorizationContext = {
    ...baseContext,
    guide: { revisionStatus: "published", isAudienceMember: true, exportAllowed: true },
  };
  assert.equal(authorize("guide.export", readablePublishedAllowed).allowed, true);

  const readablePublishedDisallowed: AuthorizationContext = {
    ...baseContext,
    guide: { revisionStatus: "published", isAudienceMember: true, exportAllowed: false },
  };
  assert.equal(authorize("guide.export", readablePublishedDisallowed).allowed, false);
});

test("requireAuthorized - throws HttpError on deny", () => {
  assert.throws(
    () =>
      requireAuthorized("workspace.invitations.manage", {
        ...baseContext,
        roles: ["administrator"],
        isVerifiedIdentity: false,
      }),
    (err) => err instanceof HttpError && err.status === 403 && err.code === "EMAIL_NOT_VERIFIED",
  );
});

test("authorize - guide.unsubmit rescues a stranded review", () => {
  const review = { revisionStatus: "review" as const };

  // The author changing their mind is the ordinary case.
  assert.equal(
    authorize("guide.unsubmit", {
      ...baseContext,
      roles: ["creator"],
      guide: { ...review, isAuthor: true },
    }).allowed,
    true,
  );

  // An administrator can recover a revision whose reviewers have all been
  // suspended, which is the deadlock this action exists for.
  assert.equal(
    authorize("guide.unsubmit", {
      ...baseContext,
      roles: ["administrator"],
      guide: { ...review, isAuthor: false },
    }).allowed,
    true,
  );

  // Nobody else, including the publisher who would eventually release it.
  for (const roles of [["publisher"], ["reviewer"], ["viewer"]] as const) {
    assert.equal(
      authorize("guide.unsubmit", {
        ...baseContext,
        roles: [...roles],
        guide: { ...review, isAuthor: false },
      }).allowed,
      false,
    );
  }

  // A draft was never submitted, so there is nothing to withdraw.
  assert.deepEqual(
    authorize("guide.unsubmit", {
      ...baseContext,
      roles: ["administrator"],
      guide: { revisionStatus: "draft", isAuthor: true },
    }),
    {
      allowed: false,
      code: "GUIDE_REVIEW_STATE_REQUIRED",
      reason: "Only a revision in review may be withdrawn.",
    },
  );
});

test("authorize - guide.delete is a policy decision, not an inline rule", () => {
  const unpublished = { isAuthor: true, hasBeenPublished: false };

  // A publisher may delete anything in the library.
  assert.equal(
    authorize("guide.delete", {
      ...baseContext,
      roles: ["publisher"],
      guide: { isAuthor: false, hasBeenPublished: true },
    }).allowed,
    true,
  );

  // An author may delete their own work right up until it went live.
  assert.equal(
    authorize("guide.delete", { ...baseContext, roles: ["creator"], guide: unpublished }).allowed,
    true,
  );
  assert.equal(
    authorize("guide.delete", {
      ...baseContext,
      roles: ["creator"],
      guide: { isAuthor: true, hasBeenPublished: true },
    }).allowed,
    false,
  );

  // Somebody else's draft is not theirs to remove.
  assert.equal(
    authorize("guide.delete", {
      ...baseContext,
      roles: ["creator"],
      guide: { isAuthor: false, hasBeenPublished: false },
    }).allowed,
    false,
  );
  assert.equal(
    authorize("guide.delete", { ...baseContext, roles: ["viewer"], guide: unpublished }).allowed,
    false,
  );

  // Routing it through the engine is what gives deletion the lifecycle and
  // membership checks it never ran when the rule was written out by hand.
  assert.equal(
    authorize("guide.delete", {
      ...baseContext,
      roles: ["publisher"],
      membershipStatus: "suspended",
      guide: unpublished,
    }).code,
    "MEMBERSHIP_REQUIRED",
  );
  assert.equal(
    authorize("guide.delete", {
      ...baseContext,
      roles: ["publisher"],
      lifecycleAccess: "read_only",
      guide: unpublished,
    }).code,
    "SUBSCRIPTION_READ_ONLY",
  );
});

test("authorize - guide.archive follows the same line as delete", () => {
  assert.equal(
    authorize("guide.archive", {
      ...baseContext,
      roles: ["publisher"],
      guide: { isAuthor: false, hasBeenPublished: true },
    }).allowed,
    true,
  );
  // An author may retire their own guide until other people were told to
  // rely on it; after that it is a publisher's call.
  assert.equal(
    authorize("guide.archive", {
      ...baseContext,
      roles: ["creator"],
      guide: { isAuthor: true, hasBeenPublished: false },
    }).allowed,
    true,
  );
  assert.equal(
    authorize("guide.archive", {
      ...baseContext,
      roles: ["creator"],
      guide: { isAuthor: true, hasBeenPublished: true },
    }).allowed,
    false,
  );
});
