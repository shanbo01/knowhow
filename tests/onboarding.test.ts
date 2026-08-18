import assert from "node:assert/strict";
import test from "node:test";
import { TABLES } from "../lib/server/appwrite-resources";
import { BootstrapService } from "../lib/server/bootstrap-service";
import { CommandService } from "../lib/server/command-service";
import { decodePayload, rowData } from "../lib/server/domain-records";
import { HttpError } from "../lib/server/http-security";
import { InMemoryRecordStore } from "../lib/server/record-store";
import {
  identity,
  seedWorkspace,
  seedWorkspaceMember,
} from "./helpers/appwrite-fixtures";

const options = (suffix: string) => ({
  requestId: `request_${suffix}_0000000000000000`,
  idempotencyKey: `idempotency_${suffix}_0000000000000000`,
  reauthenticated: false,
});

test("pilot onboarding is resumable and requires both data-boundary confirmations", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const member = identity("member", "member@acme.example", "Member");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: member.userId,
    email: member.email,
    roles: ["creator"],
  });
  const service = new CommandService(store);

  await assert.rejects(
    service.execute(
      member,
      "confirmOnboardingReadiness",
      {
        workspaceId,
        ordinaryDataOnly: true,
        pilotPoliciesReviewed: false,
      },
      options("missing-policy"),
    ),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "ONBOARDING_CONFIRMATION_REQUIRED",
  );

  await service.execute(
    member,
    "confirmOnboardingReadiness",
    {
      workspaceId,
      ordinaryDataOnly: true,
      pilotPoliciesReviewed: true,
    },
    options("confirmed"),
  );
  const rows = await store.list(TABLES.onboardingProgress);
  assert.equal(rows.length, 1);
  const stored = decodePayload<Record<string, unknown>>(rows[0], {});
  assert.equal(stored.ordinaryDataOnly, true);
  assert.equal(stored.pilotPoliciesReviewed, true);
  assert.equal(typeof stored.readinessConfirmedAt, "string");

  const bootstrap = await new BootstrapService(store).bootstrap(
    member,
    workspaceId,
  );
  assert.equal(bootstrap.activeWorkspace?.onboarding.steps.length, 6);
  assert.deepEqual(
    bootstrap.activeWorkspace?.onboarding.steps.map((step) => step.id),
    [
      "workspace_readiness",
      "teammate_invitation",
      "extension_installation",
      "extension_pin",
      "first_capture",
      "first_publication",
    ],
  );
  assert.equal(
    bootstrap.activeWorkspace?.onboarding.steps[0].id,
    "workspace_readiness",
  );
  assert.equal(
    bootstrap.activeWorkspace?.onboarding.steps[0].completed,
    true,
  );
  assert.equal(bootstrap.activeWorkspace?.onboarding.completedAt, null);
  assert.equal(bootstrap.activeWorkspace?.onboarding.dismissedAt, null);
});

test("getting started can be dismissed without completing the remaining steps", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const member = identity("dismiss", "dismiss@acme.example", "Member");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: member.userId,
    email: member.email,
    roles: ["creator"],
  });
  const service = new CommandService(store);

  const result = await service.execute(
    member,
    "dismissOnboarding",
    { workspaceId },
    options("dismissed"),
  );
  assert.equal((result as { dismissed: boolean }).dismissed, true);

  const rows = await store.list(TABLES.onboardingProgress);
  assert.equal(rows.length, 1);
  const stored = decodePayload<Record<string, unknown>>(rows[0], {});
  assert.equal(typeof stored.dismissedAt, "string");

  const bootstrap = await new BootstrapService(store).bootstrap(
    member,
    workspaceId,
  );
  assert.equal(typeof bootstrap.activeWorkspace?.onboarding.dismissedAt, "string");
  assert.equal(bootstrap.activeWorkspace?.onboarding.completedAt, null);
});

test("readiness updates the onboarding row created by self-service setup", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const owner = identity("self-service-owner", "owner@acme.example", "Owner");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: owner.userId,
    email: owner.email,
    roles: ["administrator"],
  });
  const progressId = "self_service_seeded_progress";
  await store.create(
    TABLES.onboardingProgress,
    progressId,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        user_id: owner.userId,
        status: "active",
        occurred_at: "2026-08-13T08:00:00.000Z",
        created_by: owner.userId,
      },
      {
        startedAt: "2026-08-13T08:00:00.000Z",
        currentStep: "workspace_readiness",
      },
    ),
  );

  await new CommandService(store).execute(
    owner,
    "confirmOnboardingReadiness",
    {
      workspaceId,
      ordinaryDataOnly: true,
      pilotPoliciesReviewed: true,
    },
    options("self-service-row"),
  );

  const rows = await store.list(TABLES.onboardingProgress);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].$id, progressId);
  const stored = decodePayload<Record<string, unknown>>(rows[0], {});
  assert.equal(stored.startedAt, "2026-08-13T08:00:00.000Z");
  assert.equal(typeof stored.readinessConfirmedAt, "string");
});

test("activation derives publication and teammate completion from authoritative usage", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const owner = identity("activation-owner", "owner@activation.example", "Owner");
  const teammate = identity(
    "activation-teammate",
    "teammate@activation.example",
    "Teammate",
  );
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: owner.userId,
    email: owner.email,
    roles: ["administrator"],
  });
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: teammate.userId,
    email: teammate.email,
    roles: ["viewer"],
  });
  const guideId = "guide_activation_authoritative";
  const publishedAt = "2026-08-13T09:00:00.000Z";
  const completedAt = "2026-08-13T09:05:00.000Z";
  await store.create(
    TABLES.guides,
    guideId,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        subject_id: guideId,
        status: "published",
        created_by: owner.userId,
      },
      {
        title: "Activation guide",
        slug: "activation-guide",
        authorUserId: owner.userId,
        publishedRevisionId: "revision_activation",
        workingRevisionId: null,
        screenshotsLockedAt: null,
        archivedAt: null,
        createdAt: publishedAt,
        updatedAt: publishedAt,
      },
    ),
  );
  for (const [id, kind, userId, occurredAt] of [
    ["usage_publish", "guide.published", owner.userId, publishedAt],
    ["usage_complete", "guide.completed", teammate.userId, completedAt],
  ] as const) {
    await store.create(
      TABLES.usageEvents,
      id,
      rowData(
        {
          organization_id: organizationId,
          workspace_id: workspaceId,
          user_id: userId,
          subject_id: guideId,
          kind,
          status: "recorded",
          occurred_at: occurredAt,
          request_id: `request_${id}`,
          created_by: userId,
        },
        {},
      ),
    );
  }

  const bootstrap = await new BootstrapService(store).bootstrap(
    owner,
    workspaceId,
  );
  const steps = bootstrap.activeWorkspace?.onboarding.steps ?? [];
  assert.equal(
    steps.find((step) => step.id === "first_publication")?.completedAt,
    publishedAt,
  );
});

test("Free getting started omits capture steps so 100% is reachable without a trial", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store, {
    subscription: {
      kind: "trial",
      plan: "free",
      startsAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      graceDays: 0,
      retentionDays: 90,
      publicTrial: false,
      manualContract: false,
      status: "active",
      trialConsumed: false,
    },
  });
  const member = identity("free-owner", "free@acme.example", "Owner");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: member.userId,
    email: member.email,
    roles: ["administrator"],
  });
  const bootstrap = await new BootstrapService(store).bootstrap(
    member,
    workspaceId,
  );
  assert.deepEqual(
    bootstrap.activeWorkspace?.onboarding.steps.map((step) => step.id),
    [
      "workspace_readiness",
      "teammate_invitation",
      "first_guide",
      "first_publication",
    ],
  );
});

test("pinning the extension completes the pin onboarding step", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const member = identity("pin-member", "pin@acme.example", "Member");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: member.userId,
    email: member.email,
    roles: ["creator"],
  });
  await new CommandService(store).execute(
    member,
    "confirmExtensionPinned",
    { workspaceId },
    options("pinned"),
  );
  const bootstrap = await new BootstrapService(store).bootstrap(
    member,
    workspaceId,
  );
  assert.equal(
    bootstrap.activeWorkspace?.onboarding.steps.find(
      (step) => step.id === "extension_pin",
    )?.completed,
    true,
  );
});
