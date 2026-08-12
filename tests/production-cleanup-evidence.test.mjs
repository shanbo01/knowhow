import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  assertCleanupUserReceipts,
  assertRowsAreClean,
  canonicalJson,
  controlledProductionEndpoint,
  validateCleanupReceipt,
  validateCleanupEvidenceBindings,
  validateCleanupTargets,
  validateRehearsalUserIds,
  verifyCleanupEvidenceSeal,
  verifyProductionCleanup,
} from "../scripts/appwrite-production-cleanup-evidence.mjs";

const pepper = "r".repeat(32);
const evidenceKey = "e".repeat(32);

function hmac(value) {
  return createHmac("sha256", pepper).update(value).digest("hex");
}

function receiptRow(overrides = {}, payloadOverrides = {}) {
  const receipt = {
    version: 2,
    deletedRows: 12,
    deletedFiles: 2,
    failedFiles: 0,
    organizationHash: hmac("organization\0org-a"),
    workspaceHash: hmac("workspace\0workspace-a"),
    organizationDeleted: true,
    organizationRowsDeleted: 4,
    organizationFilesDeleted: 1,
    authUsersRemoved: 2,
    authUsersPreserved: 0,
    userPreferenceRowsDeleted: 2,
    ...(payloadOverrides.receipt ?? {}),
  };
  return {
    $id: "case-a",
    organization_id: null,
    workspace_id: null,
    user_id: null,
    subject_id: null,
    slug: null,
    email: null,
    kind: "tenant_deletion_approval",
    status: "completed",
    occurred_at: "2026-08-11T01:00:00.000Z",
    idempotency_key: null,
    request_id: null,
    expires_at: null,
    scheduled_at: null,
    deleted_at: null,
    created_by: "knowhow_ops",
    updated_by: "knowhow_ops",
    payload_json: JSON.stringify({
      kind: "tenant_deletion_approval",
      status: "completed",
      eligibleAt: "2026-08-10T00:00:00.000Z",
      createdAt: "2026-05-11T00:00:00.000Z",
      approvedAt: "2026-08-11T00:00:00.000Z",
      approvedByHash: "a".repeat(64),
      completedAt: "2026-08-11T01:00:00.000Z",
      receipt,
      ...Object.fromEntries(
        Object.entries(payloadOverrides).filter(([key]) => key !== "receipt"),
      ),
    }),
    ...overrides,
  };
}

const target = {
  caseId: "case-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
  organizationDeleted: true,
};

function notFound() {
  return Object.assign(new Error("not found"), { code: 404 });
}

function fakeServices(row = receiptRow()) {
  const rows = {
    organizations: [],
    workspaces: [],
    lifecycle_cases: [row],
    platform_roles: [
      {
        $id: "platform-role",
        organization_id: null,
        workspace_id: null,
        user_id: "platform-owner",
        payload_json: JSON.stringify({ roles: ["owner"] }),
      },
    ],
  };
  return {
    endpoint: "https://fra.cloud.appwrite.io/v1",
    projectId: "production-project",
    databaseId: "knowhow_core",
    tables: {
      async getRow({ tableId, rowId }) {
        const match = (rows[tableId] ?? []).find((item) => item.$id === rowId);
        if (!match) throw notFound();
        return structuredClone(match);
      },
      async listRows({ tableId }) {
        return { rows: structuredClone(rows[tableId] ?? []) };
      },
    },
    storage: {
      async listFiles() {
        return { files: [] };
      },
    },
    users: {
      async get() {
        throw notFound();
      },
    },
  };
}

test("cleanup target and user manifests are exact and final-organization bound", () => {
  assert.deepEqual(validateCleanupTargets([target]), [target]);
  assert.deepEqual(
    validateRehearsalUserIds(["synthetic-b", "synthetic-a"]),
    ["synthetic-a", "synthetic-b"],
  );
  assert.throws(
    () => validateCleanupTargets([{ ...target, organizationDeleted: false }]),
    /exactly one receipt/,
  );
  assert.throws(
    () =>
      validateCleanupTargets([
        target,
        {
          caseId: "case-b",
          organizationId: "org-a",
          workspaceId: "workspace-b",
          organizationDeleted: true,
        },
      ]),
    /exactly one receipt/,
  );
  assert.throws(
    () => validateRehearsalUserIds(["synthetic-a"]),
    /exactly the two synthetic rehearsal user IDs/,
  );
});

test("cleanup user accounting permits only pre-final preservation", () => {
  assert.doesNotThrow(() =>
    assertCleanupUserReceipts(
      [
        {
          organizationDeleted: false,
          authUsersRemoved: 0,
          authUsersPreserved: 2,
        },
        {
          organizationDeleted: true,
          authUsersRemoved: 2,
          authUsersPreserved: 0,
        },
      ],
      ["synthetic-a", "synthetic-b"],
    ),
  );
  assert.throws(
    () =>
      assertCleanupUserReceipts(
        [
          {
            organizationDeleted: true,
            authUsersRemoved: 3,
            authUsersPreserved: 0,
          },
        ],
        ["synthetic-a", "synthetic-b"],
      ),
    /exact automatic removal/,
  );
  assert.throws(
    () =>
      assertCleanupUserReceipts(
        [
          {
            organizationDeleted: true,
            authUsersRemoved: 2,
            authUsersPreserved: 1,
          },
        ],
        ["synthetic-a", "synthetic-b"],
      ),
    /exact automatic removal/,
  );
});

test("cleanup receipts bind hashes and retain only the content-free contract", () => {
  const summary = validateCleanupReceipt(receiptRow(), target, pepper);
  assert.equal(summary.organizationDeleted, true);
  assert.equal(summary.authUsersRemoved, 2);
  assert.equal(summary.authUsersPreserved, 0);
  assert.throws(
    () =>
      validateCleanupReceipt(
        receiptRow({ organization_id: "org-a" }),
        target,
        pepper,
      ),
    /raw scalar identifier/,
  );
  assert.throws(
    () =>
      validateCleanupReceipt(
        receiptRow({}, { purgePlan: { version: 2 } }),
        target,
        pepper,
      ),
    /outside the content-free contract/,
  );
  assert.throws(
    () =>
      validateCleanupReceipt(
        receiptRow({}, { receipt: { workspaceHash: "b".repeat(64) } }),
        target,
        pepper,
      ),
    /does not bind to its approved tenant target/,
  );
  assert.throws(
    () =>
      validateCleanupReceipt(
        receiptRow({}, { receipt: { deletedRows: 0 } }),
        target,
        pepper,
      ),
    /required root deletion scope/,
  );
  assert.throws(
    () =>
      validateCleanupReceipt(
        receiptRow({}, { completedAt: "2026-05-01T00:00:00.000Z" }),
        target,
        pepper,
      ),
    /outside the content-free contract/,
  );
});

test("clean-row verification rejects root tombstones, scoped rows, and payload-only identifiers", () => {
  const identifiers = new Set(["org-a", "workspace-a", "synthetic-a"]);
  assert.throws(
    () =>
      assertRowsAreClean(
        "organizations",
        [
          {
            $id: "org-a",
            organization_id: null,
            workspace_id: null,
            payload_json: "{}",
          },
        ],
        identifiers,
      ),
    /organization or workspace root row/,
  );
  assert.throws(
    () =>
      assertRowsAreClean(
        "guides",
        [
          {
            $id: "guide-a",
            organization_id: "org-a",
            workspace_id: "workspace-a",
            payload_json: "{}",
          },
        ],
        identifiers,
      ),
    /customer-scoped guides row/,
  );
  assert.throws(
    () =>
      assertRowsAreClean(
        "audit_segments",
        [
          {
            $id: "audit-a",
            organization_id: null,
            workspace_id: null,
            payload_json: JSON.stringify({ actor: "synthetic-a" }),
          },
        ],
        identifiers,
      ),
    /rehearsal identifier in audit_segments/,
  );
  for (const payload of [
    { idempotency: "publish:synthetic-a:1" },
    { "synthetic-a": true },
  ]) {
    assert.throws(
      () =>
        assertRowsAreClean(
          "idempotency_keys",
          [
            {
              $id: "global-row",
              organization_id: null,
              workspace_id: null,
              payload_json: JSON.stringify(payload),
            },
          ],
          identifiers,
        ),
      /rehearsal identifier in idempotency_keys/,
    );
  }
});

test("the full verifier returns content-free evidence for an empty Production customer state", async () => {
  const result = await verifyProductionCleanup({
    services: fakeServices(),
    tables: [
      { $id: "organizations" },
      { $id: "workspaces" },
      { $id: "lifecycle_cases" },
      { $id: "platform_roles" },
    ],
    targets: [target],
    rehearsalUserIds: ["synthetic-a", "synthetic-b"],
    receiptPepper: pepper,
    evidenceHmacKey: evidenceKey,
    privateBucketId: "knowhow_private_media",
    exportsBucketId: "knowhow_exports",
  });
  assert.equal(result.scopedRows, 0);
  assert.equal(result.rehearsalUsersPresent, 0);
  assert.equal(result.receipts.length, 1);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "case-a",
    "org-a",
    "workspace-a",
    "synthetic-a",
    "synthetic-b",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("cleanup verification accepts only an exact approved controlled API endpoint", () => {
  assert.equal(
    controlledProductionEndpoint("https://fra.cloud.appwrite.io/v1"),
    "https://fra.cloud.appwrite.io/v1",
  );
  for (const endpoint of [
    "https://cloud.appwrite.io/v1",
    "https://fra.cloud.appwrite.io:443/v1",
    "https://fra.cloud.appwrite.io/v1?target=production",
    "http://fra.cloud.appwrite.io/v1",
  ]) {
    assert.throws(
      () => controlledProductionEndpoint(endpoint),
      /approved Frankfurt Cloud or Azure Qatar Central endpoint/,
    );
  }
});

test("cleanup evidence binds distinct reviewed projects and an exact release", () => {
  const release = "a".repeat(40);
  assert.deepEqual(
    validateCleanupEvidenceBindings({
      KNOWHOW_CLEANUP_EXPECTED_PROJECT_ID: "project_production",
      KNOWHOW_CLEANUP_FORBIDDEN_PROJECT_ID: "project_staging",
      KNOWHOW_CLEANUP_EXPECTED_RELEASE: release,
    }),
    {
      expectedProjectId: "project_production",
      forbiddenProjectId: "project_staging",
      expectedRelease: release,
    },
  );
  assert.throws(
    () =>
      validateCleanupEvidenceBindings({
        KNOWHOW_CLEANUP_EXPECTED_PROJECT_ID: "project_shared",
        KNOWHOW_CLEANUP_FORBIDDEN_PROJECT_ID: "project_shared",
        KNOWHOW_CLEANUP_EXPECTED_RELEASE: release,
      }),
    /distinct reviewed Production and forbidden Staging/,
  );
  assert.throws(
    () =>
      validateCleanupEvidenceBindings({
        KNOWHOW_CLEANUP_EXPECTED_PROJECT_ID: "project_production",
        KNOWHOW_CLEANUP_FORBIDDEN_PROJECT_ID: "project_staging",
        KNOWHOW_CLEANUP_EXPECTED_RELEASE: "release-a",
      }),
    /40-character release SHA/,
  );
});

test("saved cleanup evidence rejects tampering and another key ID", () => {
  const payload = {
    evidenceVersion: 1,
    kind: "knowhow-production-cleanup-evidence",
    checkedAt: "2026-08-11T01:00:00.000Z",
    release: "a".repeat(40),
    environment: "production",
    source: {
      endpointOrigin: "https://fra.cloud.appwrite.io",
      projectFingerprint: "f".repeat(64),
      databaseId: "knowhow_core",
    },
    cleanup: {
      tableCount: 40,
      totalRowsScanned: 1,
      scopedRows: 0,
      rehearsalUsersPresent: 0,
      privateFiles: 0,
      exportFiles: 0,
      receipts: [
        {
          caseFingerprint: "c".repeat(64),
          workspaceHash: "d".repeat(64),
          organizationHash: "e".repeat(64),
          organizationDeleted: true,
          deletedRows: 12,
          deletedFiles: 2,
          authUsersRemoved: 2,
          authUsersPreserved: 0,
          completedAt: "2026-08-11T00:59:00.000Z",
        },
      ],
      rehearsalUserFingerprints: ["1".repeat(64), "2".repeat(64)],
    },
    attestations: {
      finalProductionProject: true,
      syntheticDataOnly: true,
      readOnlyVerification: true,
    },
  };
  const sealed = {
    ...payload,
    seal: {
      algorithm: "HMAC-SHA-256",
      keyId: "v1",
      hmac: createHmac("sha256", evidenceKey)
        .update(canonicalJson(payload))
        .digest("hex"),
    },
  };
  assert.deepEqual(
    verifyCleanupEvidenceSeal(sealed, evidenceKey, "v1"),
    payload,
  );
  assert.throws(
    () =>
      verifyCleanupEvidenceSeal(
        { ...sealed, cleanup: { ...sealed.cleanup, scopedRows: 1 } },
        evidenceKey,
        "v1",
      ),
    /seal does not match/,
  );
  assert.throws(
    () => verifyCleanupEvidenceSeal(sealed, evidenceKey, "v2"),
    /another key ID/,
  );
  const unexpectedPayload = { ...payload, rawIdentifier: "must-not-pass" };
  const unexpected = {
    ...unexpectedPayload,
    seal: {
      algorithm: "HMAC-SHA-256",
      keyId: "v1",
      hmac: createHmac("sha256", evidenceKey)
        .update(canonicalJson(unexpectedPayload))
        .digest("hex"),
    },
  };
  assert.throws(
    () => verifyCleanupEvidenceSeal(unexpected, evidenceKey, "v1"),
    /not a passing KnowHow Production cleanup report/,
  );
});
