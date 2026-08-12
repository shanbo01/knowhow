import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  RestoreApplicationError,
  contentFreeActor,
  databaseFingerprint,
  exactSiteOrigin,
  hmacFingerprint,
  openApplicationEvidence,
  openRestoreReport,
  openRestoreCleanupEvidence,
  privateEvidencePath,
  projectFingerprint,
  requestIdDigest,
  restoreEvidenceProjectFingerprint,
  restorationFingerprint,
  restoreApplicationConfiguration,
  restoreApplicationVerificationConfiguration,
  restoreCleanupConfiguration,
  restoreCleanupVerificationConfiguration,
  restoreReportFingerprint,
  sealApplicationEvidence,
  sealRestoreCleanupEvidence,
  siteFingerprint,
} from "../scripts/restore-application-guards.mjs";
import { sealEvidence } from "../scripts/appwrite-restore-evidence.mjs";
import {
  verifySavedApplicationEvidence,
  verifySavedRestoreCleanupEvidence,
} from "../scripts/verify-restored-application.mjs";

const HMAC_KEY = "test-only-restore-application-hmac-key-32-bytes";
const RELEASE = "a".repeat(40);

function rejectsCode(code) {
  return (error) =>
    error instanceof RestoreApplicationError && error.code === code;
}

function withEnvironment(values) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function actors() {
  return [
    {
      label: "alpha",
      email: "alpha@restore.example.test",
      password: "alpha-password-for-tests",
      totpSecret: "JBSWY3DPEHPK3PXP",
      userId: "user_alpha",
      organizationId: "organization_alpha",
      workspaceId: "workspace_alpha",
      publishedGuideId: "guide_alpha",
      privateMediaId: "media_alpha",
      searchQuery: "alpha sentinel",
    },
    {
      label: "bravo",
      email: "bravo@restore.example.test",
      password: "bravo-password-for-tests",
      totpSecret: "KRSXG5DSNFXGOIDB",
      userId: "user_bravo",
      organizationId: "organization_bravo",
      workspaceId: "workspace_bravo",
      publishedGuideId: "guide_bravo",
      privateMediaId: "media_bravo",
      searchQuery: "bravo sentinel",
    },
  ];
}

function environment(workspace) {
  return {
    KNOWHOW_ENVIRONMENT: "production",
    APPWRITE_ENDPOINT: "https://fra.cloud.appwrite.io/v1",
    KNOWHOW_RESTORE_APPLICATION_MODE: "1",
    KNOWHOW_RESTORE_APPLICATION_CONFIRM:
      "production-isolated-restore-application",
    KNOWHOW_RESTORE_APPLICATION_ISOLATED: "1",
    KNOWHOW_RESTORE_APPLICATION_NON_PUBLIC: "1",
    KNOWHOW_RESTORE_APPLICATION_SYNTHETIC_ONLY: "1",
    KNOWHOW_RESTORE_APPLICATION_EMAIL_DISABLED: "1",
    KNOWHOW_RESTORE_APPLICATION_EXCLUSIVE: "1",
    KNOWHOW_RESTORE_APPLICATION_SITE_ORIGIN:
      "https://restore.knowhow.example",
    KNOWHOW_RESTORE_APPLICATION_SOURCE_SITE_ORIGIN:
      "https://knowhow.example",
    KNOWHOW_RESTORE_APPLICATION_EXPECTED_PROJECT_ID: "project_production",
    KNOWHOW_RESTORE_APPLICATION_SOURCE_PROJECT_ID: "project_production",
    KNOWHOW_RESTORE_APPLICATION_DATABASE_ID: "knowhow_restore_releasea",
    KNOWHOW_RESTORE_APPLICATION_SITE_ID: "knowhow_restore_web_releasea",
    KNOWHOW_RESTORE_RESTORATION_ID: "restoration_releasea",
    KNOWHOW_RESTORE_APPLICATION_EXPECTED_RELEASE: RELEASE,
    KNOWHOW_RESTORE_APPLICATION_ACCESS_TOKEN: "x".repeat(48),
    KNOWHOW_RESTORE_APPLICATION_SYNTHETIC_EMAIL_DOMAIN:
      "restore.example.test",
    KNOWHOW_RESTORE_APPLICATION_ACTORS_JSON: JSON.stringify(actors()),
    KNOWHOW_RESTORE_APPLICATION_REQUEST_TIMEOUT_MS: "30000",
    KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY: HMAC_KEY,
    KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY_ID: "test-v1",
    KNOWHOW_RESTORE_REPORT_PATH: resolve(
      workspace,
      ".tmp",
      "restore-report.json",
    ),
    KNOWHOW_RESTORE_APPLICATION_REPORT_PATH: resolve(
      workspace,
      ".tmp",
      "application-report.json",
    ),
    KNOWHOW_RESTORE_CLEANUP_REPORT_PATH: resolve(
      workspace,
      ".tmp",
      "cleanup-report.json",
    ),
  };
}

function restorePayload() {
  return {
    evidenceVersion: 1,
    kind: "knowhow-isolated-restore-verification",
    status: "passed",
    verifiedAt: "2026-08-11T10:00:00.000Z",
    release: RELEASE,
    source: {
      projectFingerprint: restoreEvidenceProjectFingerprint("project_production"),
      databaseId: "knowhow_core",
      archiveId: "archive_releasea",
    },
    target: {
      endpointOrigin: "https://fra.cloud.appwrite.io",
      projectFingerprint: restoreEvidenceProjectFingerprint("project_production"),
      databaseId: "knowhow_restore_releasea",
      restoration: {
        id: "restoration_releasea",
        archiveId: "archive_releasea",
        startedAt: "2026-08-11T09:10:00.000Z",
        completedAt: "2026-08-11T09:20:00.000Z",
      },
    },
    database: {
      tableCount: 40,
      totalRows: 200,
      auditChainCount: 2,
      schemaSha256: "b".repeat(64),
      overallSha256: "c".repeat(64),
    },
    timing: {
      incidentAt: "2026-08-11T09:00:00.000Z",
      recoveryPointAt: "2026-08-11T08:45:00.000Z",
      rpoSeconds: 900,
      databaseVerificationSeconds: 3600,
      applicationRtoStillRequired: true,
    },
    attestations: {
      isolatedTarget: true,
      targetNotReferencedByDeployedRuntime: true,
      syntheticDataOnly: true,
    },
  };
}

function applicationPayload(sealedRestore) {
  const actorEvidence = actors().map((actor) =>
    contentFreeActor(actor, HMAC_KEY),
  );
  const requestIds = Array.from({ length: 20 }, () => randomUUID());
  return {
    evidenceVersion: 1,
    kind: "knowhow-restored-application-evidence",
    status: "passed",
    environment: "production",
    release: RELEASE,
    siteOrigin: "https://restore.knowhow.example",
    sourceSiteOrigin: "https://knowhow.example",
    disposableSiteFingerprint: siteFingerprint(
      "knowhow_restore_web_releasea",
    ),
    projectFingerprint: projectFingerprint("project_production"),
    databaseFingerprint: databaseFingerprint("knowhow_restore_releasea"),
    restorationFingerprint: restorationFingerprint("restoration_releasea"),
    startedAt: "2026-08-11T10:01:00.000Z",
    readinessReachedAt: "2026-08-11T10:01:05.000Z",
    applicationVerifiedAt: "2026-08-11T10:02:00.000Z",
    generatedAt: "2026-08-11T10:02:01.000Z",
    sourceRestoreEvidence: {
      reportSha256: restoreReportFingerprint(sealedRestore),
      databaseOverallSha256: "c".repeat(64),
      verifiedAt: "2026-08-11T10:00:00.000Z",
      archiveFingerprint: hmacFingerprint(
        HMAC_KEY,
        "restore-archive",
        "archive_releasea",
      ),
    },
    actors: actorEvidence,
    checks: {
      accessBoundary: "denied-without-secret",
      readinessBinding: "exact",
      verifiedMfaSessions: 2,
      ownTenantReads: 2,
      organizationMetadataOnlyBoundary: "passed",
      crossTenantBootstrapDenials: 2,
      crossTenantSearchDenials: 2,
      crossTenantMediaDenials: 2,
      transactionalMutation: "committed",
      idempotentReplay: "passed",
      auditChain: "sequential",
      exportCreation: "queued",
      anonymousApiDenials: 5,
    },
    transaction: {
      auditSequenceBefore: 9,
      auditSequenceAfterCompletion: 10,
      auditSequenceAfterAuditExport: 11,
      auditSequenceAfterExportCreation: 12,
      exportJobFingerprint: "e".repeat(64),
    },
    timing: {
      incidentAt: "2026-08-11T09:00:00.000Z",
      rtoTargetSeconds: 86400,
      applicationRtoSeconds: 3720,
      applicationRtoSatisfied: true,
    },
    correlation: {
      responseCount: requestIds.length,
      requestIdsSha256: requestIdDigest(requestIds),
    },
    cleanup: {
      serverSessionsRevoked: 2,
      restoreDatabaseDeletionRequired: true,
      disposableSiteRemovalRequired: true,
      testRowsConfinedToRestoredDatabase: true,
    },
    attestations: {
      isolatedTarget: true,
      accessControlledSite: true,
      syntheticDataOnly: true,
      emailDeliveryDisabled: true,
      exclusiveRehearsal: true,
    },
    externalActionsRequired: [
      "second-operator approval and exact restored-database deletion",
      "remove the disposable Site, Auth platform hostname, short-lived key, and restore access secret",
    ],
  };
}

test("restore-application configuration is exact, private, and synthetic-only", () => {
  const workspace = resolve("restore-application-workspace");
  const config = restoreApplicationConfiguration(environment(workspace), workspace);
  assert.equal(config.environment, "production");
  assert.equal(config.endpoint, "https://fra.cloud.appwrite.io/v1");
  assert.equal(config.siteOrigin, "https://restore.knowhow.example");
  assert.equal(config.databaseId, "knowhow_restore_releasea");
  assert.equal(config.disposableSiteId, "knowhow_restore_web_releasea");
  assert.equal(config.actors.length, 2);
  assert.equal(
    config.applicationReportPath,
    resolve(workspace, ".tmp", "application-report.json"),
  );
  assert.doesNotMatch(
    JSON.stringify(config.actors.map((actor) => contentFreeActor(actor, HMAC_KEY))),
    /alpha@|password|totp|workspace_alpha|guide_alpha/,
  );
  assert.equal(
    privateEvidencePath(".tmp/evidence.json", workspace),
    resolve(workspace, ".tmp", "evidence.json"),
  );
  assert.throws(
    () => privateEvidencePath("evidence.json", workspace),
    rejectsCode("EVIDENCE_PATH_NOT_PRIVATE"),
  );
});

test("restore-application configuration rejects a decorated, shared, or weak target", () => {
  const workspace = resolve("restore-application-workspace");
  const base = environment(workspace);
  assert.throws(
    () => exactSiteOrigin("https://restore.knowhow.example/"),
    rejectsCode("SITE_ORIGIN_INVALID"),
  );
  assert.throws(
    () =>
      restoreApplicationConfiguration(
        {
          ...base,
          APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1",
        },
        workspace,
      ),
    rejectsCode("APPWRITE_ENDPOINT_NOT_FRANKFURT"),
  );
  assert.throws(
    () =>
      restoreApplicationConfiguration(
        {
          ...base,
          KNOWHOW_RESTORE_APPLICATION_SOURCE_SITE_ORIGIN:
            base.KNOWHOW_RESTORE_APPLICATION_SITE_ORIGIN,
        },
        workspace,
      ),
    rejectsCode("SITE_NOT_ISOLATED"),
  );
  assert.throws(
    () =>
      restoreApplicationConfiguration(
        {
          ...base,
          KNOWHOW_RESTORE_APPLICATION_DATABASE_ID: "knowhow_core",
        },
        workspace,
      ),
    rejectsCode("RESTORE_DATABASE_ID_INVALID"),
  );
  assert.throws(
    () =>
      restoreApplicationConfiguration(
        {
          ...base,
          KNOWHOW_RESTORE_APPLICATION_SITE_ID: "knowhow_web",
        },
        workspace,
      ),
    rejectsCode("RESTORE_SITE_ID_INVALID"),
  );
  assert.throws(
    () =>
      restoreApplicationConfiguration(
        {
          ...base,
          KNOWHOW_RESTORE_APPLICATION_NON_PUBLIC: "0",
        },
        workspace,
      ),
    rejectsCode("ATTESTATION_REQUIRED"),
  );
  const duplicateActors = actors();
  duplicateActors[1].workspaceId = duplicateActors[0].workspaceId;
  assert.throws(
    () =>
      restoreApplicationConfiguration(
        {
          ...base,
          KNOWHOW_RESTORE_APPLICATION_ACTORS_JSON:
            JSON.stringify(duplicateActors),
        },
        workspace,
      ),
    rejectsCode("ACTOR_BOUNDARY_INVALID"),
  );
});

test("sealed restore and application evidence are chained, content-free, and tamper evident", () => {
  const workspace = resolve("restore-application-workspace");
  const config = restoreApplicationConfiguration(environment(workspace), workspace);
  const sealedRestore = sealEvidence(restorePayload(), HMAC_KEY, "test-v1");
  assert.equal(
    openRestoreReport(sealedRestore, config).database.overallSha256,
    "c".repeat(64),
  );
  assert.throws(
    () =>
      openRestoreReport(
        sealEvidence(
          { ...restorePayload(), unexpectedContent: "must-not-pass" },
          HMAC_KEY,
          "test-v1",
        ),
        config,
      ),
    rejectsCode("RESTORE_REPORT_FIELDS_INVALID"),
  );
  assert.throws(
    () =>
      openRestoreReport(
        sealEvidence(
          {
            ...restorePayload(),
            timing: { ...restorePayload().timing, rpoSeconds: 901 },
          },
          HMAC_KEY,
          "test-v1",
        ),
        config,
      ),
    rejectsCode("RESTORE_REPORT_TIMING_INVALID"),
  );
  const payload = applicationPayload(sealedRestore);
  const sealed = sealApplicationEvidence(payload, HMAC_KEY, "test-v1");
  assert.deepEqual(openApplicationEvidence(sealed, HMAC_KEY, "test-v1"), payload);
  const serialized = JSON.stringify(sealed);
  assert.doesNotMatch(
    serialized,
    /alpha@|bravo@|password-for-tests|JBSWY|user_alpha|workspace_alpha|guide_alpha|media_alpha/,
  );
  assert.throws(
    () =>
      openApplicationEvidence(
        { ...sealed, timing: { ...sealed.timing, applicationRtoSeconds: 90_000 } },
        HMAC_KEY,
        "test-v1",
      ),
    rejectsCode("APPLICATION_EVIDENCE_SEAL_INVALID"),
  );
  const invalidPayload = {
    ...payload,
    checks: { ...payload.checks, crossTenantMediaDenials: 1 },
  };
  const resealedInvalid = sealEvidence(invalidPayload, HMAC_KEY, "test-v1");
  assert.throws(
    () => openApplicationEvidence(resealedInvalid, HMAC_KEY, "test-v1"),
    rejectsCode("APPLICATION_EVIDENCE_CHECKS_INVALID"),
  );
});

test("offline verification configuration does not require actor or Site access secrets", () => {
  const workspace = resolve("restore-application-workspace");
  const base = environment(workspace);
  const minimal = {
    KNOWHOW_ENVIRONMENT: base.KNOWHOW_ENVIRONMENT,
    KNOWHOW_RESTORE_APPLICATION_SITE_ORIGIN:
      base.KNOWHOW_RESTORE_APPLICATION_SITE_ORIGIN,
    KNOWHOW_RESTORE_APPLICATION_SOURCE_SITE_ORIGIN:
      base.KNOWHOW_RESTORE_APPLICATION_SOURCE_SITE_ORIGIN,
    KNOWHOW_RESTORE_APPLICATION_EXPECTED_PROJECT_ID:
      base.KNOWHOW_RESTORE_APPLICATION_EXPECTED_PROJECT_ID,
    KNOWHOW_RESTORE_APPLICATION_DATABASE_ID:
      base.KNOWHOW_RESTORE_APPLICATION_DATABASE_ID,
    KNOWHOW_RESTORE_APPLICATION_SITE_ID:
      base.KNOWHOW_RESTORE_APPLICATION_SITE_ID,
    KNOWHOW_RESTORE_RESTORATION_ID: base.KNOWHOW_RESTORE_RESTORATION_ID,
    KNOWHOW_RESTORE_APPLICATION_EXPECTED_RELEASE:
      base.KNOWHOW_RESTORE_APPLICATION_EXPECTED_RELEASE,
    KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY:
      base.KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY,
    KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY_ID:
      base.KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY_ID,
    KNOWHOW_RESTORE_REPORT_PATH: base.KNOWHOW_RESTORE_REPORT_PATH,
    KNOWHOW_RESTORE_APPLICATION_REPORT_PATH:
      base.KNOWHOW_RESTORE_APPLICATION_REPORT_PATH,
  };
  const verified = restoreApplicationVerificationConfiguration(
    minimal,
    workspace,
  );
  assert.equal(verified.databaseId, "knowhow_restore_releasea");
  assert.equal("actors" in verified, false);
  assert.equal("accessToken" in verified, false);
});

test("independent restore cleanup accepts only a read-only exact Frankfurt binding", () => {
  const workspace = resolve("restore-application-workspace");
  const base = environment(workspace);
  const cleanupEnvironment = {
    ...base,
    KNOWHOW_RESTORE_CLEANUP_CONFIRM:
      "production-isolated-restore-cleanup",
    KNOWHOW_RESTORE_CLEANUP_SECOND_OPERATOR: "1",
    KNOWHOW_RESTORE_CLEANUP_PLATFORM_REMOVED: "1",
    KNOWHOW_RESTORE_CLEANUP_RUNTIME_KEY_REVOKED: "1",
    KNOWHOW_RESTORE_CLEANUP_ACCESS_SECRET_DESTROYED: "1",
    APPWRITE_ENDPOINT: "https://fra.cloud.appwrite.io/v1",
    APPWRITE_PROJECT_ID: "project_production",
    APPWRITE_API_KEY: "read-only-cleanup-key-with-twenty-characters",
  };
  const cleanup = restoreCleanupConfiguration(cleanupEnvironment, workspace);
  assert.equal(cleanup.disposableSiteId, "knowhow_restore_web_releasea");
  assert.equal(cleanup.endpoint, "https://fra.cloud.appwrite.io/v1");
  assert.equal(
    cleanup.cleanupReportPath,
    resolve(workspace, ".tmp", "cleanup-report.json"),
  );
  assert.throws(
    () =>
      restoreCleanupConfiguration(
        { ...cleanupEnvironment, APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1" },
        workspace,
      ),
    rejectsCode("APPWRITE_ENDPOINT_NOT_FRANKFURT"),
  );
  assert.throws(
    () =>
      restoreCleanupConfiguration(
        {
          ...cleanupEnvironment,
          KNOWHOW_RESTORE_APPLICATION_SITE_ID: "knowhow_web",
        },
        workspace,
      ),
    rejectsCode("RESTORE_SITE_ID_INVALID"),
  );
  const offline = restoreCleanupVerificationConfiguration(base, workspace);
  assert.equal(offline.disposableSiteId, "knowhow_restore_web_releasea");
  assert.equal("apiKey" in offline, false);
});

test("restore cleanup evidence preserves source resources and proves disposable absence", () => {
  const workspace = resolve("restore-application-workspace");
  const base = environment(workspace);
  const sealedRestore = sealEvidence(restorePayload(), HMAC_KEY, "test-v1");
  const sealedApplication = sealApplicationEvidence(
    applicationPayload(sealedRestore),
    HMAC_KEY,
    "test-v1",
  );
  const payload = {
    evidenceVersion: 1,
    kind: "knowhow-restore-cleanup-evidence",
    status: "passed",
    environment: "production",
    release: RELEASE,
    verifiedAt: "2026-08-11T10:03:00.000Z",
    projectFingerprint: projectFingerprint("project_production"),
    databaseFingerprint: databaseFingerprint("knowhow_restore_releasea"),
    restorationFingerprint: restorationFingerprint("restoration_releasea"),
    disposableSiteFingerprint: siteFingerprint(
      "knowhow_restore_web_releasea",
    ),
    evidenceChain: {
      restoreReportSha256: restoreReportFingerprint(sealedRestore),
      applicationReportSha256: restoreReportFingerprint(sealedApplication),
    },
    checks: {
      sourceDatabase: "present",
      sourceSite: "present",
      restoredDatabase: "absent",
      disposableSite: "absent",
    },
    attestations: {
      independentSecondOperator: true,
      temporaryAuthPlatformRemoved: true,
      disposableRuntimeKeyRevoked: true,
      restoreAccessSecretDestroyed: true,
    },
    remainingActions: [
      "revoke the read-only cleanup verifier key after offline evidence verification",
    ],
  };
  const sealed = sealRestoreCleanupEvidence(payload, HMAC_KEY, "test-v1");
  assert.deepEqual(
    openRestoreCleanupEvidence(sealed, HMAC_KEY, "test-v1"),
    payload,
  );
  assert.doesNotMatch(
    JSON.stringify(sealed),
    /knowhow_restore_releasea|knowhow_restore_web_releasea|restoration_releasea/,
  );
  const invalid = sealEvidence(
    {
      ...payload,
      checks: { ...payload.checks, sourceDatabase: "absent" },
    },
    HMAC_KEY,
    "test-v1",
  );
  assert.throws(
    () => openRestoreCleanupEvidence(invalid, HMAC_KEY, "test-v1"),
    rejectsCode("RESTORE_CLEANUP_EVIDENCE_CHECKS_INVALID"),
  );
  assert.equal(
    restoreCleanupVerificationConfiguration(base, workspace).cleanupReportPath,
    resolve(workspace, ".tmp", "cleanup-report.json"),
  );
});

test("offline commands verify the complete three-report evidence chain without live credentials", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "knowhow-restore-evidence-"));
  const restorePath = join(temporary, "restore.json");
  const applicationPath = join(temporary, "application.json");
  const cleanupPath = join(temporary, "cleanup.json");
  const sealedRestore = sealEvidence(restorePayload(), HMAC_KEY, "test-v1");
  const sealedApplication = sealApplicationEvidence(
    applicationPayload(sealedRestore),
    HMAC_KEY,
    "test-v1",
  );
  const cleanupPayload = {
    evidenceVersion: 1,
    kind: "knowhow-restore-cleanup-evidence",
    status: "passed",
    environment: "production",
    release: RELEASE,
    verifiedAt: "2026-08-11T10:03:00.000Z",
    projectFingerprint: projectFingerprint("project_production"),
    databaseFingerprint: databaseFingerprint("knowhow_restore_releasea"),
    restorationFingerprint: restorationFingerprint("restoration_releasea"),
    disposableSiteFingerprint: siteFingerprint(
      "knowhow_restore_web_releasea",
    ),
    evidenceChain: {
      restoreReportSha256: restoreReportFingerprint(sealedRestore),
      applicationReportSha256: restoreReportFingerprint(sealedApplication),
    },
    checks: {
      sourceDatabase: "present",
      sourceSite: "present",
      restoredDatabase: "absent",
      disposableSite: "absent",
    },
    attestations: {
      independentSecondOperator: true,
      temporaryAuthPlatformRemoved: true,
      disposableRuntimeKeyRevoked: true,
      restoreAccessSecretDestroyed: true,
    },
    remainingActions: [
      "revoke the read-only cleanup verifier key after offline evidence verification",
    ],
  };
  const sealedCleanup = sealRestoreCleanupEvidence(
    cleanupPayload,
    HMAC_KEY,
    "test-v1",
  );
  await Promise.all([
    writeFile(restorePath, JSON.stringify(sealedRestore), "utf8"),
    writeFile(applicationPath, JSON.stringify(sealedApplication), "utf8"),
    writeFile(cleanupPath, JSON.stringify(sealedCleanup), "utf8"),
  ]);
  const restoreEnvironment = withEnvironment({
    KNOWHOW_ENVIRONMENT: "production",
    KNOWHOW_RESTORE_APPLICATION_SITE_ORIGIN:
      "https://restore.knowhow.example",
    KNOWHOW_RESTORE_APPLICATION_SOURCE_SITE_ORIGIN:
      "https://knowhow.example",
    KNOWHOW_RESTORE_APPLICATION_EXPECTED_PROJECT_ID: "project_production",
    KNOWHOW_RESTORE_APPLICATION_DATABASE_ID: "knowhow_restore_releasea",
    KNOWHOW_RESTORE_RESTORATION_ID: "restoration_releasea",
    KNOWHOW_RESTORE_APPLICATION_EXPECTED_RELEASE: RELEASE,
    KNOWHOW_RESTORE_APPLICATION_SITE_ID: "knowhow_restore_web_releasea",
    KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY: HMAC_KEY,
    KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY_ID: "test-v1",
    KNOWHOW_RESTORE_REPORT_PATH: restorePath,
    KNOWHOW_RESTORE_APPLICATION_REPORT_PATH: applicationPath,
    KNOWHOW_RESTORE_CLEANUP_REPORT_PATH: cleanupPath,
  });
  try {
    const application = await verifySavedApplicationEvidence();
    assert.equal(application.status, "passed");
    assert.equal(application.cleanup.restoreDatabaseDeletionRequired, true);
    const cleanup = await verifySavedRestoreCleanupEvidence();
    assert.equal(cleanup.status, "passed");
    assert.deepEqual(cleanup.checks, cleanupPayload.checks);
  } finally {
    restoreEnvironment();
    await rm(temporary, { recursive: true, force: true });
  }
});
