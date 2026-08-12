import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  contentFreeActor,
  controlledNetworkLoadConfiguration,
  latencySummary,
  privateEvidencePath,
  projectFingerprint,
  requestIdDigest,
  sealNetworkLoadEvidence,
  verifyNetworkLoadEvidence,
} from "../scripts/controlled-network-load-guards.mjs";

const release = "a".repeat(40);
const evidenceKey = "controlled-load-test-key-with-at-least-thirty-two-bytes";
const extensionOrigin = "chrome-extension://phbofjenfnnnnndghhinoldlfbpaedpo";

function actor(index) {
  return {
    label: `tenant_${index}`,
    email: `load-${index}@synthetic.knowhow.example`,
    password: `Synthetic-Password-${index}-Aa1!`,
    totpSecret: "JBSWY3DPEHPK3PXP",
    workspaceId: `load_workspace_${index}`,
    expectedGuideId: `load_guide_${index}`,
    searchQuery: "network sentinel",
  };
}

function stagingEnvironment() {
  return {
    APPWRITE_ENDPOINT: "https://fra.cloud.appwrite.io/v1",
    KNOWHOW_NETWORK_LOAD_ENVIRONMENT: "staging",
    KNOWHOW_NETWORK_LOAD_SITE_ORIGIN: "https://staging.knowhow.example",
    KNOWHOW_NETWORK_LOAD_EXPECTED_PROJECT_ID: "staging_project",
    KNOWHOW_NETWORK_LOAD_FORBIDDEN_PROJECT_ID: "production_project",
    KNOWHOW_NETWORK_LOAD_EXPECTED_RELEASE: release,
    KNOWHOW_NETWORK_LOAD_CONFIRM: "staging-synthetic-network-load",
    KNOWHOW_NETWORK_LOAD_SYNTHETIC_ONLY: "1",
    KNOWHOW_NETWORK_LOAD_DEDICATED_ACTORS: "1",
    KNOWHOW_NETWORK_LOAD_FINAL_PRODUCTION: "0",
    KNOWHOW_NETWORK_LOAD_EXTENSION_ORIGIN: extensionOrigin,
    KNOWHOW_NETWORK_LOAD_EXTENSION_VERSION: "0.1.0",
    KNOWHOW_NETWORK_LOAD_SYNTHETIC_EMAIL_DOMAIN: "synthetic.knowhow.example",
    KNOWHOW_NETWORK_LOAD_ACTORS_JSON: JSON.stringify([actor(1), actor(2), actor(3)]),
    KNOWHOW_NETWORK_LOAD_EVIDENCE_HMAC_KEY: evidenceKey,
    KNOWHOW_NETWORK_LOAD_EVIDENCE_HMAC_KEY_ID: "test-v1",
  };
}

test("controlled load binds an exact deployment and dedicated synthetic tenant actors", () => {
  const configuration = controlledNetworkLoadConfiguration(stagingEnvironment());
  assert.equal(configuration.target, "staging");
  assert.equal(configuration.siteOrigin, "https://staging.knowhow.example");
  assert.equal(configuration.endpoint, "https://fra.cloud.appwrite.io/v1");
  assert.equal(configuration.actors.length, 3);
  assert.equal(configuration.minimumMembers, 100);
  assert.equal(configuration.readersPerTenant, 110);
  const contentFree = contentFreeActor(configuration.actors[0], evidenceKey, 120);
  assert.deepEqual(Object.keys(contentFree).sort(), [
    "actorFingerprint",
    "expectedGuideFingerprint",
    "observedMemberCount",
    "workspaceFingerprint",
  ]);
  const serialized = JSON.stringify(contentFree);
  assert.doesNotMatch(serialized, /tenant_1|load_workspace_1|load_guide_1|Password|JBSWY/);
});

test("controlled load refuses decorated origins, ambiguous projects, unsafe rates, and weak Production attestations", () => {
  const decorated = stagingEnvironment();
  decorated.KNOWHOW_NETWORK_LOAD_SITE_ORIGIN = "https://user@staging.knowhow.example/?candidate=wrong";
  assert.throws(() => controlledNetworkLoadConfiguration(decorated), /exact lowercase HTTPS hostname origin/);

  const sameProject = stagingEnvironment();
  sameProject.KNOWHOW_NETWORK_LOAD_FORBIDDEN_PROJECT_ID = "staging_project";
  assert.throws(() => controlledNetworkLoadConfiguration(sameProject), /distinct, valid reviewed/);

  const rateOverflow = stagingEnvironment();
  rateOverflow.KNOWHOW_NETWORK_LOAD_READERS_PER_TENANT = "119";
  assert.throws(() => controlledNetworkLoadConfiguration(rateOverflow), /120-request user window/);

  const production = stagingEnvironment();
  production.KNOWHOW_NETWORK_LOAD_ENVIRONMENT = "production";
  production.KNOWHOW_NETWORK_LOAD_CONFIRM = "production-synthetic-network-load";
  production.KNOWHOW_NETWORK_LOAD_EXPECTED_TENANTS = "2";
  production.KNOWHOW_NETWORK_LOAD_MINIMUM_MEMBERS = "1";
  production.KNOWHOW_NETWORK_LOAD_ACTORS_JSON = JSON.stringify([actor(1), actor(2)]);
  assert.throws(() => controlledNetworkLoadConfiguration(production), /final-Production attestation/);
  production.KNOWHOW_NETWORK_LOAD_FINAL_PRODUCTION = "1";
  assert.equal(controlledNetworkLoadConfiguration(production).actors.length, 2);
});

test("controlled load latency and request correlation account for every operation", () => {
  assert.deepEqual(latencySummary([10, 20, 30, 40, 50], 5, 0), {
    operations: 5,
    succeeded: 5,
    failed: 0,
    errorRate: 0,
    p50Ms: 30,
    p95Ms: 50,
    p99Ms: 50,
    maxMs: 50,
  });
  const ids = ["request-0002", "request-0001"];
  assert.equal(requestIdDigest(ids), requestIdDigest([...ids].reverse()));
  assert.throws(() => latencySummary([10], 2, 0), /accounting is incomplete/);
});

function passingEvidence() {
  const tenant = ([actorSuffix, workspaceSuffix, guideSuffix]) => ({
    actorFingerprint: actorSuffix.repeat(64),
    workspaceFingerprint: workspaceSuffix.repeat(64),
    expectedGuideFingerprint: guideSuffix.repeat(64),
    observedMemberCount: 2,
  });
  return {
    evidenceVersion: 1,
    kind: "knowhow-controlled-network-load-evidence",
    status: "passed",
    generatedAt: "2026-08-11T10:00:00.000Z",
    startedAt: "2026-08-11T09:59:00.000Z",
    durationMs: 60_000,
    environment: "production",
    release,
    siteOrigin: "https://app.knowhow.example",
    projectFingerprint: projectFingerprint("production_project"),
    boundary: {
      tenantActors: 2,
      minimumMembersPerTenant: 1,
      virtualReadersPerTenant: 101,
      captureUploadPipelinesPerTenant: 2,
      extensionVersion: "0.1.0",
      searchP95BudgetMs: 2_000,
      captureP95BudgetMs: 10_000,
    },
    tenants: [tenant(["a", "b", "c"]), tenant(["d", "e", "f"])],
    measurements: {
      authorizedSearch: {
        operations: 202,
        succeeded: 202,
        failed: 0,
        errorRate: 0,
        p50Ms: 100,
        p95Ms: 500,
        p99Ms: 700,
        maxMs: 900,
      },
      redactedCaptureUploadDiscard: {
        operations: 4,
        succeeded: 4,
        failed: 0,
        errorRate: 0,
        p50Ms: 1_000,
        p95Ms: 2_000,
        p99Ms: 2_000,
        maxMs: 2_000,
      },
    },
    correlation: {
      responseCount: 230,
      requestIdsSha256: "c".repeat(64),
    },
    cleanup: {
      capturePipelinesDiscarded: 4,
      dedicatedExtensionActorsRevoked: 2,
      serverSessionsRevoked: 2,
      retainedSyntheticRows:
        "discarded/quarantined rows remain inside the dedicated synthetic tenants until the approved environment cleanup or final Production purge",
    },
    assertions: [
      "exact environment, project fingerprint, and release readiness matched",
      "every actor resolved only its configured workspace and synthetic member boundary",
      "cross-tenant workspace probes returned only 403 or 404",
      "every own-tenant search contained its sentinel and no other tenant sentinel",
      "every redacted screenshot upload was discarded idempotently",
      "all dedicated extension credentials and server sessions were revoked",
      "all response correlation IDs were preserved and measurement budgets passed",
    ],
    externalObservationsRequired: [
      "Appwrite Function execution failures and queue depth",
      "Appwrite database and Storage latency/error graphs",
      "Sentry error/regression dashboard for the exact load window",
    ],
  };
}

test("controlled load evidence is immutable, environment-bound, and private", () => {
  const payload = passingEvidence();
  const sealed = sealNetworkLoadEvidence(payload, evidenceKey, "test-v1");
  assert.deepEqual(verifyNetworkLoadEvidence(sealed, evidenceKey, "test-v1"), payload);

  const tampered = structuredClone(sealed);
  tampered.measurements.authorizedSearch.p95Ms = 9_999;
  assert.throws(() => verifyNetworkLoadEvidence(tampered, evidenceKey, "test-v1"), /seal does not match/);

  const invalid = passingEvidence();
  invalid.measurements.authorizedSearch.p95Ms = 9_999;
  const invalidSealed = sealNetworkLoadEvidence(invalid, evidenceKey, "test-v1");
  assert.throws(() => verifyNetworkLoadEvidence(invalidSealed, evidenceKey, "test-v1"), /passing supported contract/);

  const unexpected = { ...passingEvidence(), rawIdentifier: "must-not-pass" };
  const unexpectedSealed = sealNetworkLoadEvidence(
    unexpected,
    evidenceKey,
    "test-v1",
  );
  assert.throws(
    () =>
      verifyNetworkLoadEvidence(
        unexpectedSealed,
        evidenceKey,
        "test-v1",
      ),
    /passing supported contract/,
  );

  assert.equal(
    privateEvidencePath(".tmp/network-load.json", "C:\\workspace"),
    resolve("C:\\workspace", ".tmp/network-load.json"),
  );
  assert.throws(
    () => privateEvidencePath("outputs/network-load.json", "C:\\workspace"),
    /ignored \.tmp directory/,
  );
});
