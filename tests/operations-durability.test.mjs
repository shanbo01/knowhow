import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPurgePlan,
  purgeApproved,
  validPurgePlan,
} from "../functions/operations/src/main.js";

process.env.KNOWHOW_DELETION_RECEIPT_PEPPER = "p".repeat(32);

function missing(message = "Not found") {
  return Object.assign(new Error(message), { code: 404 });
}

function fakeTables(seed = {}) {
  const state = new Map(
    Object.entries(seed).map(([tableId, rows]) => [
      tableId,
      new Map(rows.map((row) => [row.$id, structuredClone(row)])),
    ]),
  );
  const table = (tableId) => {
    let rows = state.get(tableId);
    if (!rows) {
      rows = new Map();
      state.set(tableId, rows);
    }
    return rows;
  };
  return {
    state,
    insert(tableId, row) {
      table(tableId).set(row.$id, structuredClone(row));
    },
    rows(tableId) {
      return [...table(tableId).values()].map((row) => structuredClone(row));
    },
    async listRows({ tableId, queries = [] }) {
      const parsed = queries.map((query) => JSON.parse(query));
      let rows = [...table(tableId).values()];
      for (const query of parsed) {
        if (query.method === "equal") {
          const accepted = new Set(query.values);
          rows = rows.filter((row) => accepted.has(row[query.attribute]));
        } else if (query.method === "lessThanEqual") {
          rows = rows.filter(
            (row) => String(row[query.attribute]) <= String(query.values[0]),
          );
        }
      }
      const order = parsed.find((query) => query.method === "orderAsc");
      const attribute = order?.attribute || "$id";
      rows.sort((left, right) =>
        String(left[attribute]).localeCompare(String(right[attribute])),
      );
      const cursor = parsed.find((query) => query.method === "cursorAfter")
        ?.values[0];
      if (cursor) {
        const cursorIndex = rows.findIndex((row) => row.$id === cursor);
        rows = cursorIndex < 0 ? [] : rows.slice(cursorIndex + 1);
      }
      const limit =
        parsed.find((query) => query.method === "limit")?.values[0] ?? 25;
      return { rows: structuredClone(rows.slice(0, limit)) };
    },
    async getRow({ tableId, rowId }) {
      const value = table(tableId).get(rowId);
      if (!value) throw missing();
      return structuredClone(value);
    },
    async updateRow({ tableId, rowId, data }) {
      const value = table(tableId).get(rowId);
      if (!value) throw missing();
      const next = { ...value, ...structuredClone(data) };
      table(tableId).set(rowId, next);
      return structuredClone(next);
    },
    async deleteRow({ tableId, rowId }) {
      if (!table(tableId).delete(rowId)) throw missing();
      return {};
    },
  };
}

function stored(
  id,
  {
    organizationId = null,
    workspaceId = null,
    userId = null,
    status = "active",
    kind = null,
    scheduledAt = null,
    subjectId = null,
    email = null,
    createdBy = "system",
    updatedBy = null,
    data = {},
  } = {},
) {
  return {
    $id: id,
    organization_id: organizationId,
    workspace_id: workspaceId,
    user_id: userId,
    subject_id: subjectId,
    email,
    status,
    kind,
    scheduled_at: scheduledAt,
    created_by: createdBy,
    updated_by: updatedBy,
    payload_json: JSON.stringify(data),
  };
}

function deletionCase(overrides = {}) {
  return stored("case-a", {
    organizationId: "org-a",
    workspaceId: "workspace-a",
    status: "approved",
    kind: "tenant_deletion_approval",
    scheduledAt: "2026-08-11T00:00:00.000Z",
    subjectId: "subscription-a",
    updatedBy: "platform-owner",
    data: {
      kind: "tenant_deletion_approval",
      status: "approved",
      subscriptionId: "subscription-a",
      eligibleAt: "2026-08-10T00:00:00.000Z",
      createdAt: "2026-05-11T00:00:00.000Z",
      approvedAt: "2026-08-11T00:00:00.000Z",
      approvedBy: "platform-owner",
      ...overrides,
    },
  });
}

function fakeStorage(initialFiles = [], failureOnce = []) {
  const files = new Set(initialFiles);
  const failures = new Set(failureOnce);
  return {
    files,
    async deleteFile({ bucketId, fileId }) {
      const key = `${bucketId}:${fileId}`;
      if (failures.delete(key))
        throw Object.assign(new Error("temporary storage failure"), { code: 503 });
      if (!files.delete(key)) throw missing();
      return {};
    },
  };
}

function fakeUsers(initialUsers = []) {
  const userIds = new Set(initialUsers);
  return {
    userIds,
    async delete({ userId }) {
      if (!userIds.delete(userId)) throw missing();
      return {};
    },
  };
}

test("deletion purge plans freeze exact tenant row, file, and user targets", async () => {
  const tables = fakeTables({
    organizations: [stored("org-a")],
    workspaces: [stored("workspace-a", { organizationId: "org-a" })],
    lifecycle_cases: [deletionCase()],
    private_media: [
      stored("media-a", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
        data: { storageFileId: "file-a" },
      }),
      stored("media-b", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
        data: { storageFileId: "file-b" },
      }),
      stored("brand-logo", {
        organizationId: "org-a",
        data: { storageFileId: "file-logo" },
      }),
    ],
    export_jobs: [
      stored("export-a", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
        data: { outputFileId: "export-file" },
      }),
    ],
    guides: [
      stored("guide-a", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
      }),
      stored("guide-b", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
      }),
    ],
    subscriptions: [
      stored("subscription-a", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
      }),
    ],
    idempotency_keys: [
      stored("legacy-workspace-command", {
        organizationId: null,
        workspaceId: "workspace-a",
      }),
    ],
    provisioning_runs: [
      stored("workspace-run", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
      }),
      stored("organization-run", { organizationId: "org-a" }),
    ],
    organization_branding: [stored("branding", { organizationId: "org-a" })],
    organization_memberships: [
      stored("owner-a", { organizationId: "org-a", userId: "user-a" }),
      stored("owner-b", { organizationId: "org-a", userId: "user-b" }),
    ],
    initial_admin_appointments: [
      stored("appointment-a", { organizationId: "org-a" }),
    ],
    notification_deliveries: [
      stored("organization-notice", { organizationId: "org-a" }),
    ],
    entitlements: [stored("org-entitlement", { organizationId: "org-a" })],
  });

  const plan = await buildPurgePlan(
    tables,
    "workspace-a",
    "org-a",
    true,
    "2026-08-11T00:00:00.000Z",
    "case-a",
  );
  assert.equal(plan.version, 3);
  assert.match(plan.bindingHash, /^[0-9a-f]{64}$/);
  assert.equal(plan.workspaceRows, 9);
  assert.equal(plan.workspaceFiles, 3);
  assert.equal(plan.organizationDeleted, true);
  assert.equal(plan.organizationRows, 9);
  assert.equal(plan.organizationFiles, 1);
  assert.deepEqual(plan.candidateUserIds, ["user-a", "user-b"]);
  assert.deepEqual(plan.workspaceFileTargets, [
    { bucket: "exports", fileIds: ["export-file"] },
    { bucket: "private", fileIds: ["file-a", "file-b"] },
  ]);
  assert.ok(
    plan.organizationTargets.some(
      (entry) =>
        entry.tableId === "organizations" && entry.rowIds[0] === "org-a",
    ),
  );
  assert.ok(
    plan.workspaceTargets.some(
      (entry) =>
        entry.tableId === "idempotency_keys" &&
        entry.rowIds[0] === "legacy-workspace-command",
    ),
  );
  assert.equal(validPurgePlan(plan), true);
  assert.equal(validPurgePlan({ ...plan, workspaceRows: -1 }), false);
  assert.equal(
    validPurgePlan({
      ...plan,
      candidateUserIds: ["user-b", "user-a"],
    }),
    false,
  );
  assert.equal(validPurgePlan({ ...plan, version: 2 }), false);
  assert.equal(
    validPurgePlan({
      ...plan,
      organizationTargets: [plan.workspaceTargets[0], ...plan.organizationTargets]
        .sort((left, right) => left.tableId.localeCompare(right.tableId)),
      organizationRows:
        plan.organizationRows + plan.workspaceTargets[0].rowIds.length,
    }),
    false,
  );
});

test("approved purge hard-deletes tenant roots, scrubs its receipt, and removes only unreferenced users", async () => {
  const now = new Date("2026-08-11T01:00:00.000Z");
  const tables = fakeTables({
    organizations: [stored("org-a"), stored("org-b")],
    workspaces: [
      stored("workspace-a", { organizationId: "org-a" }),
      stored("workspace-b", { organizationId: "org-b" }),
    ],
    lifecycle_cases: [deletionCase()],
    subscriptions: [
      stored("subscription-a", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
      }),
    ],
    workspace_members: [
      stored("member-only", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
        userId: "user-only",
      }),
      stored("member-shared-a", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
        userId: "user-shared",
      }),
      stored("member-platform", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
        userId: "user-platform",
      }),
      stored("member-shared-b", {
        organizationId: "org-b",
        workspaceId: "workspace-b",
        userId: "user-shared",
      }),
    ],
    organization_memberships: [
      stored("org-member-only", {
        organizationId: "org-a",
        userId: "user-only",
      }),
      stored("org-member-shared-a", {
        organizationId: "org-a",
        userId: "user-shared",
      }),
      stored("org-member-platform", {
        organizationId: "org-a",
        userId: "user-platform",
      }),
      stored("org-member-shared-b", {
        organizationId: "org-b",
        userId: "user-shared",
      }),
    ],
    private_media: [
      stored("workspace-media", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
        data: { storageFileId: "media-file" },
      }),
      stored("organization-logo", {
        organizationId: "org-a",
        data: { storageFileId: "logo-file" },
      }),
    ],
    export_jobs: [
      stored("workspace-export", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
        data: { outputFileId: "export-file" },
      }),
    ],
    initial_admin_appointments: [
      stored("organization-appointment", {
        organizationId: "org-a",
        email: "synthetic@example.test",
      }),
    ],
    notification_deliveries: [
      stored("organization-notice", {
        organizationId: "org-a",
        email: "synthetic@example.test",
      }),
    ],
    platform_roles: [
      stored("platform-owner-role", {
        userId: "platform-owner",
        kind: "owner",
      }),
      stored("candidate-platform-role", {
        userId: "user-platform",
        kind: "auditor",
      }),
    ],
    user_preferences: [
      stored("preference-only", { userId: "user-only" }),
      stored("preference-shared", { userId: "user-shared" }),
      stored("preference-platform", { userId: "user-platform" }),
    ],
  });
  const storage = fakeStorage(
    [
      "knowhow_private_media:media-file",
      "knowhow_private_media:logo-file",
      "knowhow_exports:export-file",
    ],
    ["knowhow_private_media:media-file"],
  );
  const users = fakeUsers([
    "platform-owner",
    "user-only",
    "user-shared",
    "user-platform",
  ]);

  assert.deepEqual(await purgeApproved({ tables, storage, users }, now), []);
  assert.ok(tables.rows("workspaces").some((row) => row.$id === "workspace-a"));
  const retryCase = tables.rows("lifecycle_cases")[0];
  assert.equal(retryCase.status, "approved");
  assert.equal(validPurgePlan(JSON.parse(retryCase.payload_json).purgePlan), true);

  const receipts = await purgeApproved(
    { tables, storage, users },
    new Date("2026-08-11T03:00:00.000Z"),
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].organizationDeleted, true);
  assert.equal(receipts[0].authUsersRemoved, 1);
  assert.equal(receipts[0].authUsersPreserved, 2);
  assert.equal(receipts[0].userPreferenceRowsDeleted, 1);

  assert.equal(tables.rows("organizations").some((row) => row.$id === "org-a"), false);
  assert.equal(tables.rows("workspaces").some((row) => row.$id === "workspace-a"), false);
  assert.equal(tables.rows("subscriptions").length, 0);
  for (const rows of tables.state.values()) {
    for (const row of rows.values()) {
      assert.notEqual(row.organization_id, "org-a");
      assert.notEqual(row.workspace_id, "workspace-a");
    }
  }
  const receiptRow = tables.rows("lifecycle_cases")[0];
  assert.equal(receiptRow.organization_id, null);
  assert.equal(receiptRow.workspace_id, null);
  assert.equal(receiptRow.subject_id, null);
  assert.equal(receiptRow.email, null);
  assert.equal(receiptRow.scheduled_at, null);
  const receiptPayload = JSON.parse(receiptRow.payload_json);
  assert.equal(receiptPayload.status, "completed");
  assert.equal("purgePlan" in receiptPayload, false);
  const serializedReceipt = JSON.stringify(receiptPayload);
  for (const forbidden of [
    "org-a",
    "workspace-a",
    "platform-owner",
    "user-only",
    "user-shared",
    "synthetic@example.test",
  ]) {
    assert.equal(serializedReceipt.includes(forbidden), false);
  }
  assert.deepEqual([...storage.files], []);
  assert.equal(users.userIds.has("user-only"), false);
  assert.equal(users.userIds.has("user-shared"), true);
  assert.equal(users.userIds.has("user-platform"), true);
  assert.equal(users.userIds.has("platform-owner"), true);
  assert.deepEqual(
    tables.rows("user_preferences").map((row) => row.user_id).sort(),
    ["user-platform", "user-shared"],
  );
});

test("frozen purge plans reject newly introduced tenant targets before deletion", async () => {
  const tables = fakeTables({
    organizations: [stored("org-a")],
    workspaces: [stored("workspace-a", { organizationId: "org-a" })],
    lifecycle_cases: [deletionCase()],
    subscriptions: [
      stored("subscription-a", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
      }),
    ],
  });
  const plan = await buildPurgePlan(
    tables,
    "workspace-a",
    "org-a",
    true,
    "2026-08-11T00:00:00.000Z",
    "case-a",
  );
  const caseRow = tables.rows("lifecycle_cases")[0];
  tables.insert("lifecycle_cases", {
    ...caseRow,
    status: "purging",
    payload_json: JSON.stringify({
      ...JSON.parse(caseRow.payload_json),
      status: "purging",
      purgePlan: plan,
    }),
  });
  tables.insert(
    "guides",
    stored("late-guide", {
      organizationId: "org-a",
      workspaceId: "workspace-a",
    }),
  );

  await assert.rejects(
    purgeApproved(
      { tables, storage: fakeStorage(), users: fakeUsers() },
      new Date("2026-08-11T01:00:00.000Z"),
    ),
    /PURGE_SCOPE_CHANGED:workspace/,
  );
  assert.ok(tables.rows("workspaces").some((row) => row.$id === "workspace-a"));
  assert.ok(tables.rows("guides").some((row) => row.$id === "late-guide"));
});

test("final-organization purge rejects a newly introduced workspace before deletion", async () => {
  const tables = fakeTables({
    organizations: [stored("org-a")],
    workspaces: [stored("workspace-a", { organizationId: "org-a" })],
    lifecycle_cases: [deletionCase()],
    subscriptions: [
      stored("subscription-a", {
        organizationId: "org-a",
        workspaceId: "workspace-a",
      }),
    ],
  });
  const plan = await buildPurgePlan(
    tables,
    "workspace-a",
    "org-a",
    true,
    "2026-08-11T00:00:00.000Z",
    "case-a",
  );
  const caseRow = tables.rows("lifecycle_cases")[0];
  tables.insert("lifecycle_cases", {
    ...caseRow,
    status: "purging",
    payload_json: JSON.stringify({
      ...JSON.parse(caseRow.payload_json),
      status: "purging",
      purgePlan: plan,
    }),
  });
  tables.insert(
    "workspaces",
    stored("late-workspace", { organizationId: "org-a" }),
  );

  await assert.rejects(
    purgeApproved(
      { tables, storage: fakeStorage(), users: fakeUsers() },
      new Date("2026-08-11T01:00:00.000Z"),
    ),
    /PURGE_SCOPE_CHANGED:organization/,
  );
  assert.ok(tables.rows("workspaces").some((row) => row.$id === "workspace-a"));
  assert.ok(tables.rows("subscriptions").some((row) => row.$id === "subscription-a"));
});

test("stored purge plans are HMAC-bound to their exact case and targets", async () => {
  const tables = fakeTables({
    organizations: [stored("org-a"), stored("org-b")],
    workspaces: [
      stored("workspace-a", { organizationId: "org-a" }),
      stored("workspace-b", { organizationId: "org-b" }),
    ],
    lifecycle_cases: [deletionCase()],
    guides: [
      stored("foreign-guide", {
        organizationId: "org-b",
        workspaceId: "workspace-b",
      }),
    ],
  });
  const plan = await buildPurgePlan(
    tables,
    "workspace-a",
    "org-a",
    true,
    "2026-08-11T00:00:00.000Z",
    "case-a",
  );
  const guideTargets = plan.workspaceTargets.find(
    (entry) => entry.tableId === "guides",
  );
  if (guideTargets) guideTargets.rowIds.push("foreign-guide");
  else
    plan.workspaceTargets.push({
      tableId: "guides",
      rowIds: ["foreign-guide"],
    });
  plan.workspaceTargets.sort((left, right) =>
    left.tableId.localeCompare(right.tableId),
  );
  plan.workspaceRows += 1;
  assert.equal(validPurgePlan(plan), true);
  const caseRow = tables.rows("lifecycle_cases")[0];
  tables.insert("lifecycle_cases", {
    ...caseRow,
    status: "purging",
    payload_json: JSON.stringify({
      ...JSON.parse(caseRow.payload_json),
      status: "purging",
      purgePlan: plan,
    }),
  });

  await assert.rejects(
    purgeApproved(
      { tables, storage: fakeStorage(), users: fakeUsers() },
      new Date("2026-08-11T01:00:00.000Z"),
    ),
    /PURGE_PLAN_BINDING_INVALID:case-a/,
  );
  assert.ok(tables.rows("workspaces").some((row) => row.$id === "workspace-a"));
  assert.ok(tables.rows("guides").some((row) => row.$id === "foreign-guide"));
});

test("a purging case never rebuilds a missing frozen plan", async () => {
  const caseRow = deletionCase();
  const tables = fakeTables({
    organizations: [stored("org-a")],
    workspaces: [stored("workspace-a", { organizationId: "org-a" })],
    lifecycle_cases: [
      {
        ...caseRow,
        status: "purging",
        payload_json: JSON.stringify({
          ...JSON.parse(caseRow.payload_json),
          status: "purging",
        }),
      },
    ],
  });

  await assert.rejects(
    purgeApproved(
      { tables, storage: fakeStorage(), users: fakeUsers() },
      new Date("2026-08-11T01:00:00.000Z"),
    ),
    /PURGE_PLAN_REQUIRED:case-a/,
  );
  assert.ok(tables.rows("workspaces").some((row) => row.$id === "workspace-a"));
});

test("workspace purge refuses a row whose organization scope is inconsistent", async () => {
  const tables = fakeTables({
    organizations: [stored("org-a")],
    workspaces: [stored("workspace-a", { organizationId: "org-a" })],
    lifecycle_cases: [deletionCase()],
    guides: [
      stored("corrupt-guide", {
        organizationId: "org-b",
        workspaceId: "workspace-a",
      }),
    ],
  });
  await assert.rejects(
    buildPurgePlan(
      tables,
      "workspace-a",
      "org-a",
      true,
      "2026-08-11T00:00:00.000Z",
      "case-a",
    ),
    /PURGE_SCOPE_MISMATCH:guides:workspace-a:corrupt-guide/,
  );
});
