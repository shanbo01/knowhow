import test from "node:test";
import assert from "node:assert/strict";
import { runLifecycle } from "../src/main.js";

function createMockTables(initialData = {}) {
  const collections = {
    subscriptions: initialData.subscriptions || [],
    workspaces: initialData.workspaces || [],
    workspace_members: initialData.workspace_members || [],
    entitlements: initialData.entitlements || [],
    lifecycle_cases: initialData.lifecycle_cases || [],
    notification_deliveries: initialData.notification_deliveries || [],
    organizations: initialData.organizations || [],
  };

  return {
    collections,
    async listRows({ tableId, queries = [] }) {
      let rows = collections[tableId] || [];
      for (const query of queries) {
        if (query && typeof query === "object" && query.method === "equal") {
          const attribute = query.attribute;
          const values = query.values;
          rows = rows.filter((r) => values.includes(r[attribute]));
        }
      }
      return { rows };
    },
    async getRow({ tableId, rowId }) {
      const row = (collections[tableId] || []).find((r) => r.$id === rowId);
      if (!row) {
        const err = new Error("Document not found");
        err.code = 404;
        throw err;
      }
      return row;
    },
    async updateRow({ tableId, rowId, data }) {
      const rows = collections[tableId] || [];
      const index = rows.findIndex((r) => r.$id === rowId);
      if (index !== -1) {
        rows[index] = { ...rows[index], ...data };
        return rows[index];
      }
      const newRow = { $id: rowId, ...data };
      rows.push(newRow);
      return newRow;
    },
    async createRow({ tableId, rowId, data }) {
      const rows = collections[tableId] || [];
      if (rows.some((r) => r.$id === rowId)) {
        const err = new Error("Document already exists");
        err.code = 409;
        throw err;
      }
      const newRow = { $id: rowId, ...data };
      rows.push(newRow);
      return newRow;
    },
  };
}

test("runLifecycle skips deleted subscriptions and processes non-workspace subscriptions", async () => {
  const tables = createMockTables({
    subscriptions: [
      { $id: "sub_1", status: "deleted" },
      { $id: "sub_2", workspace_id: "ws_1", status: "deleted" },
    ],
  });

  const now = new Date("2025-01-01T00:00:00.000Z");
  const result = await runLifecycle({ tables }, now);

  assert.equal(result.checked, 2);
  assert.equal(result.skippedDeleted, 1);
  assert.equal(result.transitions, 0);
  assert.equal(result.queued, 0);
});

test("runLifecycle downgrades expired pro_trial subscription to free tier", async () => {
  const now = new Date("2025-01-10T00:00:00.000Z");
  const subData = {
    plan: "pro_trial",
    kind: "trial",
    status: "active",
    startsAt: "2025-01-01T00:00:00.000Z",
    expiresAt: "2025-01-08T00:00:00.000Z",
    manualContract: false,
  };
  const tables = createMockTables({
    subscriptions: [
      {
        $id: "sub_1",
        organization_id: "org_1",
        workspace_id: "ws_1",
        kind: "trial",
        status: "active",
        $createdAt: "2025-01-01T00:00:00.000Z",
        payload_json: JSON.stringify(subData),
      },
    ],
    entitlements: [
      {
        $id: "ent_1",
        workspace_id: "ws_1",
        kind: "maximumUsers",
        payload_json: JSON.stringify({ value: 10 }),
      },
    ],
  });

  const result = await runLifecycle({ tables }, now);

  assert.equal(result.checked, 1);
  assert.equal(result.skippedDeleted, 0);
  assert.equal(result.transitions, 1);

  const updatedSub = tables.collections.subscriptions.find((r) => r.$id === "sub_1");
  const subPayload = JSON.parse(updatedSub.payload_json);
  assert.equal(subPayload.plan, "free");
  assert.equal(subPayload.trialConsumed, true);

  const updatedEnt = tables.collections.entitlements.find((r) => r.$id === "ent_1");
  const entPayload = JSON.parse(updatedEnt.payload_json);
  assert.equal(entPayload.value, 3);
});

test("runLifecycle handles enterprise subscription lifecycle, workspace suspension and notices", async () => {
  const now = new Date("2025-02-01T00:00:00.000Z");
  const subData = {
    plan: "enterprise",
    kind: "design_partner",
    status: "active",
    startsAt: "2025-01-01T00:00:00.000Z",
    expiresAt: "2025-01-10T00:00:00.000Z",
    graceDays: 7,
    retentionDays: 90,
  };
  const tables = createMockTables({
    subscriptions: [
      {
        $id: "sub_1",
        organization_id: "org_1",
        workspace_id: "ws_1",
        kind: "design_partner",
        status: "active",
        $createdAt: "2025-01-01T00:00:00.000Z",
        payload_json: JSON.stringify(subData),
      },
    ],
    workspaces: [
      {
        $id: "ws_1",
        organization_id: "org_1",
        status: "active",
        payload_json: JSON.stringify({ name: "Test Workspace" }),
      },
    ],
    workspace_members: [
      {
        $id: "mem_1",
        workspace_id: "ws_1",
        user_id: "user_admin",
        email: "admin@example.com",
        status: "active",
        payload_json: JSON.stringify({ roles: ["administrator"] }),
      },
    ],
  });

  const result = await runLifecycle({ tables }, now);

  assert.equal(result.checked, 1);
  assert.equal(result.transitions, 1);
  assert.ok(result.queued > 0);

  const updatedWs = tables.collections.workspaces.find((r) => r.$id === "ws_1");
  assert.equal(updatedWs.status, "suspended");
  const wsPayload = JSON.parse(updatedWs.payload_json);
  assert.equal(wsPayload.suspensionReason, "lifecycle");
});

test("runLifecycle creates tenant deletion approval case when deletion_pending", async () => {
  process.env.KNOWHOW_PLATFORM_OWNER_EMAILS = "owner@example.com";
  const now = new Date("2025-06-01T00:00:00.000Z"); // far past retention
  const subData = {
    plan: "enterprise",
    kind: "design_partner",
    status: "active",
    startsAt: "2025-01-01T00:00:00.000Z",
    expiresAt: "2025-01-10T00:00:00.000Z",
    graceDays: 7,
    retentionDays: 90,
  };
  const tables = createMockTables({
    subscriptions: [
      {
        $id: "sub_1",
        organization_id: "org_1",
        workspace_id: "ws_1",
        kind: "design_partner",
        status: "active",
        $createdAt: "2025-01-01T00:00:00.000Z",
        payload_json: JSON.stringify(subData),
      },
    ],
    workspaces: [
      {
        $id: "ws_1",
        organization_id: "org_1",
        status: "active",
        payload_json: JSON.stringify({ name: "Test Workspace" }),
      },
    ],
    organizations: [
      {
        $id: "org_1",
        payload_json: JSON.stringify({ displayName: "Org One" }),
      },
    ],
  });

  const result = await runLifecycle({ tables }, now);

  assert.equal(result.checked, 1);

  // Check deletion case created
  const caseRow = tables.collections.lifecycle_cases.find(
    (r) => r.kind === "tenant_deletion_approval",
  );
  assert.ok(caseRow);
  assert.equal(caseRow.workspace_id, "ws_1");
  assert.equal(caseRow.status, "awaiting_approval");

  const casePayload = JSON.parse(caseRow.payload_json);
  assert.equal(casePayload.confirmationText, "DELETE Org One");
});
