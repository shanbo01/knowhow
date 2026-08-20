import assert from "node:assert/strict";
import test from "node:test";
import { TABLES } from "../lib/server/appwrite-resources";
import { CommandService } from "../lib/server/command-service";
import { decodePayload, rowData } from "../lib/server/domain-records";
import { EntitlementService } from "../lib/server/entitlement-service";
import { HttpError } from "../lib/server/http-security";
import { InMemoryRecordStore } from "../lib/server/record-store";
import type { AuthenticatedIdentity } from "../lib/server/session-identity";
import type { SelfServiceSetupResult } from "../lib/server/self-service-provisioning-service";
import { identity } from "./helpers/appwrite-fixtures";

process.env.KNOWHOW_TOKEN_KEYS_JSON = JSON.stringify({
  test: "test-signing-secret-with-at-least-thirty-two-random-bytes",
});
process.env.KNOWHOW_TOKEN_ACTIVE_KID = "test";
process.env.KNOWHOW_REGISTRATION_MODE = "open";

const options = (suffix: string, reauthenticated = true) => ({
  requestId: `request_self_service_${suffix}_0000000000`,
  idempotencyKey: `idempotency_self_service_${suffix}_0000000000`,
  reauthenticated,
});

const setup = {
  organizationName: "Northstar Operations",
  legalName: "Northstar Operations LLC",
  country: "QA",
  workspaceName: "Internal IT",
  accentColor: "#c45528",
};

async function admit(
  store: InMemoryRecordStore,
  actor: AuthenticatedIdentity,
  suffix = actor.userId,
) {
  const grantId = `beta_grant_${suffix}`;
  const consumedAt = "2026-08-13T08:00:00.000Z";
  await store.create(
    TABLES.betaAccessGrants,
    grantId,
    rowData(
      {
        subject_id: `hash_${suffix}`,
        email: actor.email,
        status: "exhausted",
        kind: "private_beta",
        expires_at: "2027-08-13T08:00:00.000Z",
        created_by: "platform-owner",
      },
      {
        label: "Test admission",
        exactEmail: actor.email,
        maxUses: 1,
        usedCount: 1,
        reservedCount: 0,
        createdAt: consumedAt,
        createdBy: "platform-owner",
        expiresAt: "2027-08-13T08:00:00.000Z",
        lastUsedAt: consumedAt,
      },
    ),
  );
  await store.create(
    TABLES.betaAccessEvents,
    `beta_event_${suffix}`,
    rowData(
      {
        subject_id: grantId,
        user_id: actor.userId,
        email: actor.email,
        status: "consumed",
        kind: "consumed",
        occurred_at: consumedAt,
        created_by: actor.userId,
      },
      { grantId, consumedAt },
    ),
  );
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError);
    return error.code;
  }
  assert.fail("Expected command to fail.");
}

test("a verified user resumes setup and creates one complete trial tenant", async () => {
  const store = new InMemoryRecordStore();
  const owner = identity(
    "self-service-owner",
    "owner@northstar.test",
    "Nora Owner",
  );
  const service = new CommandService(store);

  const firstDraft = (await service.execute(
    owner,
    "saveSelfServiceSetup",
    { organizationName: setup.organizationName, legalName: setup.legalName },
    options("draft-one", false),
  )) as { runId: string; status: string; draft: Record<string, unknown> };
  const resumedDraft = (await service.execute(
    owner,
    "saveSelfServiceSetup",
    {
      workspaceName: setup.workspaceName,
      country: setup.country,
      accentColor: setup.accentColor,
    },
    options("draft-two", false),
  )) as { runId: string; status: string; draft: Record<string, unknown> };

  assert.equal(firstDraft.runId, resumedDraft.runId);
  assert.equal(resumedDraft.status, "draft");
  assert.deepEqual(resumedDraft.draft, setup);

  const result = (await service.execute(
    owner,
    "completeSelfServiceSetup",
    { inviteEmail: "teammate@northstar.test" },
    options("complete"),
  )) as SelfServiceSetupResult;

  assert.ok(result.organizationId.startsWith("org_"));
  assert.ok(result.workspaceId.startsWith("workspac_"));
  assert.match(result.invite?.inviteUrl ?? "", /^\/app\?invite=/);
  assert.ok(result.trial.expiresAt);
  assert.ok(result.trial.graceEndsAt);
  assert.ok(result.trial.deletionEligibleAt);
  assert.equal(
    Date.parse(result.trial.expiresAt) - Date.parse(result.trial.startsAt),
    14 * 86_400_000,
  );
  assert.equal(
    Date.parse(result.trial.graceEndsAt) - Date.parse(result.trial.expiresAt),
    7 * 86_400_000,
  );
  assert.equal(
    Date.parse(result.trial.deletionEligibleAt) -
      Date.parse(result.trial.expiresAt),
    90 * 86_400_000,
  );

  assert.equal((await store.list(TABLES.organizations)).length, 1);
  assert.equal((await store.list(TABLES.workspaces)).length, 1);
  assert.equal((await store.list(TABLES.organizationMemberships)).length, 1);
  assert.equal((await store.list(TABLES.workspaceMembers)).length, 1);
  const entitlements = await store.list(TABLES.entitlements);
  assert.equal(entitlements.length, 13);
  assert.ok(
    entitlements.some(
      (entitlement) =>
        entitlement.kind === "desktopCaptureEnabled" &&
        entitlement.status === "active",
    ),
  );
  assert.equal((await store.list(TABLES.onboardingProgress)).length, 1);
  const usageEvents = await store.list(TABLES.usageEvents);
  assert.equal(usageEvents.length, 3);
  assert.equal(
    new Set(usageEvents.map((event) => event.request_id)).size,
    3,
    "each setup milestone must satisfy the unique request_id index",
  );
  assert.equal((await store.list(TABLES.auditSegments)).length, 1);
  assert.equal((await store.list(TABLES.invitations)).length, 1);
  assert.equal((await store.list(TABLES.notificationDeliveries)).length, 1);

  const organizationMembership = (
    await store.list(TABLES.organizationMemberships)
  )[0]!;
  assert.deepEqual(
    decodePayload<{ roles?: string[] }>(organizationMembership, {}).roles,
    ["owner"],
  );
  assert.equal(organizationMembership.user_id, owner.userId);
  const workspaceMembership = (await store.list(TABLES.workspaceMembers))[0]!;
  assert.deepEqual(
    decodePayload<{ roles?: string[] }>(workspaceMembership, {}).roles,
    ["administrator"],
  );
  assert.equal(workspaceMembership.user_id, owner.userId);
  const workspace = await store.get(TABLES.workspaces, result.workspaceId);
  assert.equal(
    decodePayload<{ auditSequence?: number }>(workspace, {}).auditSequence,
    1,
  );
  const subscription = await store.get(
    TABLES.subscriptions,
    result.subscriptionId,
  );
  const trial = decodePayload<Record<string, unknown>>(subscription, {});
  assert.equal(trial.kind, "trial");
  assert.equal(trial.plan, "pro_trial");
  assert.equal(trial.publicTrial, false);
  assert.equal(trial.manualContract, false);
  assert.equal(trial.originalExpiresAt, result.trial.expiresAt);
  assert.equal(trial.deletionEligibleAt, result.trial.deletionEligibleAt);
  const run = await store.get(TABLES.provisioningRuns, firstDraft.runId);
  assert.equal(run?.kind, "self_service");
  assert.equal(run?.status, "completed");
  const persistedRun = decodePayload<{
    result?: SelfServiceSetupResult;
  }>(run, {});
  assert.equal(persistedRun.result?.invite?.inviteUrl, undefined);
  assert.equal((await store.list(TABLES.platformRoles)).length, 0);
  assert.equal((await store.list(TABLES.initialAdminAppointments)).length, 0);
});

test("self-service setup requires a verified identity", async () => {
  const store = new InMemoryRecordStore();
  const unverified = {
    ...identity("unverified-owner", "unverified@northstar.test"),
    emailVerified: false,
  };
  assert.equal(
    await codeOf(
      new CommandService(store).execute(
        unverified,
        "completeSelfServiceSetup",
        setup,
        options("unverified"),
      ),
    ),
    "EMAIL_NOT_VERIFIED",
  );
  assert.equal((await store.list(TABLES.organizations)).length, 0);
});

test("private-beta mode still requires consumed admission", async () => {
  const previous = process.env.KNOWHOW_REGISTRATION_MODE;
  process.env.KNOWHOW_REGISTRATION_MODE = "private_beta";
  try {
    const store = new InMemoryRecordStore();
    const owner = identity("not-admitted", "not-admitted@northstar.test");
    assert.equal(
      await codeOf(
        new CommandService(store).execute(
          owner,
          "completeSelfServiceSetup",
          setup,
          options("no-admission"),
        ),
      ),
      "BETA_ADMISSION_REQUIRED",
    );
    assert.equal((await store.list(TABLES.organizations)).length, 0);
  } finally {
    process.env.KNOWHOW_REGISTRATION_MODE = previous;
  }
});

test("disabled mode rejects self-service setup", async () => {
  const previous = process.env.KNOWHOW_REGISTRATION_MODE;
  process.env.KNOWHOW_REGISTRATION_MODE = "disabled";
  try {
    const store = new InMemoryRecordStore();
    const owner = identity("locked-owner", "locked@northstar.test");
    assert.equal(
      await codeOf(
        new CommandService(store).execute(
          owner,
          "completeSelfServiceSetup",
          setup,
          options("disabled"),
        ),
      ),
      "SELF_SERVICE_DISABLED",
    );
    assert.equal((await store.list(TABLES.organizations)).length, 0);
  } finally {
    process.env.KNOWHOW_REGISTRATION_MODE = previous;
  }
});

test("self-service setup does not require MFA", async () => {
  const store = new InMemoryRecordStore();
  const withoutMfa = {
    ...identity("owner-no-mfa", "no-mfa@northstar.test"),
    mfaEnabled: false,
  };
  const service = new CommandService(store);
  const result = (await service.execute(
    withoutMfa,
    "completeSelfServiceSetup",
    setup,
    options("no-mfa", false),
  )) as SelfServiceSetupResult;
  assert.ok(result.organizationId);
  assert.equal((await store.list(TABLES.organizations)).length, 1);
});

test("configured per-user workspace limit blocks an additional created workspace", async () => {
  const store = new InMemoryRecordStore();
  const owner = identity("limited-owner", "limited@northstar.test");
  await admit(store, owner);
  await store.create(
    TABLES.catalogItems,
    "platform_settings",
    rowData(
      {
        slug: "platform_settings",
        kind: "platform_settings",
        status: "active",
      },
      { selfServiceWorkspaceLimit: 1 },
    ),
  );
  await store.create(
    TABLES.workspaces,
    "workspace_existing",
    rowData(
      {
        organization_id: "org_existing",
        slug: "existing",
        status: "active",
        created_by: owner.userId,
      },
      {
        organizationId: "org_existing",
        name: "Existing",
        slug: "existing",
        status: "active",
        createdAt: "2026-08-01T00:00:00.000Z",
        auditSequence: 0,
        auditHash: "0".repeat(64),
      },
    ),
  );
  await store.create(
    TABLES.workspaceMembers,
    "member_existing",
    rowData(
      {
        organization_id: "org_existing",
        workspace_id: "workspace_existing",
        user_id: owner.userId,
        email: owner.email,
        status: "active",
        created_by: owner.userId,
      },
      {
        name: owner.name,
        roles: ["administrator"],
        capabilities: [],
        groupIds: [],
      },
    ),
  );
  assert.equal(
    await codeOf(
      new CommandService(store).execute(
        owner,
        "completeSelfServiceSetup",
        setup,
        options("limit"),
      ),
    ),
    "SELF_SERVICE_WORKSPACE_LIMIT",
  );
  assert.equal((await store.list(TABLES.organizations)).length, 0);
});

test("concurrent completion and new idempotency keys replay one cross-bound tenant", async () => {
  const store = new InMemoryRecordStore();
  const owner = identity(
    "racing-owner",
    "racing@northstar.test",
    "Racing Owner",
  );
  await admit(store, owner);
  const [first, second] = (await Promise.all([
    new CommandService(store).execute(
      owner,
      "completeSelfServiceSetup",
      setup,
      options("race-one"),
    ),
    new CommandService(store).execute(
      owner,
      "completeSelfServiceSetup",
      { ...setup, organizationName: "A conflicting retry name" },
      options("race-two"),
    ),
  ])) as SelfServiceSetupResult[];

  assert.equal(first.organizationId, second.organizationId);
  assert.equal(first.workspaceId, second.workspaceId);
  assert.equal((await store.list(TABLES.organizations)).length, 1);
  assert.equal((await store.list(TABLES.workspaces)).length, 1);
  assert.equal((await store.list(TABLES.organizationMemberships)).length, 1);
  assert.equal((await store.list(TABLES.workspaceMembers)).length, 1);
  const organization = await store.get(
    TABLES.organizations,
    first.organizationId,
  );
  assert.equal(
    decodePayload<{ displayName?: string }>(organization, {}).displayName,
    setup.organizationName,
  );
  assert.equal(organization?.created_by, owner.userId);
  assert.equal(organization?.$id, first.organizationId);
});

test("Free signup creates a forever Free workspace without a trial clock", async () => {
  const store = new InMemoryRecordStore();
  const owner = identity(
    "free-owner",
    "free@northstar.test",
    "Free Owner",
  );
  await admit(store, owner, owner.userId);
  const result = (await new CommandService(store).execute(
    owner,
    "completeSelfServiceSetup",
    { ...setup, plan: "free" },
    options("complete-free"),
  )) as SelfServiceSetupResult;

  assert.equal(result.trial.plan, "free");
  assert.equal(result.trial.expiresAt, null);
  const subscription = decodePayload<Record<string, unknown>>(
    await store.get(TABLES.subscriptions, result.subscriptionId),
    {},
  );
  assert.equal(subscription.plan, "free");
  assert.equal(subscription.trialConsumed, false);
  const entitlements = await new EntitlementService(
    store,
    result.workspaceId,
  ).snapshot();
  assert.equal(entitlements.extensionEnabled, false);
  assert.equal(entitlements.privacyToolsEnabled, false);
  assert.equal(entitlements.supportEnabled, false);
});
