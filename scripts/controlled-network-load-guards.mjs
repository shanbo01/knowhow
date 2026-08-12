import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { exactControlledAppwriteEndpoint } from "./controlled-appwrite-endpoint.mjs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RELEASE_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;
const EXTENSION_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export class ControlledNetworkLoadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ControlledNetworkLoadError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ControlledNetworkLoadError(code, message);
}

function requireCondition(condition, code, message) {
  if (!condition) fail(code, message);
}

function value(environment, name) {
  const candidate = environment[name]?.trim();
  requireCondition(candidate, "CONFIGURATION_REQUIRED", `${name} is required.`);
  return candidate;
}

function integer(environment, name, fallback, minimum, maximum) {
  const raw = environment[name]?.trim();
  const candidate = raw ? Number(raw) : fallback;
  requireCondition(
    Number.isSafeInteger(candidate) && candidate >= minimum && candidate <= maximum,
    "CONFIGURATION_INVALID",
    `${name} must be an integer from ${minimum} through ${maximum}.`,
  );
  return candidate;
}

function milliseconds(environment, name, fallback, minimum, maximum) {
  return integer(environment, name, fallback, minimum, maximum);
}

export function exactControlledSiteOrigin(raw) {
  requireCondition(
    /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(raw),
    "SITE_ORIGIN_INVALID",
    "The controlled Site origin must be an exact lowercase HTTPS hostname origin.",
  );
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("SITE_ORIGIN_INVALID", "The controlled Site origin is not a valid URL.");
  }
  requireCondition(
    parsed.origin === raw &&
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.hostname.includes(".") &&
      parsed.hostname !== "localhost",
    "SITE_ORIGIN_INVALID",
    "The controlled Site origin must not contain credentials, a port, path, query, or fragment.",
  );
  return parsed.origin;
}

function exactApprovedEndpoint(raw, residency) {
  const endpoint = exactControlledAppwriteEndpoint(raw, residency);
  requireCondition(
    endpoint,
    "APPWRITE_ENDPOINT_NOT_FRANKFURT",
    "Controlled network load accepts only an exact approved Frankfurt Cloud or Azure Qatar Central endpoint.",
  );
  return endpoint;
}

function parseActors(raw, emailDomain) {
  let candidates;
  try {
    candidates = JSON.parse(raw);
  } catch {
    fail("ACTORS_INVALID", "KNOWHOW_NETWORK_LOAD_ACTORS_JSON is not valid JSON.");
  }
  requireCondition(Array.isArray(candidates), "ACTORS_INVALID", "Controlled load actors must be a JSON array.");
  const actors = candidates.map((candidate, index) => {
    requireCondition(
      candidate && typeof candidate === "object" && !Array.isArray(candidate),
      "ACTORS_INVALID",
      `Controlled load actor ${index + 1} must be an object.`,
    );
    const actor = {
      label: String(candidate.label ?? "").trim(),
      email: String(candidate.email ?? "").trim().toLowerCase(),
      password: String(candidate.password ?? ""),
      totpSecret: String(candidate.totpSecret ?? "").trim(),
      workspaceId: String(candidate.workspaceId ?? "").trim(),
      expectedGuideId: String(candidate.expectedGuideId ?? "").trim(),
      searchQuery: String(candidate.searchQuery ?? "").trim(),
    };
    requireCondition(LABEL_PATTERN.test(actor.label), "ACTORS_INVALID", `Controlled load actor ${index + 1} has an invalid label.`);
    requireCondition(
      /^[^\s@]{1,64}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(actor.email) &&
        actor.email.endsWith(`@${emailDomain}`),
      "ACTORS_NOT_SYNTHETIC",
      `Controlled load actor ${index + 1} is not in the dedicated synthetic email domain.`,
    );
    requireCondition(
      actor.password.length >= 12 && actor.password.length <= 1_024,
      "ACTORS_INVALID",
      `Controlled load actor ${index + 1} has an invalid password secret.`,
    );
    requireCondition(
      actor.totpSecret.length >= 16 && actor.totpSecret.length <= 2_048,
      "ACTORS_INVALID",
      `Controlled load actor ${index + 1} has an invalid TOTP secret.`,
    );
    requireCondition(ID_PATTERN.test(actor.workspaceId), "ACTORS_INVALID", `Controlled load actor ${index + 1} has an invalid workspace ID.`);
    requireCondition(ID_PATTERN.test(actor.expectedGuideId), "ACTORS_INVALID", `Controlled load actor ${index + 1} has an invalid expected guide ID.`);
    requireCondition(
      actor.searchQuery.length >= 2 && actor.searchQuery.length <= 100,
      "ACTORS_INVALID",
      `Controlled load actor ${index + 1} has an invalid search query.`,
    );
    return actor;
  });
  for (const [name, entries] of [
    ["labels", actors.map((actor) => actor.label)],
    ["emails", actors.map((actor) => actor.email)],
    ["workspace IDs", actors.map((actor) => actor.workspaceId)],
    ["expected guide IDs", actors.map((actor) => actor.expectedGuideId)],
  ]) {
    requireCondition(new Set(entries).size === actors.length, "ACTORS_INVALID", `Controlled load actor ${name} must be distinct.`);
  }
  return actors;
}

export function controlledNetworkLoadConfiguration(environment = process.env) {
  const target = value(environment, "KNOWHOW_NETWORK_LOAD_ENVIRONMENT");
  requireCondition(
    target === "staging" || target === "production",
    "ENVIRONMENT_INVALID",
    "Controlled network load runs only against Staging or Production.",
  );
  const siteOrigin = exactControlledSiteOrigin(value(environment, "KNOWHOW_NETWORK_LOAD_SITE_ORIGIN"));
  const endpoint = exactApprovedEndpoint(
    value(environment, "APPWRITE_ENDPOINT"),
    environment.KNOWHOW_APPWRITE_RESIDENCY ?? "",
  );
  const expectedProjectId = value(environment, "KNOWHOW_NETWORK_LOAD_EXPECTED_PROJECT_ID");
  const forbiddenProjectId = value(environment, "KNOWHOW_NETWORK_LOAD_FORBIDDEN_PROJECT_ID");
  requireCondition(
    ID_PATTERN.test(expectedProjectId) && ID_PATTERN.test(forbiddenProjectId) && expectedProjectId !== forbiddenProjectId,
    "PROJECT_BINDING_INVALID",
    "Controlled load requires distinct, valid reviewed Staging and Production project IDs.",
  );
  const release = value(environment, "KNOWHOW_NETWORK_LOAD_EXPECTED_RELEASE");
  requireCondition(RELEASE_PATTERN.test(release), "RELEASE_INVALID", "Controlled load requires the exact 40-character release SHA.");
  requireCondition(
    environment.KNOWHOW_NETWORK_LOAD_CONFIRM?.trim() === `${target}-synthetic-network-load`,
    "MUTATION_CONFIRMATION_REQUIRED",
    `Set KNOWHOW_NETWORK_LOAD_CONFIRM=${target}-synthetic-network-load for this dedicated synthetic run.`,
  );
  requireCondition(
    environment.KNOWHOW_NETWORK_LOAD_SYNTHETIC_ONLY === "1" &&
      environment.KNOWHOW_NETWORK_LOAD_DEDICATED_ACTORS === "1",
    "SYNTHETIC_ATTESTATION_REQUIRED",
    "Controlled load requires synthetic-only, dedicated-actor attestations.",
  );
  if (target === "production") {
    requireCondition(
      environment.KNOWHOW_NETWORK_LOAD_FINAL_PRODUCTION === "1",
      "PRODUCTION_ATTESTATION_REQUIRED",
      "Production load requires the final-Production attestation.",
    );
  }
  const extensionOrigin = value(environment, "KNOWHOW_NETWORK_LOAD_EXTENSION_ORIGIN");
  requireCondition(EXTENSION_ORIGIN_PATTERN.test(extensionOrigin), "EXTENSION_ORIGIN_INVALID", "Controlled load requires one exact Chromium extension origin.");
  const extensionVersion = value(environment, "KNOWHOW_NETWORK_LOAD_EXTENSION_VERSION");
  requireCondition(EXTENSION_VERSION_PATTERN.test(extensionVersion), "EXTENSION_VERSION_INVALID", "Controlled load requires an exact extension version.");
  const emailDomain = value(environment, "KNOWHOW_NETWORK_LOAD_SYNTHETIC_EMAIL_DOMAIN").toLowerCase();
  requireCondition(
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(emailDomain) && emailDomain.includes("."),
    "SYNTHETIC_DOMAIN_INVALID",
    "The synthetic load email domain is invalid.",
  );
  const actors = parseActors(value(environment, "KNOWHOW_NETWORK_LOAD_ACTORS_JSON"), emailDomain);
  const expectedTenants = integer(
    environment,
    "KNOWHOW_NETWORK_LOAD_EXPECTED_TENANTS",
    target === "staging" ? 3 : 2,
    target === "staging" ? 3 : 2,
    target === "staging" ? 8 : 2,
  );
  requireCondition(actors.length === expectedTenants, "ACTOR_COUNT_INVALID", `Controlled load requires exactly ${expectedTenants} dedicated tenant actors.`);
  const minimumMembers = integer(
    environment,
    "KNOWHOW_NETWORK_LOAD_MINIMUM_MEMBERS",
    target === "staging" ? 100 : 1,
    target === "staging" ? 100 : 1,
    10_000,
  );
  const readersPerTenant = integer(environment, "KNOWHOW_NETWORK_LOAD_READERS_PER_TENANT", 110, 101, 119);
  requireCondition(
    readersPerTenant + actors.length <= 120,
    "SEARCH_RATE_BUDGET_INVALID",
    "Reader load plus warm-up and cross-tenant probes must stay within the 120-request user window.",
  );
  const capturesPerTenant = integer(environment, "KNOWHOW_NETWORK_LOAD_CAPTURES_PER_TENANT", 12, 1, 50);
  const requestTimeoutMs = milliseconds(environment, "KNOWHOW_NETWORK_LOAD_REQUEST_TIMEOUT_MS", 30_000, 5_000, 120_000);
  const searchP95BudgetMs = milliseconds(environment, "KNOWHOW_NETWORK_LOAD_SEARCH_P95_MS", 2_000, 100, 120_000);
  const captureP95BudgetMs = milliseconds(environment, "KNOWHOW_NETWORK_LOAD_CAPTURE_P95_MS", 10_000, 500, 180_000);
  return {
    target,
    endpoint,
    siteOrigin,
    expectedProjectId,
    forbiddenProjectId,
    release,
    extensionOrigin,
    extensionVersion,
    emailDomain,
    actors,
    expectedTenants,
    minimumMembers,
    readersPerTenant,
    capturesPerTenant,
    requestTimeoutMs,
    searchP95BudgetMs,
    captureP95BudgetMs,
  };
}

export function contentFreeActor(actor, key, observedMemberCount) {
  return {
    actorFingerprint: createHmac("sha256", key).update(`actor\0${actor.label}`).digest("hex"),
    workspaceFingerprint: createHmac("sha256", key).update(`workspace\0${actor.workspaceId}`).digest("hex"),
    expectedGuideFingerprint: createHmac("sha256", key).update(`guide\0${actor.expectedGuideId}`).digest("hex"),
    observedMemberCount,
  };
}

export function projectFingerprint(projectId) {
  return createHash("sha256").update(`project\0${projectId}`).digest("hex");
}

export function percentile(samples, fraction) {
  assert.ok(Array.isArray(samples) && samples.length > 0, "Latency samples are required.");
  assert.ok(fraction > 0 && fraction <= 1, "Percentile fraction is invalid.");
  const ordered = samples.map(Number).sort((left, right) => left - right);
  assert.ok(ordered.every((sample) => Number.isFinite(sample) && sample >= 0), "Latency samples are invalid.");
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

export function latencySummary(samples, totalOperations, failures) {
  assert.ok(Number.isSafeInteger(totalOperations) && totalOperations > 0, "Operation count is invalid.");
  assert.ok(Number.isSafeInteger(failures) && failures >= 0 && failures <= totalOperations, "Failure count is invalid.");
  assert.equal(samples.length + failures, totalOperations, "Latency and failure accounting is incomplete.");
  const round = (number) => Number(number.toFixed(1));
  return {
    operations: totalOperations,
    succeeded: samples.length,
    failed: failures,
    errorRate: Number((failures / totalOperations).toFixed(6)),
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    p99Ms: round(percentile(samples, 0.99)),
    maxMs: round(Math.max(...samples)),
  };
}

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    requireCondition(Number.isFinite(value), "EVIDENCE_INVALID", "Evidence contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => {
        requireCondition(item !== undefined, "EVIDENCE_INVALID", "Evidence contains an undefined value.");
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(",")}}`;
  }
  fail("EVIDENCE_INVALID", "Evidence contains an unsupported value.");
}

export function evidenceKey(environment = process.env) {
  const key = value(environment, "KNOWHOW_NETWORK_LOAD_EVIDENCE_HMAC_KEY");
  const keyId = value(environment, "KNOWHOW_NETWORK_LOAD_EVIDENCE_HMAC_KEY_ID");
  requireCondition(
    Buffer.byteLength(key, "utf8") >= 32 &&
      !key.toLowerCase().includes("replace-with-") &&
      KEY_ID_PATTERN.test(keyId),
    "EVIDENCE_KEY_INVALID",
    "The controlled-load evidence HMAC key or key ID is invalid.",
  );
  return { key, keyId };
}

export function sealNetworkLoadEvidence(payload, key, keyId) {
  return {
    ...payload,
    seal: {
      algorithm: "HMAC-SHA-256",
      keyId,
      hmac: createHmac("sha256", key).update(canonicalJson(payload)).digest("hex"),
    },
  };
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) ===
      canonicalJson([...expected].sort())
  );
}

function validIso(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function verifyNetworkLoadEvidence(evidence, key, expectedKeyId) {
  requireCondition(Buffer.byteLength(key, "utf8") >= 32, "EVIDENCE_KEY_INVALID", "The controlled-load evidence HMAC key is invalid.");
  requireCondition(
    evidence?.seal?.algorithm === "HMAC-SHA-256" &&
      evidence.seal.keyId === expectedKeyId &&
      SHA256_PATTERN.test(String(evidence.seal.hmac)),
    "EVIDENCE_SEAL_INVALID",
    "The controlled-load evidence seal is missing, malformed, or uses another key ID.",
  );
  const payload = { ...evidence };
  delete payload.seal;
  const expected = createHmac("sha256", key).update(canonicalJson(payload)).digest();
  const actual = Buffer.from(evidence.seal.hmac, "hex");
  requireCondition(
    actual.length === expected.length && timingSafeEqual(actual, expected),
    "EVIDENCE_SEAL_MISMATCH",
    "The controlled-load evidence seal does not match its contents.",
  );
  const boundary = payload.boundary;
  const search = payload.measurements?.authorizedSearch;
  const capture = payload.measurements?.redactedCaptureUploadDiscard;
  const expectedSearchOperations = boundary?.tenantActors * boundary?.virtualReadersPerTenant;
  const expectedCaptureOperations = boundary?.tenantActors * boundary?.captureUploadPipelinesPerTenant;
  const validStatistics = (statistics, operations, budget) =>
    exactKeys(statistics, [
      "operations",
      "succeeded",
      "failed",
      "errorRate",
      "p50Ms",
      "p95Ms",
      "p99Ms",
      "maxMs",
    ]) &&
    statistics.operations === operations &&
    statistics?.succeeded === operations &&
    statistics?.failed === 0 &&
    statistics?.errorRate === 0 &&
    [statistics?.p50Ms, statistics?.p95Ms, statistics?.p99Ms, statistics?.maxMs].every(
      (candidate) => Number.isFinite(candidate) && candidate >= 0,
    ) &&
    statistics.p50Ms <= statistics.p95Ms &&
    statistics.p95Ms <= statistics.p99Ms &&
    statistics.p99Ms <= statistics.maxMs &&
    statistics.p95Ms <= budget;
  const tenantFingerprints = Array.isArray(payload.tenants)
    ? payload.tenants.flatMap((tenant) => [
        tenant.actorFingerprint,
        tenant.workspaceFingerprint,
        tenant.expectedGuideFingerprint,
      ])
    : [];
  requireCondition(
    exactKeys(payload, [
      "evidenceVersion",
      "kind",
      "status",
      "generatedAt",
      "startedAt",
      "durationMs",
      "environment",
      "release",
      "siteOrigin",
      "projectFingerprint",
      "boundary",
      "tenants",
      "measurements",
      "correlation",
      "cleanup",
      "assertions",
      "externalObservationsRequired",
    ]) &&
      payload.evidenceVersion === 1 &&
      payload.kind === "knowhow-controlled-network-load-evidence" &&
      payload.status === "passed" &&
      validIso(payload.startedAt) &&
      validIso(payload.generatedAt) &&
      Date.parse(payload.generatedAt) >= Date.parse(payload.startedAt) &&
      Number.isSafeInteger(payload.durationMs) &&
      payload.durationMs >= 0 &&
      Date.parse(payload.generatedAt) - Date.parse(payload.startedAt) >=
        payload.durationMs &&
      Date.parse(payload.generatedAt) - Date.parse(payload.startedAt) -
        payload.durationMs <= 1_000 &&
      (payload.environment === "staging" || payload.environment === "production") &&
      RELEASE_PATTERN.test(String(payload.release)) &&
      SHA256_PATTERN.test(String(payload.projectFingerprint)) &&
      exactKeys(boundary, [
        "tenantActors",
        "minimumMembersPerTenant",
        "virtualReadersPerTenant",
        "captureUploadPipelinesPerTenant",
        "extensionVersion",
        "searchP95BudgetMs",
        "captureP95BudgetMs",
      ]) &&
      Number.isSafeInteger(boundary?.tenantActors) &&
      (payload.environment === "production" ? boundary.tenantActors === 2 : boundary.tenantActors >= 3) &&
      Array.isArray(payload.tenants) &&
      boundary.tenantActors === payload.tenants.length &&
      Number.isSafeInteger(boundary?.minimumMembersPerTenant) &&
      (payload.environment === "production" ? boundary.minimumMembersPerTenant >= 1 : boundary.minimumMembersPerTenant >= 100) &&
      Number.isSafeInteger(boundary?.virtualReadersPerTenant) &&
      boundary.virtualReadersPerTenant >= 101 &&
      boundary.virtualReadersPerTenant <= 119 &&
      Number.isSafeInteger(boundary?.captureUploadPipelinesPerTenant) &&
      boundary.captureUploadPipelinesPerTenant >= 1 &&
      boundary.captureUploadPipelinesPerTenant <= 50 &&
      EXTENSION_VERSION_PATTERN.test(String(boundary.extensionVersion ?? "")) &&
      Number.isSafeInteger(boundary.searchP95BudgetMs) &&
      boundary.searchP95BudgetMs >= 100 &&
      boundary.searchP95BudgetMs <= 120_000 &&
      Number.isSafeInteger(boundary.captureP95BudgetMs) &&
      boundary.captureP95BudgetMs >= 500 &&
      boundary.captureP95BudgetMs <= 180_000 &&
      payload.tenants.every(
        (tenant) =>
          exactKeys(tenant, [
            "actorFingerprint",
            "workspaceFingerprint",
            "expectedGuideFingerprint",
            "observedMemberCount",
          ]) &&
          SHA256_PATTERN.test(String(tenant.actorFingerprint)) &&
          SHA256_PATTERN.test(String(tenant.workspaceFingerprint)) &&
          SHA256_PATTERN.test(String(tenant.expectedGuideFingerprint)) &&
          Number.isSafeInteger(tenant.observedMemberCount) &&
          tenant.observedMemberCount >= boundary.minimumMembersPerTenant,
      ) &&
      new Set(tenantFingerprints).size === tenantFingerprints.length &&
      exactKeys(payload.measurements, [
        "authorizedSearch",
        "redactedCaptureUploadDiscard",
      ]) &&
      validStatistics(search, expectedSearchOperations, boundary.searchP95BudgetMs) &&
      validStatistics(capture, expectedCaptureOperations, boundary.captureP95BudgetMs) &&
      exactKeys(payload.cleanup, [
        "capturePipelinesDiscarded",
        "dedicatedExtensionActorsRevoked",
        "serverSessionsRevoked",
        "retainedSyntheticRows",
      ]) &&
      payload.cleanup.capturePipelinesDiscarded === expectedCaptureOperations &&
      payload.cleanup?.dedicatedExtensionActorsRevoked === boundary.tenantActors &&
      payload.cleanup?.serverSessionsRevoked === boundary.tenantActors &&
      payload.cleanup?.retainedSyntheticRows ===
        "discarded/quarantined rows remain inside the dedicated synthetic tenants until the approved environment cleanup or final Production purge" &&
      exactKeys(payload.correlation, [
        "responseCount",
        "requestIdsSha256",
      ]) &&
      Number.isSafeInteger(payload.correlation?.responseCount) &&
      payload.correlation.responseCount >= expectedSearchOperations + expectedCaptureOperations * 4 &&
      SHA256_PATTERN.test(String(payload.correlation?.requestIdsSha256)) &&
      canonicalJson(payload.assertions) ===
        canonicalJson([
          "exact environment, project fingerprint, and release readiness matched",
          "every actor resolved only its configured workspace and synthetic member boundary",
          "cross-tenant workspace probes returned only 403 or 404",
          "every own-tenant search contained its sentinel and no other tenant sentinel",
          "every redacted screenshot upload was discarded idempotently",
          "all dedicated extension credentials and server sessions were revoked",
          "all response correlation IDs were preserved and measurement budgets passed",
        ]) &&
      canonicalJson(payload.externalObservationsRequired) ===
        canonicalJson([
          "Appwrite Function execution failures and queue depth",
          "Appwrite database and Storage latency/error graphs",
          "Sentry error/regression dashboard for the exact load window",
        ]),
    "EVIDENCE_CONTRACT_INVALID",
    "The saved controlled-load evidence does not contain a passing supported contract.",
  );
  exactControlledSiteOrigin(payload.siteOrigin);
  return payload;
}

export function privateEvidencePath(candidate, workspace = process.cwd()) {
  requireCondition(typeof candidate === "string" && candidate.trim(), "EVIDENCE_PATH_REQUIRED", "A private controlled-load evidence path is required.");
  const workspacePath = resolve(workspace);
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(workspacePath, candidate);
  const relativeToWorkspace = relative(workspacePath, absolute);
  const insideWorkspace = relativeToWorkspace === "" || (!relativeToWorkspace.startsWith("..") && !isAbsolute(relativeToWorkspace));
  if (insideWorkspace) {
    const temporaryRoot = resolve(workspacePath, ".tmp");
    const relativeToTemporary = relative(temporaryRoot, absolute);
    requireCondition(
      relativeToTemporary !== "" && !relativeToTemporary.startsWith("..") && !isAbsolute(relativeToTemporary),
      "EVIDENCE_PATH_NOT_PRIVATE",
      "Controlled-load evidence inside the repository must be beneath the ignored .tmp directory.",
    );
  }
  return absolute;
}

export function requestIdDigest(requestIds) {
  requireCondition(
    Array.isArray(requestIds) && requestIds.length > 0 && requestIds.every((id) => /^[A-Za-z0-9._:-]{8,64}$/.test(id)),
    "REQUEST_ID_INVALID",
    "Every controlled-load response must carry a valid request ID.",
  );
  return createHash("sha256").update([...requestIds].sort().join("\n")).digest("hex");
}

export function safeFailure(error) {
  if (error instanceof ControlledNetworkLoadError) return { status: "failed", code: error.code, message: error.message };
  if (error instanceof assert.AssertionError) return { status: "failed", code: "LOAD_ASSERTION_FAILED", message: "A controlled network-load invariant failed." };
  return { status: "failed", code: "CONTROLLED_NETWORK_LOAD_FAILED", message: "The controlled network-load gate failed." };
}
