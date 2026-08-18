import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../lib/server/http-security";
import {
  BUILT_IN_PRIVATE_BETA_TRIAL_CATALOG,
  catalogEntitlements,
  PricingCatalogService,
  resolveSelfServiceTrialPlan,
} from "../lib/server/pricing-catalog-service";
import { InMemoryRecordStore } from "../lib/server/record-store";

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
  assert.equal(entitlements.privacyToolsEnabled, true);
  assert.equal(entitlements.customSubdomainEnabled, true);
  assert.equal(entitlements.removeBranding, true);
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
