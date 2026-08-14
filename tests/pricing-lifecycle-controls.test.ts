import assert from "node:assert/strict";
import test from "node:test";
import { TABLES } from "../lib/server/appwrite-resources";
import { CommandService } from "../lib/server/command-service";
import { decodePayload, rowData } from "../lib/server/domain-records";
import { HttpError } from "../lib/server/http-security";
import {
  assertLifecycleSimulationEnabled,
  LifecycleSimulationService,
  lifecycleSimulationAvailability,
  lifecycleSimulationConfirmation,
  LIFECYCLE_SIMULATION_CREATE_CONFIRMATION,
} from "../lib/server/lifecycle-simulation-service";
import {
  BUILT_IN_PRIVATE_BETA_TRIAL_CATALOG,
  catalogEntitlements,
  PricingCatalogService,
  resolveSelfServiceTrialPlan,
} from "../lib/server/pricing-catalog-service";
import { InMemoryRecordStore } from "../lib/server/record-store";
import { identity, seedWorkspace } from "./helpers/appwrite-fixtures";

const simulationEnvironment = {
  KNOWHOW_ENVIRONMENT: "test",
  NEXT_PUBLIC_KNOWHOW_ENVIRONMENT: "test",
  KNOWHOW_LIFECYCLE_SIMULATION_ENABLED: "1",
};

test("the built-in trial is secure, no-card, and deterministic", () => {
  const catalog = BUILT_IN_PRIVATE_BETA_TRIAL_CATALOG;
  const entitlements = catalogEntitlements(catalog);

  assert.deepEqual(catalog.trial, {
    days: 14,
    graceDays: 7,
    retentionDays: 90,
  });
  assert.equal(catalog.baseWorkspace.amountMinor, null);
  assert.equal(catalog.paymentsEnabled, false);
  assert.equal(catalog.securityFundamentalsIncluded, true);
  assert.equal(entitlements.extensionEnabled, true);
  assert.equal(entitlements.supportEnabled, true);
  assert.equal(entitlements.payments, false);
  assert.equal(entitlements.publicSignup, false);
});

test("platform pricing catalogs resolve by effective date and enforce revisions", async () => {
  const store = new InMemoryRecordStore();
  const service = new PricingCatalogService(store);
  const created = await service.create(
    "platform-owner",
    {
      slug: "private-beta-qa-2026",
      catalogVersion: "private-beta-qa-2026",
      name: "Private beta QA 2026",
      description: "No-card private-beta plan for controlled rehearsal.",
      status: "active",
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      selfServiceTrial: true,
      trial: { days: 21, graceDays: 5, retentionDays: 60 },
      baseWorkspace: {
        amountMinor: 12_500,
        includedActiveCreators: 10,
        includedActiveUsers: 50,
        includedStorageBytes: 2_000_000_000,
      },
    },
    new Date("2026-08-01T00:00:00.000Z"),
  );

  const plan = await resolveSelfServiceTrialPlan(
    store,
    new Date("2026-08-13T00:00:00.000Z"),
  );
  assert.equal(plan.catalogItemId, created.id);
  assert.equal(plan.catalogVersion, "private-beta-qa-2026");
  assert.equal(plan.trialDays, 21);
  assert.equal(plan.graceDays, 5);
  assert.equal(plan.retentionDays, 60);
  assert.equal(plan.entitlements.maximumCreators, 10);
  assert.equal(plan.entitlements.maximumUsers, 50);

  const updated = await service.update(
    "platform-owner",
    created.id,
    created.revision,
    { trial: { days: 14, graceDays: 7, retentionDays: 90 } },
    new Date("2026-08-02T00:00:00.000Z"),
  );
  assert.equal(updated.revision, 2);
  assert.equal(updated.trial.days, 14);
  assert.equal(updated.baseWorkspace.includedActiveUsers, 50);

  await assert.rejects(
    service.update("platform-owner", created.id, 1, { name: "Stale edit" }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "CATALOG_REVISION_CONFLICT",
  );
  const retired = await service.retire(
    "platform-owner",
    created.id,
    updated.revision,
    new Date("2026-08-03T00:00:00.000Z"),
  );
  assert.equal(retired.status, "retired");
  assert.equal(retired.revision, 3);
  await assert.rejects(
    service.update(
      "platform-owner",
      created.id,
      retired.revision,
      { name: "Cannot change" },
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "CATALOG_RETIRED",
  );
});

test("lifecycle simulation is impossible in production and opt-in elsewhere", () => {
  assert.equal(
    lifecycleSimulationAvailability({
      KNOWHOW_ENVIRONMENT: "production",
      NEXT_PUBLIC_KNOWHOW_ENVIRONMENT: "production",
      KNOWHOW_LIFECYCLE_SIMULATION_ENABLED: "1",
    }).enabled,
    false,
  );
  assert.throws(
    () =>
      assertLifecycleSimulationEnabled({
        KNOWHOW_ENVIRONMENT: "production",
        NEXT_PUBLIC_KNOWHOW_ENVIRONMENT: "production",
        KNOWHOW_LIFECYCLE_SIMULATION_ENABLED: "1",
      }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "LIFECYCLE_SIMULATION_PRODUCTION_FORBIDDEN",
  );
  assert.throws(
    () =>
      assertLifecycleSimulationEnabled({
        KNOWHOW_ENVIRONMENT: "test",
        KNOWHOW_LIFECYCLE_SIMULATION_ENABLED: "0",
      }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "LIFECYCLE_SIMULATION_DISABLED",
  );
  assert.deepEqual(assertLifecycleSimulationEnabled(simulationEnvironment), {
    environment: "test",
  });
});

test("the simulator uses the real lifecycle sweep and never rewinds", async () => {
  const store = new InMemoryRecordStore();
  const operator = identity(
    "platform-owner",
    "platform-owner@knowhow.test",
    "Platform Owner",
  );
  const service = new LifecycleSimulationService(
    store,
    simulationEnvironment,
  );
  const created = await service.createSyntheticTenant(
    operator,
    {
      label: "Lifecycle QA",
      confirmation: LIFECYCLE_SIMULATION_CREATE_CONFIRMATION,
      requestId: "request_lifecycle_create_0000000000",
    },
    new Date("2026-08-13T00:00:00.000Z"),
  );
  const workspaceRow = await store.get(TABLES.workspaces, created.workspaceId);
  assert.equal(workspaceRow?.kind, "lifecycle_simulation");
  assert.equal(
    decodePayload<{ simulation?: { synthetic?: boolean } }>(workspaceRow, {})
      .simulation?.synthetic,
    true,
  );

  const sequence = [
    ["near_expiry", "active"],
    ["read_only", "read_only"],
    ["suspended", "suspended"],
    ["retention", "suspended"],
    ["deletion_eligible", "deletion_pending"],
    ["pending_deletion", "deletion_pending"],
  ] as const;
  for (const [state, expectedAccess] of sequence) {
    const transition = await service.simulate(
      operator,
      {
        workspaceId: created.workspaceId,
        state,
        confirmation: lifecycleSimulationConfirmation(
          created.workspaceSlug,
          state,
        ),
      },
      new Date("2026-08-13T12:00:00.000Z"),
    );
    assert.equal(transition.access, expectedAccess);
  }
  assert.equal((await store.list(TABLES.lifecycleCases)).length, 1);
  assert.equal(
    (await store.get(TABLES.workspaces, created.workspaceId))?.status,
    "suspended",
  );
  await assert.rejects(
    service.simulate(operator, {
      workspaceId: created.workspaceId,
      state: "near_expiry",
      confirmation: lifecycleSimulationConfirmation(
        created.workspaceSlug,
        "near_expiry",
      ),
    }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "LIFECYCLE_SIMULATION_REWIND_FORBIDDEN",
  );
});

test("the simulator rejects ordinary tenants and its commands require platform reauthentication", async () => {
  const store = new InMemoryRecordStore();
  const operator = identity(
    "platform-owner",
    "platform-owner@knowhow.test",
    "Platform Owner",
  );
  const { workspaceId, workspace } = await seedWorkspace(store);
  const simulation = new LifecycleSimulationService(
    store,
    simulationEnvironment,
  );
  await assert.rejects(
    simulation.simulate(operator, {
      workspaceId,
      state: "read_only",
      confirmation: lifecycleSimulationConfirmation(
        workspace.slug,
        "read_only",
      ),
    }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "LIFECYCLE_SIMULATION_WORKSPACE_FORBIDDEN",
  );

  await store.create(
    TABLES.platformRoles,
    "platform_owner",
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
  const previousEnvironment = process.env.KNOWHOW_ENVIRONMENT;
  const previousPublicEnvironment = process.env.NEXT_PUBLIC_KNOWHOW_ENVIRONMENT;
  const previousFlag = process.env.KNOWHOW_LIFECYCLE_SIMULATION_ENABLED;
  process.env.KNOWHOW_ENVIRONMENT = "test";
  process.env.NEXT_PUBLIC_KNOWHOW_ENVIRONMENT = "test";
  process.env.KNOWHOW_LIFECYCLE_SIMULATION_ENABLED = "1";
  try {
    await assert.rejects(
      new CommandService(store).execute(
        operator,
        "createLifecycleSimulationTenant",
        {
          label: "Protected command",
          confirmation: LIFECYCLE_SIMULATION_CREATE_CONFIRMATION,
        },
        {
          requestId: "request_lifecycle_protected_000000",
          idempotencyKey: "idempotency_lifecycle_protected_000000",
          reauthenticated: false,
        },
      ),
      (error: unknown) =>
        error instanceof HttpError && error.code === "TOTP_REAUTH_REQUIRED",
    );
    const created = (await new CommandService(store).execute(
      operator,
      "createLifecycleSimulationTenant",
      {
        label: "Scoped replay record",
        confirmation: LIFECYCLE_SIMULATION_CREATE_CONFIRMATION,
      },
      {
        requestId: "request_lifecycle_scoped_0000000000",
        idempotencyKey: "idempotency_lifecycle_scoped_0000000000",
        reauthenticated: true,
      },
    )) as { organizationId: string; workspaceId: string };
    const idempotencyRows = await store.list(TABLES.idempotencyKeys);
    assert.equal(idempotencyRows.length, 1);
    assert.equal(idempotencyRows[0].organization_id, created.organizationId);
    assert.equal(idempotencyRows[0].workspace_id, created.workspaceId);
  } finally {
    if (previousEnvironment === undefined)
      delete process.env.KNOWHOW_ENVIRONMENT;
    else process.env.KNOWHOW_ENVIRONMENT = previousEnvironment;
    if (previousPublicEnvironment === undefined)
      delete process.env.NEXT_PUBLIC_KNOWHOW_ENVIRONMENT;
    else
      process.env.NEXT_PUBLIC_KNOWHOW_ENVIRONMENT =
        previousPublicEnvironment;
    if (previousFlag === undefined)
      delete process.env.KNOWHOW_LIFECYCLE_SIMULATION_ENABLED;
    else process.env.KNOWHOW_LIFECYCLE_SIMULATION_ENABLED = previousFlag;
  }
});
