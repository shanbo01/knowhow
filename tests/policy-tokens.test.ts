import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceRole } from "../lib/knowhow-types";
import {
  authorize,
  type AuthorizationContext,
  type GuideAuthorizationFacts,
} from "../lib/server/policy";
import {
  constantTimeEqual,
  signAppointmentToken,
  signDeviceToken,
  signInviteToken,
  verifyAppointmentToken,
  verifyDeviceToken,
  verifyInviteToken,
} from "../lib/server/tokens";
import { HttpError } from "../lib/server/http-security";

function context(
  roles: WorkspaceRole[],
  guide?: GuideAuthorizationFacts,
): AuthorizationContext {
  return {
    isVerifiedIdentity: true,
    membershipStatus: "active",
    workspaceStatus: "active",
    lifecycleAccess: "active",
    roles,
    capabilities: [],
    guide,
  };
}

test("default-deny policy separates roles, audiences, and working revisions", () => {
  const draft: GuideAuthorizationFacts = {
    revisionStatus: "draft",
    isAudienceMember: true,
    isAuthor: false,
    isAssignedReviewer: false,
  };
  assert.equal(authorize("guide.read", context(["viewer"], draft)).allowed, false);
  assert.equal(
    authorize(
      "guide.read",
      context(["reviewer"], {
        ...draft,
        revisionStatus: "review",
        isAssignedReviewer: true,
      }),
    ).allowed,
    true,
  );
  assert.equal(
    authorize(
      "guide.read",
      context(["reviewer"], { ...draft, revisionStatus: "review" }),
    ).allowed,
    false,
  );
  assert.equal(
    authorize(
      "guide.read",
      context(["viewer"], { ...draft, revisionStatus: "published" }),
    ).allowed,
    true,
  );
  assert.equal(
    authorize("workspace.groups.manage", context(["administrator"])).allowed,
    true,
  );
  assert.equal(
    authorize(
      "workspace.groups.manage",
      context(["viewer"], { isAudienceMember: true }),
    ).allowed,
    false,
  );
});

test("subscription state is enforced before role authorization", () => {
  const guide: GuideAuthorizationFacts = {
    revisionStatus: "published",
    isAudienceMember: true,
    exportAllowed: true,
  };
  const readOnly = {
    ...context(["administrator"], guide),
    lifecycleAccess: "read_only" as const,
  };
  assert.equal(authorize("guide.read", readOnly).allowed, true);
  assert.equal(authorize("guide.export", readOnly).allowed, true);
  assert.equal(authorize("guide.update", readOnly).code, "SUBSCRIPTION_READ_ONLY");
  assert.equal(
    authorize("workspace.settings.manage", readOnly).code,
    "SUBSCRIPTION_READ_ONLY",
  );
  for (const lifecycleAccess of ["suspended", "deletion_pending"] as const) {
    assert.equal(
      authorize("guide.read", { ...readOnly, lifecycleAccess }).code,
      "SUBSCRIPTION_SUSPENDED",
    );
  }
  for (const lifecycleAccess of ["deleting", "deleted"] as const) {
    assert.equal(
      authorize("guide.read", { ...readOnly, lifecycleAccess }).code,
      "WORKSPACE_DELETED",
    );
  }
  assert.equal(
    authorize("workspace.read", {
      ...context(["administrator"]),
      workspaceStatus: "suspended",
    }).allowed,
    true,
  );
});

test("captured publication requires approval, privacy review, and publisher role", () => {
  const base: GuideAuthorizationFacts = {
    revisionStatus: "review",
    sourceType: "capture",
    reviewApproved: true,
    privacyReviewed: false,
  };
  assert.equal(
    authorize("guide.publish", context(["publisher"], base)).code,
    "PRIVACY_REVIEW_REQUIRED",
  );
  assert.equal(
    authorize("guide.publish", context(["publisher"], {
      ...base,
      privacyReviewed: true,
    })).allowed,
    true,
  );
  assert.equal(
    authorize("guide.publish", context(["viewer"], {
      ...base,
      privacyReviewed: true,
    })).code,
    "PUBLISHER_REQUIRED",
  );
  assert.equal(
    authorize("guide.publish", context(["publisher"], {
      ...base,
      reviewApproved: false,
      privacyReviewed: true,
    })).code,
    "REVIEW_APPROVAL_REQUIRED",
  );
});

test("temporary support access cannot become governance or platform authority", () => {
  const support: AuthorizationContext = {
    ...context(["administrator"]),
    supportGrant: {
      role: "administrator",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
  assert.equal(authorize("workspace.read", support).allowed, true);
  for (const action of [
    "workspace.members.manage",
    "workspace.groups.manage",
    "workspace.invitations.manage",
    "workspace.support.decide",
  ] as const) {
    assert.equal(authorize(action, support).code, "SUPPORT_GRANT_RESTRICTED");
  }
  assert.equal(
    authorize("platform.workspaces.manage", {
      ...support,
      isPlatformAdministrator: true,
    }).code,
    "SUPPORT_GRANT_NOT_PLATFORM",
  );
  assert.equal(
    authorize("platform.workspaces.manage", {
      isVerifiedIdentity: true,
      isPlatformAdministrator: true,
      roles: [],
    }).allowed,
    true,
  );
});

test("vault capability stays separate and unverified identities always fail", () => {
  assert.equal(authorize("vault.use", context(["viewer"])).allowed, false);
  assert.equal(
    authorize("vault.use", {
      ...context(["viewer"]),
      capabilities: ["vault"],
    }).allowed,
    true,
  );
  assert.equal(authorize("vault.use", context(["administrator"])).allowed, true);
  assert.equal(
    authorize("workspace.read", {
      ...context(["administrator"]),
      isVerifiedIdentity: false,
    }).code,
    "EMAIL_NOT_VERIFIED",
  );
});

test("versioned signed credentials are scoped, typed, and tamper-evident", async () => {
  const oldSecret = "old-test-secret-with-at-least-thirty-two-random-bytes";
  const newSecret = "new-test-secret-with-at-least-thirty-two-random-bytes";
  const now = Math.floor(Date.now() / 1_000);
  const invite = await signInviteToken(
    {
      jti: "invitation-credential-0001",
      workspaceId: "workspace-a",
      expiresAt: now + 600,
      role: "viewer",
      email: "Person@Example.COM",
    },
    oldSecret,
  );
  const claims = await verifyInviteToken(invite, oldSecret);
  assert.equal(claims.workspaceId, "workspace-a");
  assert.equal(claims.email, "person@example.com");
  await assert.rejects(
    verifyDeviceToken(invite, oldSecret),
    (error: unknown) => error instanceof HttpError && error.code === "TOKEN_TYPE_INVALID",
  );
  const tampered = `${invite.slice(0, -1)}${invite.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(
    verifyInviteToken(tampered, oldSecret),
    (error: unknown) => error instanceof HttpError && error.code === "TOKEN_INVALID",
  );
  await assert.rejects(
    verifyInviteToken(invite, newSecret),
    (error: unknown) => error instanceof HttpError && error.code === "TOKEN_INVALID",
  );

  const device = await signDeviceToken(
    {
      jti: "device-credential-0000001",
      workspaceId: "workspace-a",
      userId: "user-a",
      deviceId: "browser-a",
      scopes: ["capture:write", "media:write"],
      expiresAt: now + 300,
    },
    newSecret,
  );
  assert.deepEqual((await verifyDeviceToken(device, newSecret)).scopes, [
    "capture:write",
    "media:write",
  ]);
  const appointment = await signAppointmentToken(
    {
      jti: "appointment-credential-001",
      workspaceId: "workspace-a",
      email: "ADMIN@EXAMPLE.COM",
      expiresAt: now + 300,
    },
    newSecret,
  );
  assert.equal(
    (await verifyAppointmentToken(appointment, newSecret)).email,
    "admin@example.com",
  );
  assert.equal(constantTimeEqual("same", "same"), true);
  assert.equal(constantTimeEqual("same", "different"), false);
});
