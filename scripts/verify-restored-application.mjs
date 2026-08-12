import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  AppwriteException,
  Client,
  Sites,
  TablesDB,
} from "node-appwrite";
import {
  RestoreApplicationError,
  contentFreeActor,
  databaseFingerprint,
  hmacFingerprint,
  openApplicationEvidence,
  openRestoreReport,
  openRestoreCleanupEvidence,
  projectFingerprint,
  requestIdDigest,
  restorationFingerprint,
  restoreApplicationConfiguration,
  restoreApplicationVerificationConfiguration,
  restoreCleanupConfiguration,
  restoreCleanupVerificationConfiguration,
  restoreReportFingerprint,
  safeFailure,
  sealApplicationEvidence,
  sealRestoreCleanupEvidence,
  siteFingerprint,
  siteOriginFingerprint,
} from "./restore-application-guards.mjs";

const CSRF_COOKIE_NAME = "knowhow_csrf";
const RESPONSE_LIMIT_BYTES = 5_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;

function gateFailure(code, message) {
  throw new RestoreApplicationError(code, message);
}

function expect(condition, code, message) {
  if (!condition) gateFailure(code, message);
}

class CookieJar {
  #cookies = new Map();

  absorb(response) {
    const values = response.headers.getSetCookie?.();
    if (!Array.isArray(values)) {
      gateFailure(
        "COOKIE_API_UNAVAILABLE",
        "Node.js 22 or later is required for restored-application session verification.",
      );
    }
    for (const value of values) {
      const match = /^([^=;\s]+)=([^;]*)/.exec(value);
      if (!match) continue;
      if (match[2] === "" || /;\s*max-age=0(?:;|$)/i.test(value)) {
        this.#cookies.delete(match[1]);
      } else {
        this.#cookies.set(match[1], match[2]);
      }
    }
  }

  header() {
    return [...this.#cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  value(name) {
    return this.#cookies.get(name);
  }
}

function base32Bytes(input) {
  const secret = input.startsWith("otpauth://")
    ? new URL(input).searchParams.get("secret")
    : input;
  if (!secret) {
    gateFailure("TOTP_SECRET_INVALID", "A restored-application TOTP URI has no secret.");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.toUpperCase().replace(/[=\s-]/g, "");
  let bits = "";
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) {
      gateFailure("TOTP_SECRET_INVALID", "A restored-application TOTP secret is not valid base32.");
    }
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

async function totpCode(input) {
  const remainder = 30 - (Math.floor(Date.now() / 1_000) % 30);
  if (remainder <= 2) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_500));
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", base32Bytes(input))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function runtimeFor(configuration, actor = null) {
  return {
    configuration,
    actor,
    jar: new CookieJar(),
    requestIds: [],
    signedIn: false,
  };
}

function safeJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    gateFailure(
      "RESPONSE_INVALID",
      "A restored-application endpoint returned invalid JSON.",
    );
  }
}

async function requestRaw(runtime, path, options = {}) {
  const requestId = randomUUID();
  const headers = new Headers(options.headers);
  headers.set("user-agent", "KnowHow-Restore-Application-Verifier/1");
  if (options.withAccess !== false) {
    headers.set(
      "x-knowhow-restore-access",
      runtime.configuration.accessToken,
    );
  }
  if (options.expectCorrelation !== false) {
    headers.set("x-request-id", requestId);
  }
  if (options.origin) headers.set("origin", options.origin);
  if (options.useCookies !== false) {
    const cookie = runtime.jar.header();
    if (cookie) headers.set("cookie", cookie);
  }
  let body;
  if (options.body !== undefined) {
    headers.set("content-type", options.contentType ?? "application/json");
    body = options.contentType && options.contentType !== "application/json"
      ? options.body
      : JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(new URL(path, runtime.configuration.siteOrigin), {
      method: options.method ?? "GET",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(runtime.configuration.requestTimeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      gateFailure("REQUEST_TIMEOUT", "A restored-application request exceeded its timeout.");
    }
    gateFailure(
      "REQUEST_FAILED",
      "A restored-application request could not reach the isolated Site.",
    );
  }
  runtime.jar.absorb(response);
  if (options.expectCorrelation !== false) {
    const responseRequestId = response.headers.get("x-request-id")?.trim() ?? "";
    expect(
      UUID.test(responseRequestId) && responseRequestId === requestId,
      "REQUEST_ID_MISMATCH",
      "A restored-application response did not preserve its exact correlation ID.",
    );
    runtime.requestIds.push(responseRequestId);
  }
  const text = await response.text();
  expect(
    Buffer.byteLength(text, "utf8") <= RESPONSE_LIMIT_BYTES,
    "RESPONSE_TOO_LARGE",
    "A restored-application response exceeded the evidence gate limit.",
  );
  const expectedStatuses = options.expectedStatuses ?? [200];
  if (!expectedStatuses.includes(response.status)) {
    const candidate = safeJson(text);
    const remoteCode =
      typeof candidate.code === "string" && /^[A-Z0-9_]{2,80}$/.test(candidate.code)
        ? candidate.code
        : "UNEXPECTED_STATUS";
    gateFailure(
      "HTTP_REQUEST_FAILED",
      `A restored-application request returned HTTP ${response.status} (${remoteCode}).`,
    );
  }
  return { response, text, status: response.status };
}

async function requestJson(runtime, path, options = {}) {
  const result = await requestRaw(runtime, path, {
    ...options,
    headers: { accept: "application/json", ...(options.headers ?? {}) },
  });
  return { ...result, payload: safeJson(result.text) };
}

function csrfHeaders(runtime) {
  const csrf = runtime.jar.value(CSRF_COOKIE_NAME);
  expect(
    typeof csrf === "string" && csrf.length >= 32,
    "CSRF_COOKIE_MISSING",
    "A restored-application session did not receive its CSRF cookie.",
  );
  return { "x-csrf-token": csrf };
}

async function command(runtime, action, payload, idempotencyKey) {
  return requestJson(runtime, "/api/knowhow", {
    method: "POST",
    origin: runtime.configuration.siteOrigin,
    headers: {
      ...csrfHeaders(runtime),
      "x-idempotency-key": idempotencyKey,
    },
    body: { action, payload },
  });
}

function guideVisible(bootstrap, guideId) {
  return bootstrap.activeWorkspace?.guides?.some(
    (guide) => guide?.id === guideId && guide?.publishedRevision,
  );
}

function auditSequence(bootstrap) {
  const audits = bootstrap.activeWorkspace?.audits;
  expect(
    Array.isArray(audits) && audits.length > 0,
    "AUDIT_VISIBILITY_INVALID",
    "The mutation actor must be a workspace administrator with visible restored audit history.",
  );
  const sequence = Math.max(...audits.map((event) => Number(event?.sequence)));
  expect(
    Number.isSafeInteger(sequence) && sequence >= 1,
    "AUDIT_SEQUENCE_INVALID",
    "The restored workspace audit sequence is invalid.",
  );
  return sequence;
}

function assertAuditEvent(bootstrap, sequence, action) {
  const event = bootstrap.activeWorkspace?.audits?.find(
    (candidate) => Number(candidate?.sequence) === sequence,
  );
  expect(
    event?.action === action,
    "AUDIT_SEQUENCE_INVALID",
    "The restored application did not append the expected audit event in sequence.",
  );
}

async function assertAccessBoundary(runtime) {
  for (const path of ["/", "/api/health?ready=1"]) {
    const denied = await requestJson(runtime, path, {
      withAccess: false,
      useCookies: false,
      expectCorrelation: false,
      expectedStatuses: [404],
    });
    expect(
      denied.payload.code === "NOT_FOUND" &&
        denied.response.headers.get("x-robots-tag")?.includes("noindex") &&
        denied.response.headers.get("cache-control")?.includes("no-store"),
      "ACCESS_BOUNDARY_INVALID",
      "The disposable restored-application Site is not fail-closed to unauthenticated network access.",
    );
  }
}

async function assertDeployment(runtime) {
  const ready = await requestJson(runtime, "/api/health?ready=1", {
    useCookies: false,
  });
  expect(
    ready.payload.status === "ready",
    "READINESS_FAILED",
    "The isolated restored-application Site did not report ready.",
  );
  const expectedDeployment = {
    environment: "production",
    release: runtime.configuration.release,
    projectFingerprint: projectFingerprint(
      runtime.configuration.expectedProjectId,
    ),
    mode: "isolated-restore-application",
    databaseFingerprint: databaseFingerprint(
      runtime.configuration.databaseId,
    ),
    restorationFingerprint: restorationFingerprint(
      runtime.configuration.restorationId,
    ),
    disposableSiteFingerprint: siteFingerprint(
      runtime.configuration.disposableSiteId,
    ),
    siteOriginFingerprint: siteOriginFingerprint(
      runtime.configuration.siteOrigin,
    ),
    sourceSiteOriginFingerprint: siteOriginFingerprint(
      runtime.configuration.sourceSiteOrigin,
    ),
  };
  expect(
    JSON.stringify(ready.payload.deployment) ===
      JSON.stringify(expectedDeployment) &&
      ready.payload.checks?.configuration === "ok" &&
      ready.payload.checks?.restoreIsolation === "ok",
    "READINESS_BINDING_INVALID",
    "The isolated Site readiness is not bound to the exact release, project, restored database, and restoration.",
  );
  await requestJson(runtime, "/api/auth/health", { useCookies: false });
  return new Date().toISOString();
}

async function assertAnonymousDenials(runtime) {
  const checks = [
    "/api/knowhow",
    "/api/knowhow/media?workspaceId=synthetic&mediaId=synthetic",
    "/api/knowhow/export?jobId=synthetic",
    "/api/knowhow/audit?workspaceId=synthetic",
    "/api/extension/context",
  ];
  for (const path of checks) {
    await requestJson(runtime, path, {
      useCookies: false,
      expectedStatuses: [401, 403],
    });
  }
  return checks.length;
}

async function authenticate(runtime, allActors) {
  const actor = runtime.actor;
  const signIn = await requestJson(runtime, "/api/auth/sign-in", {
    method: "POST",
    origin: runtime.configuration.siteOrigin,
    body: { email: actor.email, password: actor.password },
  });
  runtime.signedIn = true;
  expect(
    signIn.payload.mfaRequired === true &&
      Array.isArray(signIn.payload.factors) &&
      signIn.payload.factors.includes("totp"),
    "MFA_CHALLENGE_REQUIRED",
    "Every restored-application actor must require a fresh TOTP challenge after password authentication.",
  );
  const challenge = await requestJson(runtime, "/api/auth/mfa/challenge", {
    method: "POST",
    origin: runtime.configuration.siteOrigin,
    headers: csrfHeaders(runtime),
    body: { factor: "totp" },
  });
  expect(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(
      String(challenge.payload.challengeId ?? ""),
    ),
    "MFA_CHALLENGE_INVALID",
    "The restored-application MFA challenge is invalid.",
  );
  await requestJson(runtime, "/api/auth/mfa/complete", {
    method: "POST",
    origin: runtime.configuration.siteOrigin,
    headers: csrfHeaders(runtime),
    body: {
      challengeId: challenge.payload.challengeId,
      otp: await totpCode(actor.totpSecret),
    },
  });
  const session = await requestJson(runtime, "/api/auth/session");
  expect(
    session.payload.user?.id === actor.userId &&
      session.payload.user?.email === actor.email &&
      session.payload.user?.emailVerification === true &&
      session.payload.user?.mfa === true,
    "SESSION_IDENTITY_INVALID",
    "A restored-application session did not resolve to its exact verified MFA actor.",
  );
  const bootstrap = await requestJson(
    runtime,
    `/api/knowhow?${new URLSearchParams({ workspaceId: actor.workspaceId })}`,
  );
  expect(
    bootstrap.payload.activeWorkspace?.workspace?.id === actor.workspaceId &&
      bootstrap.payload.workspaces?.some(
        (workspace) => workspace?.id === actor.workspaceId,
      ) &&
      allActors
        .filter((candidate) => candidate.workspaceId !== actor.workspaceId)
        .every(
          (candidate) =>
            !bootstrap.payload.workspaces?.some(
              (workspace) => workspace?.id === candidate.workspaceId,
            ),
        ) &&
      guideVisible(bootstrap.payload, actor.publishedGuideId),
    "OWN_TENANT_INVALID",
    "A restored-application actor did not resolve only its expected workspace and published guide.",
  );
  const search = await requestJson(
    runtime,
    `/api/knowhow/search?${new URLSearchParams({
      workspaceId: actor.workspaceId,
      q: actor.searchQuery,
    })}`,
  );
  const guideIds = Array.isArray(search.payload.results)
    ? search.payload.results.map((result) => String(result?.guideId ?? ""))
    : [];
  expect(
    guideIds.includes(actor.publishedGuideId) &&
      allActors
        .filter((candidate) => candidate.workspaceId !== actor.workspaceId)
        .every((candidate) => !guideIds.includes(candidate.publishedGuideId)),
    "OWN_TENANT_SEARCH_INVALID",
    "A restored-application search did not return only its tenant sentinel.",
  );
  return bootstrap.payload;
}

function assertMetadataOnlyBoundary(firstBootstrap, secondActor) {
  const organization = firstBootstrap.organizations?.find(
    (candidate) => candidate?.id === secondActor.organizationId,
  );
  expect(
    organization?.workspaces?.some(
      (workspace) => workspace?.id === secondActor.workspaceId,
    ) &&
      !firstBootstrap.workspaces?.some(
        (workspace) => workspace?.id === secondActor.workspaceId,
      ),
    "ORGANIZATION_METADATA_BOUNDARY_INVALID",
    "The designated organization administrator must see restored organization/workspace metadata without workspace membership.",
  );
}

async function assertCrossTenantDenials(runtimes) {
  for (const runtime of runtimes) {
    const other = runtimes.find((candidate) => candidate !== runtime).actor;
    await requestJson(
      runtime,
      `/api/knowhow?${new URLSearchParams({ workspaceId: other.workspaceId })}`,
      { expectedStatuses: [403, 404] },
    );
    await requestJson(
      runtime,
      `/api/knowhow/search?${new URLSearchParams({
        workspaceId: other.workspaceId,
        q: other.searchQuery,
      })}`,
      { expectedStatuses: [403, 404] },
    );
    await requestJson(
      runtime,
      `/api/knowhow/media?${new URLSearchParams({
        workspaceId: other.workspaceId,
        mediaId: other.privateMediaId,
      })}`,
      { expectedStatuses: [403, 404] },
    );
  }
}

async function bootstrap(runtime) {
  return (
    await requestJson(
      runtime,
      `/api/knowhow?${new URLSearchParams({
        workspaceId: runtime.actor.workspaceId,
      })}`,
    )
  ).payload;
}

async function verifyTransactionalApplicationFlow(runtime, hmacKey) {
  const initial = await bootstrap(runtime);
  const before = auditSequence(initial);
  const completionKey = `restore-completion-${randomUUID()}`;
  const completionPayload = {
    workspaceId: runtime.actor.workspaceId,
    guideId: runtime.actor.publishedGuideId,
  };
  const committed = await command(
    runtime,
    "recordGuideCompletion",
    completionPayload,
    completionKey,
  );
  expect(
    committed.payload.recorded === true,
    "TRANSACTION_MUTATION_FAILED",
    "The restored application did not commit the guide-completion transaction.",
  );
  const replay = await command(
    runtime,
    "recordGuideCompletion",
    completionPayload,
    completionKey,
  );
  expect(
    replay.payload.recorded === true,
    "TRANSACTION_REPLAY_FAILED",
    "The restored application did not replay the committed transaction idempotently.",
  );
  const afterCompletion = await bootstrap(runtime);
  expect(
    auditSequence(afterCompletion) === before + 1,
    "TRANSACTION_REPLAY_MUTATED",
    "The idempotent transaction replay appended an unexpected audit event.",
  );
  assertAuditEvent(afterCompletion, before + 1, "guide.completed");

  const audit = await requestRaw(
    runtime,
    `/api/knowhow/audit?${new URLSearchParams({
      workspaceId: runtime.actor.workspaceId,
      action: "guide.completed",
    })}`,
  );
  expect(
    audit.response.headers.get("content-type")?.startsWith("text/csv") &&
      audit.text.includes('"guide.completed"'),
    "AUDIT_EXPORT_INVALID",
    "The restored application did not verify and export its completed audit chain.",
  );
  const afterAuditExport = await bootstrap(runtime);
  expect(
    auditSequence(afterAuditExport) === before + 2,
    "AUDIT_SEQUENCE_INVALID",
    "The restored application did not advance its audit chain for the audit export.",
  );
  assertAuditEvent(afterAuditExport, before + 2, "audit.exported");

  const exportKey = `restore-export-${randomUUID()}`;
  const exportBody = {
    workspaceId: runtime.actor.workspaceId,
    guideId: runtime.actor.publishedGuideId,
    format: "markdown",
  };
  const queued = await requestJson(runtime, "/api/knowhow/export", {
    method: "POST",
    origin: runtime.configuration.siteOrigin,
    headers: {
      ...csrfHeaders(runtime),
      "x-idempotency-key": exportKey,
    },
    body: exportBody,
    expectedStatuses: [200, 202],
  });
  const jobId = String(queued.payload.jobId ?? "");
  expect(
    ID.test(jobId) &&
      queued.payload.status === "queued" &&
      queued.payload.created === true,
    "EXPORT_CREATION_INVALID",
    "The restored application did not create an isolated queued export.",
  );
  const exportReplay = await requestJson(runtime, "/api/knowhow/export", {
    method: "POST",
    origin: runtime.configuration.siteOrigin,
    headers: {
      ...csrfHeaders(runtime),
      "x-idempotency-key": exportKey,
    },
    body: exportBody,
    expectedStatuses: [200],
  });
  expect(
    exportReplay.payload.jobId === jobId &&
      exportReplay.payload.status === "queued" &&
      exportReplay.payload.created === false,
    "EXPORT_REPLAY_INVALID",
    "The restored application did not replay export creation idempotently.",
  );
  const exportStatus = await requestJson(
    runtime,
    `/api/knowhow/export?${new URLSearchParams({ jobId })}`,
  );
  expect(
    exportStatus.payload.jobId === jobId &&
      exportStatus.payload.status === "queued",
    "EXPORT_ISOLATION_INVALID",
    "A background worker unexpectedly consumed the isolated restore export.",
  );
  const afterExport = await bootstrap(runtime);
  expect(
    auditSequence(afterExport) === before + 3,
    "EXPORT_AUDIT_SEQUENCE_INVALID",
    "The restored application did not append exactly one export audit event.",
  );
  assertAuditEvent(afterExport, before + 3, "guide.export-requested");
  return {
    auditSequenceBefore: before,
    auditSequenceAfterCompletion: before + 1,
    auditSequenceAfterAuditExport: before + 2,
    auditSequenceAfterExportCreation: before + 3,
    exportJobFingerprint: hmacFingerprint(
      hmacKey,
      "restore-export-job",
      jobId,
    ),
  };
}

async function revokeSession(runtime) {
  if (!runtime.signedIn) return;
  const encodedSession = runtime.jar.value(
    `a_session_${runtime.configuration.expectedProjectId}`,
  );
  expect(
    typeof encodedSession === "string" && encodedSession.length > 0,
    "SESSION_COOKIE_MISSING",
    "The restored-application actor has no Appwrite session cookie to revoke.",
  );
  let session;
  try {
    session = decodeURIComponent(encodedSession);
  } catch {
    gateFailure(
      "SESSION_COOKIE_INVALID",
      "The restored-application Appwrite session cookie is invalid.",
    );
  }
  await requestJson(runtime, "/api/auth/sign-out", {
    method: "POST",
    origin: runtime.configuration.siteOrigin,
    headers: csrfHeaders(runtime),
    body: {},
  });
  await requestJson(runtime, "/api/auth/session", {
    expectedStatuses: [401],
  });
  const account = new Account(
    new Client()
      .setEndpoint(runtime.configuration.endpoint)
      .setProject(runtime.configuration.expectedProjectId)
      .setSession(session),
  );
  try {
    await account.get();
  } catch (error) {
    if (error instanceof AppwriteException && Number(error.code) === 401) {
      runtime.signedIn = false;
      return;
    }
    throw error;
  }
  gateFailure(
    "SERVER_SESSION_NOT_REVOKED",
    "The restored-application Appwrite server session remains valid after sign-out.",
  );
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      gateFailure(
        "EVIDENCE_PATH_EXISTS",
        "Restored-application evidence is immutable; choose a new output path.",
      );
    }
    throw error;
  }
}

async function readJsonFile(path, missingCode, invalidCode) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      gateFailure(missingCode, "A required private evidence file was not found.");
    }
    gateFailure(invalidCode, "A required private evidence file is not valid JSON.");
  }
}

async function readVerifiedEvidenceChain(configuration) {
  const [sealedRestoreReport, sealedApplicationReport] = await Promise.all([
    readJsonFile(
      configuration.restoreReportPath,
      "RESTORE_REPORT_NOT_FOUND",
      "RESTORE_REPORT_INVALID",
    ),
    readJsonFile(
      configuration.applicationReportPath,
      "APPLICATION_REPORT_NOT_FOUND",
      "APPLICATION_REPORT_INVALID",
    ),
  ]);
  const restoreReport = openRestoreReport(sealedRestoreReport, configuration);
  const application = openApplicationEvidence(
    sealedApplicationReport,
    configuration.hmacKey,
    configuration.hmacKeyId,
  );
  expect(
    application.environment === configuration.environment &&
      application.release === configuration.release &&
      application.siteOrigin === configuration.siteOrigin &&
      application.sourceSiteOrigin === configuration.sourceSiteOrigin &&
      application.projectFingerprint ===
        projectFingerprint(configuration.expectedProjectId) &&
      application.databaseFingerprint ===
        databaseFingerprint(configuration.databaseId) &&
      application.restorationFingerprint ===
        restorationFingerprint(configuration.restorationId) &&
      application.disposableSiteFingerprint ===
        siteFingerprint(configuration.disposableSiteId),
    "APPLICATION_REPORT_BINDING_MISMATCH",
    "The saved restored-application evidence belongs to another environment, release, Site, project, database, or restoration.",
  );
  expect(
    application.sourceRestoreEvidence.reportSha256 ===
      restoreReportFingerprint(sealedRestoreReport) &&
      application.sourceRestoreEvidence.databaseOverallSha256 ===
        restoreReport.database.overallSha256 &&
      application.sourceRestoreEvidence.verifiedAt === restoreReport.verifiedAt &&
      application.sourceRestoreEvidence.archiveFingerprint ===
        hmacFingerprint(
          configuration.hmacKey,
          "restore-archive",
          restoreReport.source.archiveId,
        ) &&
      application.timing.incidentAt === restoreReport.timing.incidentAt,
    "RESTORE_REPORT_CHAIN_MISMATCH",
    "The saved application evidence is not chained to the supplied sealed restore report.",
  );
  return {
    sealedRestoreReport,
    sealedApplicationReport,
    restoreReport,
    application,
  };
}

async function captureApplicationEvidence() {
  const configuration = restoreApplicationConfiguration();
  const sealedRestoreReport = await readJsonFile(
    configuration.restoreReportPath,
    "RESTORE_REPORT_NOT_FOUND",
    "RESTORE_REPORT_INVALID",
  );
  const restoreReport = openRestoreReport(sealedRestoreReport, configuration);
  const startedAt = new Date().toISOString();
  expect(
    Date.parse(startedAt) >= Date.parse(restoreReport.verifiedAt),
    "RESTORE_APPLICATION_ORDER_INVALID",
    "Application verification must run after the sealed database restore verification.",
  );
  const anonymous = runtimeFor(configuration);
  const runtimes = configuration.actors.map((actor) =>
    runtimeFor(configuration, actor),
  );
  let primaryError;
  let readinessReachedAt;
  let anonymousApiDenials = 0;
  let transaction;
  try {
    await assertAccessBoundary(anonymous);
    readinessReachedAt = await assertDeployment(anonymous);
    anonymousApiDenials = await assertAnonymousDenials(anonymous);
    const authentication = await Promise.allSettled(
      runtimes.map((runtime) =>
        authenticate(runtime, configuration.actors),
      ),
    );
    const failedAuthentication = authentication.find(
      (result) => result.status === "rejected",
    );
    if (failedAuthentication) throw failedAuthentication.reason;
    const bootstraps = authentication.map((result) => result.value);
    assertMetadataOnlyBoundary(bootstraps[0], configuration.actors[1]);
    await assertCrossTenantDenials(runtimes);
    transaction = await verifyTransactionalApplicationFlow(
      runtimes[0],
      configuration.hmacKey,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanup = await Promise.allSettled(
      runtimes.map((runtime) => revokeSession(runtime)),
    );
    const cleanupFailure = cleanup.find((result) => result.status === "rejected");
    if (cleanupFailure) {
      primaryError = new RestoreApplicationError(
        "SESSION_CLEANUP_FAILED",
        "The restored-application gate could not revoke every synthetic server session.",
      );
    }
  }
  if (primaryError) throw primaryError;

  const applicationVerifiedAt = new Date().toISOString();
  const applicationRtoSeconds = Math.floor(
    (Date.parse(applicationVerifiedAt) -
      Date.parse(restoreReport.timing.incidentAt)) /
      1_000,
  );
  expect(
    applicationRtoSeconds >= 0 &&
      applicationRtoSeconds <= configuration.rtoTargetSeconds,
    "APPLICATION_RTO_MISSED",
    "The restored application exceeded the 24-hour internal RTO target.",
  );
  const requestIds = [
    ...anonymous.requestIds,
    ...runtimes.flatMap((runtime) => runtime.requestIds),
  ];
  const payload = {
    evidenceVersion: 1,
    kind: "knowhow-restored-application-evidence",
    status: "passed",
    environment: "production",
    release: configuration.release,
    siteOrigin: configuration.siteOrigin,
    sourceSiteOrigin: configuration.sourceSiteOrigin,
    projectFingerprint: projectFingerprint(configuration.expectedProjectId),
    databaseFingerprint: databaseFingerprint(configuration.databaseId),
    restorationFingerprint: restorationFingerprint(
      configuration.restorationId,
    ),
    disposableSiteFingerprint: siteFingerprint(
      configuration.disposableSiteId,
    ),
    startedAt,
    readinessReachedAt,
    applicationVerifiedAt,
    generatedAt: new Date().toISOString(),
    sourceRestoreEvidence: {
      reportSha256: restoreReportFingerprint(sealedRestoreReport),
      databaseOverallSha256: restoreReport.database.overallSha256,
      verifiedAt: restoreReport.verifiedAt,
      archiveFingerprint: hmacFingerprint(
        configuration.hmacKey,
        "restore-archive",
        restoreReport.source.archiveId,
      ),
    },
    actors: configuration.actors.map((actor) =>
      contentFreeActor(actor, configuration.hmacKey),
    ),
    checks: {
      accessBoundary: "denied-without-secret",
      readinessBinding: "exact",
      verifiedMfaSessions: runtimes.length,
      ownTenantReads: runtimes.length,
      organizationMetadataOnlyBoundary: "passed",
      crossTenantBootstrapDenials: runtimes.length,
      crossTenantSearchDenials: runtimes.length,
      crossTenantMediaDenials: runtimes.length,
      transactionalMutation: "committed",
      idempotentReplay: "passed",
      auditChain: "sequential",
      exportCreation: "queued",
      anonymousApiDenials,
    },
    transaction,
    timing: {
      incidentAt: restoreReport.timing.incidentAt,
      rtoTargetSeconds: configuration.rtoTargetSeconds,
      applicationRtoSeconds,
      applicationRtoSatisfied: true,
    },
    correlation: {
      responseCount: requestIds.length,
      requestIdsSha256: requestIdDigest(requestIds),
    },
    cleanup: {
      serverSessionsRevoked: runtimes.length,
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
  const sealed = sealApplicationEvidence(
    payload,
    configuration.hmacKey,
    configuration.hmacKeyId,
  );
  await writeEvidence(configuration.applicationReportPath, sealed);
  return {
    status: "passed",
    environment: payload.environment,
    release: payload.release,
    projectFingerprint: payload.projectFingerprint,
    databaseFingerprint: payload.databaseFingerprint,
    restorationFingerprint: payload.restorationFingerprint,
    disposableSiteFingerprint: payload.disposableSiteFingerprint,
    timing: payload.timing,
    checks: payload.checks,
    cleanup: payload.cleanup,
    correlation: payload.correlation,
    reportPath: configuration.applicationReportPath,
    evidenceKeyId: configuration.hmacKeyId,
  };
}

export async function verifySavedApplicationEvidence() {
  const configuration = restoreApplicationVerificationConfiguration();
  const { application } = await readVerifiedEvidenceChain(configuration);
  return {
    status: "passed",
    environment: application.environment,
    release: application.release,
    projectFingerprint: application.projectFingerprint,
    databaseFingerprint: application.databaseFingerprint,
    restorationFingerprint: application.restorationFingerprint,
    disposableSiteFingerprint: application.disposableSiteFingerprint,
    timing: application.timing,
    checks: application.checks,
    cleanup: application.cleanup,
    correlation: application.correlation,
    reportPath: configuration.applicationReportPath,
    evidenceKeyId: configuration.hmacKeyId,
  };
}

async function expectAppwritePresent(operation, code, message) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof AppwriteException && Number(error.code) === 404) {
      gateFailure(code, message);
    }
    throw error;
  }
}

async function expectAppwriteAbsent(operation, code, message) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof AppwriteException && Number(error.code) === 404) return;
    throw error;
  }
  gateFailure(code, message);
}

async function captureRestoreCleanupEvidence() {
  const configuration = restoreCleanupConfiguration();
  const chain = await readVerifiedEvidenceChain(configuration);
  const client = new Client()
    .setEndpoint(configuration.endpoint)
    .setProject(configuration.projectId)
    .setKey(configuration.apiKey);
  const tables = new TablesDB(client);
  const sites = new Sites(client);
  await Promise.all([
    expectAppwritePresent(
      () => tables.get({ databaseId: "knowhow_core" }),
      "SOURCE_DATABASE_MISSING",
      "The Production source database is missing after restore cleanup.",
    ),
    expectAppwritePresent(
      () => sites.get({ siteId: "knowhow_web" }),
      "SOURCE_SITE_MISSING",
      "The stable Production Site is missing after restore cleanup.",
    ),
    expectAppwriteAbsent(
      () => tables.get({ databaseId: configuration.databaseId }),
      "RESTORED_DATABASE_STILL_PRESENT",
      "The isolated restored database still exists.",
    ),
    expectAppwriteAbsent(
      () => sites.get({ siteId: configuration.disposableSiteId }),
      "DISPOSABLE_SITE_STILL_PRESENT",
      "The disposable restored-application Site still exists.",
    ),
  ]);
  const verifiedAt = new Date().toISOString();
  expect(
    Date.parse(verifiedAt) >= Date.parse(chain.application.generatedAt),
    "RESTORE_CLEANUP_ORDER_INVALID",
    "Restore cleanup evidence must follow application verification.",
  );
  const payload = {
    evidenceVersion: 1,
    kind: "knowhow-restore-cleanup-evidence",
    status: "passed",
    environment: "production",
    release: configuration.release,
    verifiedAt,
    projectFingerprint: projectFingerprint(configuration.expectedProjectId),
    databaseFingerprint: databaseFingerprint(configuration.databaseId),
    restorationFingerprint: restorationFingerprint(
      configuration.restorationId,
    ),
    disposableSiteFingerprint: siteFingerprint(
      configuration.disposableSiteId,
    ),
    evidenceChain: {
      restoreReportSha256: restoreReportFingerprint(
        chain.sealedRestoreReport,
      ),
      applicationReportSha256: restoreReportFingerprint(
        chain.sealedApplicationReport,
      ),
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
  const sealed = sealRestoreCleanupEvidence(
    payload,
    configuration.hmacKey,
    configuration.hmacKeyId,
  );
  await writeEvidence(configuration.cleanupReportPath, sealed);
  return {
    status: "passed",
    environment: payload.environment,
    release: payload.release,
    projectFingerprint: payload.projectFingerprint,
    databaseFingerprint: payload.databaseFingerprint,
    restorationFingerprint: payload.restorationFingerprint,
    disposableSiteFingerprint: payload.disposableSiteFingerprint,
    checks: payload.checks,
    attestations: payload.attestations,
    remainingActions: payload.remainingActions,
    reportPath: configuration.cleanupReportPath,
    evidenceKeyId: configuration.hmacKeyId,
  };
}

export async function verifySavedRestoreCleanupEvidence() {
  const configuration = restoreCleanupVerificationConfiguration();
  const chain = await readVerifiedEvidenceChain(configuration);
  const sealedCleanup = await readJsonFile(
    configuration.cleanupReportPath,
    "RESTORE_CLEANUP_REPORT_NOT_FOUND",
    "RESTORE_CLEANUP_REPORT_INVALID",
  );
  const cleanup = openRestoreCleanupEvidence(
    sealedCleanup,
    configuration.hmacKey,
    configuration.hmacKeyId,
  );
  expect(
    cleanup.environment === configuration.environment &&
      cleanup.release === configuration.release &&
      cleanup.projectFingerprint ===
        projectFingerprint(configuration.expectedProjectId) &&
      cleanup.databaseFingerprint ===
        databaseFingerprint(configuration.databaseId) &&
      cleanup.restorationFingerprint ===
        restorationFingerprint(configuration.restorationId) &&
      cleanup.disposableSiteFingerprint ===
        siteFingerprint(configuration.disposableSiteId),
    "RESTORE_CLEANUP_BINDING_MISMATCH",
    "The saved cleanup evidence belongs to another release, project, restored database, restoration, or disposable Site.",
  );
  expect(
    cleanup.evidenceChain.restoreReportSha256 ===
      restoreReportFingerprint(chain.sealedRestoreReport) &&
      cleanup.evidenceChain.applicationReportSha256 ===
        restoreReportFingerprint(chain.sealedApplicationReport) &&
      cleanup.disposableSiteFingerprint ===
        chain.application.disposableSiteFingerprint &&
      Date.parse(cleanup.verifiedAt) >=
        Date.parse(chain.application.generatedAt),
    "RESTORE_CLEANUP_CHAIN_MISMATCH",
    "The saved cleanup evidence is not chained to the supplied restore and application reports.",
  );
  return {
    status: "passed",
    environment: cleanup.environment,
    release: cleanup.release,
    projectFingerprint: cleanup.projectFingerprint,
    databaseFingerprint: cleanup.databaseFingerprint,
    restorationFingerprint: cleanup.restorationFingerprint,
    disposableSiteFingerprint: cleanup.disposableSiteFingerprint,
    checks: cleanup.checks,
    attestations: cleanup.attestations,
    remainingActions: cleanup.remainingActions,
    reportPath: configuration.cleanupReportPath,
    evidenceKeyId: configuration.hmacKeyId,
  };
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry && entry === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const operation =
    command === undefined || command === "capture"
      ? captureApplicationEvidence()
      : command === "verify"
        ? verifySavedApplicationEvidence()
        : command === "cleanup"
          ? captureRestoreCleanupEvidence()
          : command === "cleanup-verify"
            ? verifySavedRestoreCleanupEvidence()
        : Promise.reject(
            new RestoreApplicationError(
              "COMMAND_INVALID",
              "Use `capture`, `verify`, `cleanup`, or `cleanup-verify` for the corresponding restored-application evidence gate.",
            ),
          );
  operation
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
      process.exitCode = 1;
    });
}
