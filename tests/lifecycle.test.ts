import assert from "node:assert/strict";
import test from "node:test";
import { TABLES } from "../lib/server/appwrite-resources";
import { decodePayload, rowData, type SubscriptionRecord } from "../lib/server/domain-records";
import { evaluateSubscription, LifecycleService } from "../lib/server/lifecycle-service";
import { InMemoryRecordStore } from "../lib/server/record-store";
import { seedWorkspace, seedWorkspaceMember } from "./helpers/appwrite-fixtures";

const base: SubscriptionRecord = {
  kind: "trial",
  startsAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-02-01T00:00:00.000Z",
  graceDays: 7,
  retentionDays: 90,
  publicTrial: false,
  manualContract: true,
  status: "active",
};

test("subscription boundaries move from active through retained deletion approval", () => {
  assert.equal(
    evaluateSubscription(base, new Date("2026-01-31T23:59:59.999Z")).access,
    "active",
  );
  assert.equal(
    evaluateSubscription(base, new Date("2026-02-01T00:00:00.000Z")).access,
    "read_only",
  );
  assert.equal(
    evaluateSubscription(base, new Date("2026-02-08T00:00:00.000Z")).access,
    "suspended",
  );
  const eligible = evaluateSubscription(
    base,
    new Date("2026-05-02T00:00:00.000Z"),
  );
  assert.equal(eligible.access, "deletion_pending");
  assert.equal(eligible.graceEndsAt, "2026-02-08T00:00:00.000Z");
  assert.equal(eligible.deletionEligibleAt, "2026-05-02T00:00:00.000Z");
  assert.equal(
    evaluateSubscription(
      { ...base, kind: "paid", expiresAt: null },
      new Date("2099-01-01T00:00:00.000Z"),
    ).access,
    "active",
  );
  assert.equal(
    evaluateSubscription(
      { ...base, status: "deleting" },
      new Date("2026-01-01T00:00:00.000Z"),
    ).access,
    "deleting",
  );
});

test("lifecycle sweep is idempotent, suspends after grace, and requires approval", async () => {
  const store = new InMemoryRecordStore();
  const { workspaceId } = await seedWorkspace(store, {
    subscription: base,
  });
  await seedWorkspaceMember(store, {
    workspaceId,
    userId: "admin",
    email: "admin@acme.example",
    roles: ["administrator"],
  });
  const service = new LifecycleService(store);

  await service.sweep(new Date("2026-02-02T00:00:00.000Z"));
  let subscriptionRow = await store.get(
    TABLES.subscriptions,
    `subscription_${workspaceId}`,
  );
  assert.equal(subscriptionRow?.status, "grace");
  assert.equal((await store.get(TABLES.workspaces, workspaceId))?.status, "active");

  await service.sweep(new Date("2026-02-09T00:00:00.000Z"));
  assert.equal((await store.get(TABLES.workspaces, workspaceId))?.status, "suspended");

  const firstDeletionSweep = await service.sweep(
    new Date("2026-05-03T00:00:00.000Z"),
  );
  assert.equal(firstDeletionSweep[0].access, "deletion_pending");
  assert.equal(firstDeletionSweep[0].caseCreated, true);
  const cases = await store.list(TABLES.lifecycleCases);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].status, "awaiting_approval");
  assert.match(
    decodePayload<{ confirmationText: string }>(cases[0], {
      confirmationText: "",
    }).confirmationText,
    /^DELETE /,
  );
  const noticeCount = (await store.list(TABLES.notificationDeliveries)).length;

  const replay = await service.sweep(new Date("2026-05-03T01:00:00.000Z"));
  assert.equal(replay[0].caseCreated, false);
  assert.equal((await store.list(TABLES.lifecycleCases)).length, 1);
  assert.equal((await store.list(TABLES.notificationDeliveries)).length, noticeCount);

  subscriptionRow = await store.get(
    TABLES.subscriptions,
    `subscription_${workspaceId}`,
  );
  assert.ok(subscriptionRow);
  await store.update(
    TABLES.subscriptions,
    subscriptionRow.$id,
    rowData(
      {
        organization_id: subscriptionRow.organization_id as string,
        workspace_id: workspaceId,
        status: "active",
        kind: "design_partner",
      },
      { ...base, status: "active", expiresAt: "2026-08-01T00:00:00.000Z" },
    ),
  );
  await service.sweep(new Date("2026-05-04T00:00:00.000Z"));
  const restoredWorkspace = await store.get(TABLES.workspaces, workspaceId);
  assert.equal(restoredWorkspace?.status, "active");
  assert.equal(
    decodePayload<{ suspensionReason: string | null }>(restoredWorkspace, {
      suspensionReason: "lifecycle",
    }).suspensionReason,
    null,
  );
});
