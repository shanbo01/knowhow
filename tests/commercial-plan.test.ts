import assert from "node:assert/strict";
import test from "node:test";
import { TABLES } from "../lib/server/appwrite-resources";
import {
  effectiveCommercialPlan,
  entitlementsForPlan,
  inferredCommercialPlan,
  isRetainLifecycle,
} from "../lib/server/commercial-plan";
import { CommandService } from "../lib/server/command-service";
import { decodePayload, rowData, type GuideRecord, type SubscriptionRecord } from "../lib/server/domain-records";
import { applyPlanEntitlements, EntitlementService } from "../lib/server/entitlement-service";
import { HttpError } from "../lib/server/http-security";
import { LifecycleService } from "../lib/server/lifecycle-service";
import { InMemoryRecordStore } from "../lib/server/record-store";
import {
  identity,
  seedWorkspace,
  seedWorkspaceMember,
} from "./helpers/appwrite-fixtures";

process.env.KNOWHOW_TOKEN_KEYS_JSON = JSON.stringify({
  test: "test-signing-secret-with-at-least-thirty-two-random-bytes",
});
process.env.KNOWHOW_TOKEN_ACTIVE_KID = "test";

const options = (suffix: string) => ({
  requestId: `request_plan_${suffix}_0000000000`,
  idempotencyKey: `idempotency_plan_${suffix}_0000000000`,
  reauthenticated: true,
});

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError);
    return error.code;
  }
  assert.fail("Expected command to fail.");
}

async function seedAdmin(
  store: InMemoryRecordStore,
  subscription: Partial<SubscriptionRecord>,
) {
  const seeded = await seedWorkspace(store, { subscription });
  const admin = identity("admin", "admin@acme.example", "Admin");
  await seedWorkspaceMember(store, {
    organizationId: seeded.organizationId,
    workspaceId: seeded.workspaceId,
    userId: admin.userId,
    email: admin.email,
    roles: ["administrator", "creator"],
  });
  return { ...seeded, admin };
}

test("legacy subscription kinds map onto the commercial plan catalog", () => {
  assert.equal(inferredCommercialPlan({ kind: "paid", manualContract: false }), "pro");
  assert.equal(
    inferredCommercialPlan({ kind: "design_partner", manualContract: true }),
    "enterprise",
  );
  assert.equal(
    inferredCommercialPlan({ kind: "trial", manualContract: true }),
    "enterprise",
  );
  assert.equal(
    inferredCommercialPlan({ kind: "trial", manualContract: false }),
    "pro_trial",
  );
  assert.equal(
    inferredCommercialPlan({
      kind: "trial",
      plan: "free",
      manualContract: false,
    }),
    "free",
  );
  assert.equal(
    isRetainLifecycle({
      kind: "trial",
      manualContract: true,
      startsAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
      graceDays: 7,
      retentionDays: 90,
      publicTrial: false,
      status: "active",
    }),
    true,
  );
});

test("Free workspaces cannot capture or use privacy tools even if stored flags say otherwise", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId, admin } = await seedAdmin(store, {
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
  });
  await applyPlanEntitlements(store, {
    organizationId,
    workspaceId,
    actorUserId: admin.userId,
    entitlements: {
      extensionEnabled: true,
      privacyToolsEnabled: true,
      supportEnabled: true,
      removeBranding: true,
      customSubdomainEnabled: true,
      maximumUsers: 100,
      maximumCreators: 25,
      storageBytes: 50_000_000_000,
      publicSignup: false,
      payments: false,
      ssoScim: false,
    },
  });
  const snapshot = await new EntitlementService(store, workspaceId).snapshot();
  assert.equal(snapshot.extensionEnabled, false);
  assert.equal(snapshot.privacyToolsEnabled, false);
  assert.equal(snapshot.supportEnabled, false);
  assert.equal(snapshot.fileExportsEnabled, false);
  assert.equal(
    await codeOf(
      new EntitlementService(store, workspaceId).requireFeature(
        "fileExportsEnabled",
      ),
    ),
    "ENTITLEMENT_REQUIRED",
  );
  assert.equal(
    await codeOf(
      new CommandService(store).execute(
        admin,
        "createPairingCode",
        { workspaceId },
        options("free-pair"),
      ),
    ),
    "ENTITLEMENT_REQUIRED",
  );
  assert.equal(
    await codeOf(
      new CommandService(store).execute(
        admin,
        "createSupportTicket",
        { workspaceId, subject: "Need help", message: "Please look at this workspace." },
        options("free-ticket"),
      ),
    ),
    "ENTITLEMENT_REQUIRED",
  );
});

test("file exports are included on Pro and denied on Free", () => {
  assert.equal(entitlementsForPlan("free").fileExportsEnabled, false);
  assert.equal(entitlementsForPlan("pro_trial").fileExportsEnabled, true);
  assert.equal(entitlementsForPlan("pro").fileExportsEnabled, true);
  assert.equal(entitlementsForPlan("enterprise").fileExportsEnabled, true);
});

test("startProTrial is once, from Free, and never requires a payment method", async () => {
  const store = new InMemoryRecordStore();
  const { workspaceId, admin } = await seedAdmin(store, {
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
  });
  const service = new CommandService(store);
  const started = (await service.execute(
    admin,
    "startProTrial",
    { workspaceId, stripeCustomerId: "cus_should_be_ignored" },
    options("start-trial"),
  )) as {
    plan: string;
    expiresAt: string;
    paymentMethodRequired: boolean;
  };
  assert.equal(started.plan, "pro_trial");
  assert.equal(started.paymentMethodRequired, false);
  assert.equal(
    Date.parse(started.expiresAt) - Date.now() > 13 * 86_400_000,
    true,
  );
  const entitlements = await new EntitlementService(store, workspaceId).snapshot();
  assert.equal(entitlements.extensionEnabled, true);
  assert.equal(entitlements.privacyToolsEnabled, true);
  assert.equal(
    await codeOf(
      service.execute(admin, "startProTrial", { workspaceId }, options("start-trial-again")),
    ),
    "PRO_TRIAL_NOT_AVAILABLE",
  );

  const paidStore = new InMemoryRecordStore();
  const paid = await seedAdmin(paidStore, {
    kind: "paid",
    plan: "pro",
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    graceDays: 7,
    retentionDays: 90,
    publicTrial: false,
    manualContract: true,
    status: "active",
  });
  assert.equal(
    await codeOf(
      new CommandService(paidStore).execute(
        paid.admin,
        "startProTrial",
        { workspaceId: paid.workspaceId },
        options("paid-trial"),
      ),
    ),
    "PRO_TRIAL_NOT_AVAILABLE",
  );
});

test("paid plan requests create leads without granting paid entitlements", async () => {
  const store = new InMemoryRecordStore();
  const { workspaceId, admin } = await seedAdmin(store, {
    kind: "trial",
    plan: "pro_trial",
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z",
    graceDays: 0,
    retentionDays: 90,
    publicTrial: false,
    manualContract: false,
    status: "active",
    trialConsumed: true,
  });
  const selected = (await new CommandService(store).execute(
    admin,
    "selectProPlan",
    { workspaceId },
    options("select-pro"),
  )) as { requested: boolean; leadId: string };
  assert.equal(selected.requested, true);
  const subscription = decodePayload<SubscriptionRecord>(
    (await store.list(TABLES.subscriptions))[0],
    null as never,
  );
  assert.equal(subscription.plan, "pro_trial");

  const requested = (await new CommandService(store).execute(
    admin,
    "requestEnterprisePlan",
    { workspaceId },
    options("request-ent"),
  )) as { requested: boolean; leadId: string };
  assert.equal(requested.requested, true);
  const leads = await store.list(TABLES.leads);
  assert.equal(leads.length, 2);
  assert.deepEqual(
    leads.map((row) => decodePayload<{ requestedPlan: string }>(row, null as never).requestedPlan).sort(),
    ["enterprise", "pro"],
  );
});

test("viewers cannot open support tickets on Pro", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store, {
    subscription: {
      kind: "paid",
      plan: "pro",
      startsAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      graceDays: 7,
      retentionDays: 90,
      publicTrial: false,
      manualContract: true,
      status: "active",
    },
  });
  const viewer = identity("viewer", "viewer@acme.example", "Viewer");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: viewer.userId,
    email: viewer.email,
    roles: ["viewer"],
  });
  assert.equal(
    await codeOf(
      new CommandService(store).execute(
        viewer,
        "createSupportTicket",
        {
          workspaceId,
          subject: "Need help",
          message: "Please look at this workspace.",
        },
        options("viewer-ticket"),
      ),
    ),
    "SUPPORT_TICKET_ROLE_REQUIRED",
  );
});

test("expired Pro trial downgrades entitlements and keeps members and guides", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId, admin } = await seedAdmin(store, {
    kind: "trial",
    plan: "pro_trial",
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z",
    graceDays: 0,
    retentionDays: 90,
    publicTrial: false,
    manualContract: false,
    status: "active",
    trialConsumed: true,
  });
  await applyPlanEntitlements(store, {
    organizationId,
    workspaceId,
    actorUserId: admin.userId,
    entitlements: {
      extensionEnabled: true,
      privacyToolsEnabled: true,
      supportEnabled: true,
      removeBranding: true,
      customSubdomainEnabled: true,
      maximumUsers: 100,
      maximumCreators: 25,
      storageBytes: 50_000_000_000,
      publicSignup: false,
      payments: false,
      ssoScim: false,
    },
  });
  const guide: GuideRecord = {
    title: "Kept guide",
    slug: "kept-guide",
    authorUserId: admin.userId,
    publishedRevisionId: null,
    workingRevisionId: null,
    screenshotsLockedAt: null,
    archivedAt: null,
    createdAt: "2026-01-15T00:00:00.000Z",
    updatedAt: "2026-01-15T00:00:00.000Z",
  };
  await store.create(
    TABLES.guides,
    "guide_kept",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        status: "draft",
        created_by: admin.userId,
      },
      guide,
    ),
  );

  const now = new Date("2026-02-02T00:00:00.000Z");
  assert.equal(
    effectiveCommercialPlan(
      decodePayload(
        (await store.get(TABLES.subscriptions, `subscription_${workspaceId}`))!,
        null as never,
      ),
      now,
    ),
    "free",
  );
  await new LifecycleService(store).sweep(now);

  const workspace = await store.get(TABLES.workspaces, workspaceId);
  assert.equal(workspace?.status, "active");
  const subscription = decodePayload<SubscriptionRecord>(
    (await store.get(TABLES.subscriptions, `subscription_${workspaceId}`))!,
    null as never,
  );
  assert.equal(subscription.plan, "free");
  assert.equal(subscription.status, "active");
  assert.equal((await store.list(TABLES.workspaceMembers)).length, 1);
  assert.equal((await store.list(TABLES.guides)).length, 1);
  assert.equal((await store.list(TABLES.lifecycleCases)).length, 0);
  const entitlements = await new EntitlementService(store, workspaceId).snapshot();
  assert.equal(entitlements.extensionEnabled, false);
  assert.equal(entitlements.privacyToolsEnabled, false);
  assert.equal(entitlements.supportEnabled, false);
  assert.equal(
    await codeOf(
      new CommandService(store).execute(
        admin,
        "startProTrial",
        { workspaceId },
        options("after-downgrade"),
      ),
    ),
    "PRO_TRIAL_USED",
  );
});

async function seedPlatformOwner(store: InMemoryRecordStore) {
  const operator = identity(
    "platform-owner",
    "platform-owner@knowhow.test",
    "Platform Owner",
  );
  await store.create(
    TABLES.platformRoles,
    `platform_owner_${operator.userId}`,
    rowData(
      {
        user_id: operator.userId,
        kind: "owner",
        status: "active",
        created_by: "seed",
      },
      { role: "owner" },
    ),
  );
  return operator;
}

test("operators can grant a second Pro trial after the customer one-shot is consumed", async () => {
  const store = new InMemoryRecordStore();
  const { workspaceId, admin } = await seedAdmin(store, {
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
  });
  const service = new CommandService(store);
  await service.execute(admin, "startProTrial", { workspaceId }, options("cust-trial"));
  assert.equal(
    await codeOf(
      service.execute(admin, "startProTrial", { workspaceId }, options("cust-trial-2")),
    ),
    "PRO_TRIAL_NOT_AVAILABLE",
  );
  const operator = await seedPlatformOwner(store);
  const granted = (await service.execute(
    operator,
    "grantProTrial",
    {
      targetWorkspaceId: workspaceId,
      days: 14,
      reason: "Customer published after the first trial ended",
    },
    options("op-trial"),
  )) as { plan: string; days: number };
  assert.equal(granted.plan, "pro_trial");
  assert.equal(granted.days, 14);
  const entitlements = await new EntitlementService(store, workspaceId).snapshot();
  assert.equal(entitlements.extensionEnabled, true);
});

test("convertSubscription honors Pro vs Enterprise and Free freeze blocks overrides", async () => {
  const store = new InMemoryRecordStore();
  const { workspaceId } = await seedAdmin(store, {
    kind: "trial",
    plan: "free",
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    graceDays: 0,
    retentionDays: 90,
    publicTrial: false,
    manualContract: false,
    status: "active",
    trialConsumed: true,
  });
  const operator = await seedPlatformOwner(store);
  const service = new CommandService(store);
  assert.equal(
    await codeOf(
      service.execute(
        operator,
        "updateEntitlementOverrides",
        {
          targetWorkspaceId: workspaceId,
          reason: "Trying to punch capture into Free",
          overrides: [
            {
              kind: "maximumUsers",
              value: 50,
              expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            },
          ],
        },
        options("free-override"),
      ),
    ),
    "ENTITLEMENT_OVERRIDE_FROZEN",
  );
  const converted = (await service.execute(
    operator,
    "convertSubscription",
    {
      targetWorkspaceId: workspaceId,
      plan: "pro",
      manualReference: "INV-204",
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      reason: "Converted after paid invoice",
    },
    options("to-pro"),
  )) as { plan: string };
  assert.equal(converted.plan, "pro");
  const pro = await new EntitlementService(store, workspaceId).snapshot();
  assert.equal(pro.extensionEnabled, true);
  assert.equal(pro.maximumUsers, 100);
  await service.execute(
    operator,
    "updateEntitlementOverrides",
    {
      targetWorkspaceId: workspaceId,
      reason: "Temporary extra seats for a rollout",
      overrides: [
        {
          kind: "maximumUsers",
          value: 180,
          expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        },
      ],
    },
    options("seat-override"),
  );
  const overridden = await new EntitlementService(store, workspaceId).snapshot();
  assert.equal(overridden.maximumUsers, 180);
  const enterprise = (await service.execute(
    operator,
    "convertSubscription",
    {
      targetWorkspaceId: workspaceId,
      plan: "enterprise",
      manualReference: "MSA-9",
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      reason: "Signed enterprise agreement",
    },
    options("to-ent"),
  )) as { plan: string };
  assert.equal(enterprise.plan, "enterprise");
});

test("expired entitlement overrides fall back to the catalog and Free ignores stored Pro flags", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId, admin } = await seedAdmin(store, {
    kind: "paid",
    plan: "pro",
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    graceDays: 7,
    retentionDays: 90,
    publicTrial: false,
    manualContract: true,
    status: "active",
  });
  await applyPlanEntitlements(store, {
    organizationId,
    workspaceId,
    actorUserId: admin.userId,
    entitlements: {
      extensionEnabled: true,
      privacyToolsEnabled: true,
      supportEnabled: true,
      removeBranding: true,
      customSubdomainEnabled: true,
      maximumUsers: 100,
      maximumCreators: 25,
      storageBytes: 50_000_000_000,
      publicSignup: false,
      payments: false,
      ssoScim: false,
    },
  });
  const existing = await store.list(TABLES.entitlements, {
    filters: [
      { field: "workspace_id", value: workspaceId },
      { field: "kind", value: "maximumUsers" },
    ],
    limit: 1,
  });
  assert.ok(existing[0]);
  await store.update(
    TABLES.entitlements,
    existing[0]!.$id,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        kind: "maximumUsers",
        status: "active",
        updated_by: "seed",
      },
      {
        value: 500,
        source: "override",
        reason: "Expired extra seats",
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
    ),
  );
  const snapshot = await new EntitlementService(store, workspaceId).snapshot();
  assert.equal(snapshot.maximumUsers, 100);

  const freeStore = new InMemoryRecordStore();
  const free = await seedAdmin(freeStore, {
    kind: "trial",
    plan: "free",
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    graceDays: 0,
    retentionDays: 90,
    publicTrial: false,
    manualContract: false,
    status: "active",
    trialConsumed: true,
  });
  await applyPlanEntitlements(freeStore, {
    organizationId: free.organizationId,
    workspaceId: free.workspaceId,
    actorUserId: free.admin.userId,
    entitlements: {
      extensionEnabled: true,
      privacyToolsEnabled: true,
      supportEnabled: true,
      removeBranding: true,
      customSubdomainEnabled: true,
      maximumUsers: 100,
      maximumCreators: 25,
      storageBytes: 50_000_000_000,
      publicSignup: false,
      payments: false,
      ssoScim: false,
    },
  });
  const frozen = await new EntitlementService(freeStore, free.workspaceId).snapshot();
  assert.equal(frozen.extensionEnabled, false);
  assert.equal(frozen.maximumUsers, 3);
});

test("entitlement denials write entitlement.blocked usage events", async () => {
  const store = new InMemoryRecordStore();
  const { workspaceId, admin } = await seedAdmin(store, {
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
  });
  assert.equal(
    await codeOf(
      new CommandService(store).execute(
        admin,
        "createPairingCode",
        { workspaceId },
        options("blocked-pair"),
      ),
    ),
    "ENTITLEMENT_REQUIRED",
  );
  const events = await store.list(TABLES.usageEvents, {
    filters: [
      { field: "workspace_id", value: workspaceId },
      { field: "kind", value: "entitlement.blocked" },
    ],
  });
  assert.equal(events.length, 1);
});
