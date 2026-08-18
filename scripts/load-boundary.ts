import assert from "node:assert/strict";
import type { Audience, EditorBlock } from "../lib/knowhow-types";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  rowData,
  type GuideRecord,
  type OrganizationRecord,
  type RevisionRecord,
  type SubscriptionRecord,
  type WorkspaceRecord,
} from "../lib/server/domain-records";
import {
  CAPTURE_POLICY_VERSION,
  ExtensionCaptureService,
} from "../lib/server/extension-capture-service";
import type { ExtensionDeviceDetails } from "../lib/server/extension-auth-service";
import { searchAuthorizedGuides } from "../lib/server/guide-search-service";
import { TABLES } from "../lib/server/appwrite-resources";
import { InMemoryPrivateObjectStore } from "../lib/server/private-object-store";
import { InMemoryRecordStore } from "../lib/server/record-store";
import { signDeviceToken } from "../lib/server/tokens";

process.env.KNOWHOW_TOKEN_KEYS_JSON = JSON.stringify({
  load: "local-load-test-signing-secret-with-more-than-thirty-two-bytes",
});
process.env.KNOWHOW_TOKEN_ACTIVE_KID = "load";
process.env.KNOWHOW_EXTENSION_MIN_VERSION = "0.1.0";

const TENANTS = Number(process.env.KNOWHOW_LOAD_TENANTS ?? 4);
const USERS_PER_TENANT = Number(process.env.KNOWHOW_LOAD_USERS_PER_TENANT ?? 120);
const GUIDES_PER_TENANT = Number(process.env.KNOWHOW_LOAD_GUIDES_PER_TENANT ?? 40);
const CAPTURES_PER_TENANT = Number(process.env.KNOWHOW_LOAD_CAPTURES_PER_TENANT ?? 12);
const READER_P95_BUDGET_MS = Number(process.env.KNOWHOW_LOAD_READER_P95_MS ?? 1_000);
const CAPTURE_P95_BUDGET_MS = Number(process.env.KNOWHOW_LOAD_CAPTURE_P95_MS ?? 3_000);

for (const [label, value, minimum] of [
  ["tenants", TENANTS, 4],
  ["users per tenant", USERS_PER_TENANT, 101],
  ["guides per tenant", GUIDES_PER_TENANT, 1],
  ["captures per tenant", CAPTURES_PER_TENANT, 1],
] as const) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}.`);
  }
}

const store = new InMemoryRecordStore();
const objects = new InMemoryPrivateObjectStore();
const onePixelPng = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const createdAt = "2026-08-01T00:00:00.000Z";

function percentile(samples: number[], fraction: number) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

async function timed<T>(work: () => Promise<T>) {
  const started = performance.now();
  const value = await work();
  return { value, elapsedMs: performance.now() - started };
}

async function seedTenant(index: number) {
  const organizationId = `load_org_${index}`;
  const workspaceId = `load_workspace_${index}`;
  const organization: OrganizationRecord = {
    legalName: `Load Organization ${index}`,
    displayName: `Load ${index}`,
    primaryContactName: "Synthetic owner",
    primaryContactEmail: `owner-${index}@example.test`,
    country: "QA",
    status: "active",
    createdAt,
  };
  const workspace: WorkspaceRecord = {
    organizationId,
    name: `Synthetic workspace ${index}`,
    slug: workspaceId,
    status: "active",
    createdAt,
    auditSequence: 0,
    auditHash: "0".repeat(64),
    suspensionReason: null,
  };
  const subscription: SubscriptionRecord = {
    kind: "paid",
    startsAt: createdAt,
    expiresAt: null,
    graceDays: 7,
    retentionDays: 90,
    publicTrial: false,
    manualContract: true,
    status: "active",
  };
  await store.create(
    TABLES.organizations,
    organizationId,
    rowData({ slug: organizationId, status: "active", created_by: "load" }, organization),
  );
  await store.create(
    TABLES.workspaces,
    workspaceId,
    rowData(
      { organization_id: organizationId, slug: workspaceId, status: "active", created_by: "load" },
      workspace,
    ),
  );
  await store.create(
    TABLES.workspaceSettings,
    `load_settings_${index}`,
    rowData(
      { organization_id: organizationId, workspace_id: workspaceId, status: "active", created_by: "load" },
      DEFAULT_WORKSPACE_SETTINGS,
    ),
  );
  await store.create(
    TABLES.subscriptions,
    `load_subscription_${index}`,
    rowData(
      { organization_id: organizationId, workspace_id: workspaceId, status: "active", kind: "paid", created_by: "load" },
      subscription,
    ),
  );
  for (const [kind, value] of [
    ["maximumUsers", USERS_PER_TENANT + 20],
    ["maximumCreators", 10],
    ["storageBytes", 5_000_000_000],
    ["extensionEnabled", true],
  ] as const) {
    await store.create(
      TABLES.entitlements,
      `load_entitlement_${index}_${kind}`,
      rowData(
        { organization_id: organizationId, workspace_id: workspaceId, kind, status: "active" },
        { value },
      ),
    );
  }

  const identities = [];
  for (let userIndex = 0; userIndex < USERS_PER_TENANT; userIndex += 1) {
    const userId = `load_t${index}_user_${userIndex}`;
    const identity = {
      userId,
      email: `${userId}@example.test`,
      name: `Synthetic user ${userIndex}`,
      emailVerified: true,
      mfaEnabled: userIndex === 0,
    };
    identities.push(identity);
    await store.create(
      TABLES.workspaceMembers,
      `load_member_${index}_${userIndex}`,
      rowData(
        {
          organization_id: organizationId,
          workspace_id: workspaceId,
          user_id: userId,
          email: identity.email,
          status: "active",
          created_by: "load",
        },
        {
          name: identity.name,
          roles: userIndex === 0 ? ["creator"] : ["viewer"],
          capabilities: [],
          groupIds: [],
        },
      ),
    );
  }

  for (let guideIndex = 0; guideIndex < GUIDES_PER_TENANT; guideIndex += 1) {
    const guideId = `load_t${index}_guide_${guideIndex}`;
    const revisionId = `load_t${index}_revision_${guideIndex}`;
    const guide: GuideRecord = {
      title: `Approved recovery procedure ${guideIndex}`,
      slug: guideId,
      authorUserId: identities[0].userId,
      publishedRevisionId: revisionId,
      workingRevisionId: null,
      screenshotsLockedAt: null,
      archivedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    const revision: RevisionRecord = {
      guideId,
      number: 1,
      status: "published",
      title: guide.title,
      summary: "Approved recovery workflow for a synthetic pilot tenant.",
      category: "Internal IT",
      tags: ["recovery", "approved"],
      systemReferences: [],
      authorId: identities[0].userId,
      createdAt,
      updatedAt: createdAt,
      submittedBy: identities[0].userId,
      submittedAt: createdAt,
      reviewedBy: identities[0].userId,
      reviewedAt: createdAt,
      publishedBy: identities[0].userId,
      publishedAt: createdAt,
      source: "manual",
    };
    const step: EditorBlock = {
      id: `load_t${index}_step_${guideIndex}`,
      kind: "action",
      title: "Open the approved recovery console",
      description: "Use the synthetic environment only.",
    };
    const audience: Audience = { kind: "workspace" };
    await store.create(
      TABLES.guides,
      guideId,
      rowData(
        { organization_id: organizationId, workspace_id: workspaceId, slug: guideId, status: "published", created_by: identities[0].userId },
        guide,
      ),
    );
    await store.create(
      TABLES.guideRevisions,
      revisionId,
      rowData(
        { organization_id: organizationId, workspace_id: workspaceId, subject_id: guideId, status: "published", version: 1, created_by: identities[0].userId },
        revision,
      ),
    );
    await store.create(
      TABLES.guideSteps,
      step.id,
      rowData(
        { organization_id: organizationId, workspace_id: workspaceId, subject_id: revisionId, status: "published", sequence: 0, kind: "action" },
        step,
      ),
    );
    await store.create(
      TABLES.guideAudiences,
      `load_t${index}_audience_${guideIndex}`,
      rowData(
        { organization_id: organizationId, workspace_id: workspaceId, subject_id: revisionId, kind: "workspace", status: "active" },
        audience,
      ),
    );
  }

  const deviceId = `load-device-${index}`;
  const deviceRecordId = `load_device_record_${index}`;
  const deviceDetails: ExtensionDeviceDetails = {
    email: identities[0].email,
    displayName: identities[0].name,
    deviceId,
    extensionVersion: "0.1.0",
    minimumVersion: "0.1.0",
    scopes: ["capture:write", "media:write"],
    createdAt,
    pairedAt: createdAt,
    lastUsedAt: new Date().toISOString(),
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    refreshRotation: 1,
  };
  await store.create(
    TABLES.extensionDevices,
    deviceRecordId,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        user_id: identities[0].userId,
        subject_id: `load_refresh_${index}`,
        status: "active",
        kind: "browser-extension",
        expires_at: deviceDetails.refreshExpiresAt!,
      },
      deviceDetails,
    ),
  );
  const accessToken = await signDeviceToken({
    jti: deviceRecordId,
    workspaceId,
    userId: identities[0].userId,
    deviceId,
    scopes: ["capture:write", "media:write"],
    expiresAt: Math.floor(Date.now() / 1_000) + 300,
  });
  return { index, organizationId, workspaceId, identities, accessToken };
}

const tenants = [];
for (let index = 0; index < TENANTS; index += 1) tenants.push(await seedTenant(index));

const readerRuns = await Promise.all(
  tenants.flatMap((tenant) =>
    tenant.identities.map((identity) =>
      timed(async () => {
        const results = await searchAuthorizedGuides(
          store,
          identity,
          tenant.workspaceId,
          "approved recovery",
        );
        assert.equal(results.length, Math.min(GUIDES_PER_TENANT, 50));
        assert.ok(
          results.every((result) => result.guideId.startsWith(`load_t${tenant.index}_guide_`)),
          `Cross-tenant result detected for ${tenant.workspaceId}`,
        );
      }),
    ),
  ),
);

const captureService = new ExtensionCaptureService(store, objects);
const captureRuns = await Promise.all(
  tenants.flatMap((tenant) =>
    Array.from({ length: CAPTURES_PER_TENANT }, (_, captureIndex) =>
      timed(async () => {
        const sessionId = `session_t${tenant.index}_${String(captureIndex).padStart(3, "0")}`;
        const stepId = `step_t${tenant.index}_${String(captureIndex).padStart(3, "0")}`;
        const authHeaders = { authorization: `Bearer ${tenant.accessToken}` };
        const started = await captureService.start(
          new Request("https://load.example/api/extension/captures", {
            method: "POST",
            headers: {
              ...authHeaders,
              "content-type": "application/json",
              "idempotency-key": sessionId,
            },
            body: JSON.stringify({
              sessionId,
              workspaceId: tenant.workspaceId,
              title: `Synthetic capture ${tenant.index}-${captureIndex}`,
              stepCount: 1,
              policyVersion: CAPTURE_POLICY_VERSION,
              sanitizedUrl: "https://synthetic.example/path?discarded=true",
            }),
          }),
        );
        await captureService.upload(
          new Request("https://load.example/api/extension/captures/upload", {
            method: "POST",
            headers: {
              ...authHeaders,
              "content-type": "image/png",
              "content-length": String(onePixelPng.byteLength),
              "idempotency-key": `${sessionId}:${stepId}`,
              "x-knowhow-source-rasterized": "true",
              "x-knowhow-redacted": "true",
              "x-knowhow-image-width": "1",
              "x-knowhow-image-height": "1",
            },
            body: onePixelPng,
          }),
          started.captureId,
          stepId,
        );
        const committed = await captureService.commit(
          new Request("https://load.example/api/extension/captures/commit", {
            method: "POST",
            headers: { ...authHeaders, "content-type": "application/json" },
            body: JSON.stringify({
              steps: [
                {
                  id: stepId,
                  order: 0,
                  title: "Approve the synthetic request",
                  instructions: "Use only ordinary synthetic business data.",
                },
              ],
              privacyReview: {
                policyVersion: CAPTURE_POLICY_VERSION,
                completedAt: new Date().toISOString(),
                automaticMaskCount: 1,
                manualMaskCount: 0,
              },
            }),
          }),
          started.captureId,
        );
        assert.ok(committed.editUrl.includes(tenant.workspaceId));
      }),
    ),
  ),
);

const readerSamples = readerRuns.map((result) => result.elapsedMs);
const captureSamples = captureRuns.map((result) => result.elapsedMs);
const readerP95 = percentile(readerSamples, 0.95);
const captureP95 = percentile(captureSamples, 0.95);
assert.ok(
  readerP95 <= READER_P95_BUDGET_MS,
  `Reader p95 ${readerP95.toFixed(1)}ms exceeds ${READER_P95_BUDGET_MS}ms`,
);
assert.ok(
  captureP95 <= CAPTURE_P95_BUDGET_MS,
  `Capture p95 ${captureP95.toFixed(1)}ms exceeds ${CAPTURE_P95_BUDGET_MS}ms`,
);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "passed",
      boundary: {
        tenants: TENANTS,
        usersPerTenant: USERS_PER_TENANT,
        totalUsers: TENANTS * USERS_PER_TENANT,
        guidesPerTenant: GUIDES_PER_TENANT,
        concurrentReaderOperations: readerSamples.length,
        concurrentCapturePipelines: captureSamples.length,
      },
      p95Ms: {
        authorizedSearch: Number(readerP95.toFixed(1)),
        redactedCapturePipeline: Number(captureP95.toFixed(1)),
      },
      budgetsMs: {
        authorizedSearch: READER_P95_BUDGET_MS,
        redactedCapturePipeline: CAPTURE_P95_BUDGET_MS,
      },
      assertions: [
        "no cross-tenant search result",
        "all redacted capture pipelines committed without timeout",
        "all measured p95 values remained within the local service budget",
      ],
      limitation:
        "This deterministic in-memory service test is not a substitute for the credentialed Staging network/load rehearsal.",
    },
    null,
    2,
  )}\n`,
);
