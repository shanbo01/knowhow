import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  canonicalJson,
  sealEvidence,
  verifyEvidenceSeal,
} from "./appwrite-restore-evidence.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const RESTORATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESTORE_DATABASE_ID = /^knowhow_restore_[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
const RESTORE_SITE_ID = /^knowhow_restore_web_[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;
const LABEL = /^[a-z][a-z0-9_-]{1,31}$/;
const HMAC_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EMAIL_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const RTO_TARGET_SECONDS = 24 * 60 * 60;

export class RestoreApplicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RestoreApplicationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RestoreApplicationError(code, message);
}

function requireCondition(condition, code, message) {
  if (!condition) fail(code, message);
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) fail("CONFIGURATION_REQUIRED", `${name} is required.`);
  return value;
}

function exactAttestation(environment, name) {
  requireCondition(
    environment[name] === "1",
    "ATTESTATION_REQUIRED",
    `${name}=1 is required for the isolated restore-application rehearsal.`,
  );
}

function validIso(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function projectFingerprint(projectId) {
  return sha256(`project\0${projectId}`);
}

export function restoreEvidenceProjectFingerprint(projectId) {
  return sha256(`knowhow-appwrite-project:${projectId}`);
}

export function databaseFingerprint(databaseId) {
  return sha256(`database\0${databaseId}`);
}

export function restorationFingerprint(restorationId) {
  return sha256(`restoration\0${restorationId}`);
}

export function siteFingerprint(siteId) {
  return sha256(`site\0${siteId}`);
}

export function siteOriginFingerprint(siteOrigin) {
  return sha256(`site-origin\0${siteOrigin}`);
}

function restoreSiteId(environment) {
  const siteId = required(
    environment,
    "KNOWHOW_RESTORE_APPLICATION_SITE_ID",
  );
  requireCondition(
    RESTORE_SITE_ID.test(siteId) && siteId !== "knowhow_web",
    "RESTORE_SITE_ID_INVALID",
    "The disposable restore Site ID must be a distinct knowhow_restore_web_* resource.",
  );
  return siteId;
}

export function exactSiteOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("SITE_ORIGIN_INVALID", "A restore-application Site origin is invalid.");
  }
  requireCondition(
    url.protocol === "https:" &&
      url.origin === raw &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash,
    "SITE_ORIGIN_INVALID",
    "Restore-application Site origins must be exact lowercase HTTPS origins without credentials, ports, paths, queries, fragments, or trailing slashes.",
  );
  return url.origin;
}

export function exactFrankfurtEndpoint(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("APPWRITE_ENDPOINT_INVALID", "APPWRITE_ENDPOINT is invalid.");
  }
  requireCondition(
    /^https:\/\/fra\.cloud\.appwrite\.io\/v1\/?$/.test(raw) &&
      url.protocol === "https:" &&
      url.hostname === "fra.cloud.appwrite.io" &&
      url.pathname.replace(/\/$/, "") === "/v1" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash,
    "APPWRITE_ENDPOINT_NOT_FRANKFURT",
    "Restore verification accepts only the exact Appwrite Cloud Frankfurt endpoint.",
  );
  return url.toString().replace(/\/$/, "");
}

export function privateEvidencePath(candidate, workspace = process.cwd()) {
  requireCondition(
    typeof candidate === "string" && candidate.trim().length > 0,
    "EVIDENCE_PATH_REQUIRED",
    "A private restore-application evidence path is required.",
  );
  const absolute = resolve(workspace, candidate);
  const workspacePath = resolve(workspace);
  const relativeToWorkspace = relative(workspacePath, absolute);
  const insideWorkspace =
    relativeToWorkspace === "" ||
    (!relativeToWorkspace.startsWith("..") && !isAbsolute(relativeToWorkspace));
  if (insideWorkspace) {
    const temporaryRoot = resolve(workspacePath, ".tmp");
    const relativeToTemporary = relative(temporaryRoot, absolute);
    requireCondition(
      relativeToTemporary !== "" &&
        !relativeToTemporary.startsWith("..") &&
        !isAbsolute(relativeToTemporary),
      "EVIDENCE_PATH_NOT_PRIVATE",
      "Restore-application evidence inside the repository must be beneath ignored .tmp storage.",
    );
  }
  return absolute;
}

function parsedActors(raw, syntheticDomain) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("ACTORS_JSON_INVALID", "The restore-application actor manifest is invalid JSON.");
  }
  requireCondition(
    Array.isArray(parsed) && parsed.length === 2,
    "ACTOR_BOUNDARY_INVALID",
    "The restore-application rehearsal requires exactly two synthetic actors.",
  );
  const actors = parsed.map((candidate) => {
    requireCondition(
      candidate && typeof candidate === "object" && !Array.isArray(candidate),
      "ACTOR_INVALID",
      "Each restore-application actor must be an object.",
    );
    const actor = {
      label: String(candidate.label ?? "").trim(),
      email: String(candidate.email ?? "").trim().toLowerCase(),
      password: String(candidate.password ?? ""),
      totpSecret: String(candidate.totpSecret ?? "").trim(),
      userId: String(candidate.userId ?? "").trim(),
      organizationId: String(candidate.organizationId ?? "").trim(),
      workspaceId: String(candidate.workspaceId ?? "").trim(),
      publishedGuideId: String(candidate.publishedGuideId ?? "").trim(),
      privateMediaId: String(candidate.privateMediaId ?? "").trim(),
      searchQuery: String(candidate.searchQuery ?? "").trim(),
    };
    requireCondition(LABEL.test(actor.label), "ACTOR_LABEL_INVALID", "A restore-application actor label is invalid.");
    requireCondition(
      /^[^\s@]+@[^\s@]+$/.test(actor.email) &&
        actor.email.endsWith(`@${syntheticDomain}`),
      "ACTOR_EMAIL_INVALID",
      "Every restore-application actor must use the dedicated synthetic email domain.",
    );
    requireCondition(
      actor.password.length >= 12 && actor.password.length <= 1_024,
      "ACTOR_PASSWORD_INVALID",
      "A restore-application actor password is invalid.",
    );
    requireCondition(
      actor.totpSecret.length >= 16 && actor.totpSecret.length <= 2_048,
      "ACTOR_TOTP_INVALID",
      "A restore-application actor TOTP secret is invalid.",
    );
    for (const [name, value] of [
      ["user", actor.userId],
      ["organization", actor.organizationId],
      ["workspace", actor.workspaceId],
      ["published guide", actor.publishedGuideId],
      ["private media", actor.privateMediaId],
    ]) {
      requireCondition(ID.test(value), "ACTOR_RESOURCE_ID_INVALID", `A restore-application actor ${name} ID is invalid.`);
    }
    requireCondition(
      actor.searchQuery.length >= 2 && actor.searchQuery.length <= 100,
      "ACTOR_SEARCH_INVALID",
      "A restore-application actor search sentinel is invalid.",
    );
    return actor;
  });
  for (const field of [
    "label",
    "email",
    "userId",
    "organizationId",
    "workspaceId",
    "publishedGuideId",
    "privateMediaId",
    "password",
    "totpSecret",
  ]) {
    requireCondition(
      new Set(actors.map((actor) => actor[field])).size === actors.length,
      "ACTOR_BOUNDARY_INVALID",
      `Restore-application actors must have distinct ${field} values.`,
    );
  }
  return actors;
}

export function restoreApplicationConfiguration(
  environment = process.env,
  workspace = process.cwd(),
) {
  requireCondition(
    required(environment, "KNOWHOW_ENVIRONMENT") === "production",
    "ENVIRONMENT_INVALID",
    "Application restore evidence is restricted to Production rehearsals.",
  );
  requireCondition(
    environment.KNOWHOW_RESTORE_APPLICATION_MODE === "1",
    "RESTORE_MODE_REQUIRED",
    "KNOWHOW_RESTORE_APPLICATION_MODE=1 is required.",
  );
  requireCondition(
    environment.KNOWHOW_RESTORE_APPLICATION_CONFIRM ===
      "production-isolated-restore-application",
    "CONFIRMATION_INVALID",
    "The exact Production isolated restore-application confirmation is required.",
  );
  for (const name of [
    "KNOWHOW_RESTORE_APPLICATION_ISOLATED",
    "KNOWHOW_RESTORE_APPLICATION_NON_PUBLIC",
    "KNOWHOW_RESTORE_APPLICATION_SYNTHETIC_ONLY",
    "KNOWHOW_RESTORE_APPLICATION_EMAIL_DISABLED",
    "KNOWHOW_RESTORE_APPLICATION_EXCLUSIVE",
  ]) {
    exactAttestation(environment, name);
  }

  const endpoint = exactFrankfurtEndpoint(
    required(environment, "APPWRITE_ENDPOINT"),
  );

  const siteOrigin = exactSiteOrigin(
    required(environment, "KNOWHOW_RESTORE_APPLICATION_SITE_ORIGIN"),
  );
  const sourceSiteOrigin = exactSiteOrigin(
    required(environment, "KNOWHOW_RESTORE_APPLICATION_SOURCE_SITE_ORIGIN"),
  );
  requireCondition(
    siteOrigin !== sourceSiteOrigin,
    "SITE_NOT_ISOLATED",
    "The restore-application Site must differ from the active Production Site.",
  );
  const expectedProjectId = required(
    environment,
    "KNOWHOW_RESTORE_APPLICATION_EXPECTED_PROJECT_ID",
  );
  const sourceProjectId = required(
    environment,
    "KNOWHOW_RESTORE_APPLICATION_SOURCE_PROJECT_ID",
  );
  requireCondition(
    ID.test(expectedProjectId) && expectedProjectId === sourceProjectId,
    "PROJECT_BINDING_INVALID",
    "The restore-application verifier must bind to the source Production project.",
  );
  const databaseId = required(
    environment,
    "KNOWHOW_RESTORE_APPLICATION_DATABASE_ID",
  );
  requireCondition(
    RESTORE_DATABASE_ID.test(databaseId) && databaseId !== "knowhow_core",
    "RESTORE_DATABASE_ID_INVALID",
    "The restore-application database must be a new knowhow_restore_* destination.",
  );
  const restorationId = required(environment, "KNOWHOW_RESTORE_RESTORATION_ID");
  requireCondition(
    RESTORATION_ID.test(restorationId),
    "RESTORATION_ID_INVALID",
    "The restoration ID is invalid.",
  );
  const disposableSiteId = restoreSiteId(environment);
  const release = required(
    environment,
    "KNOWHOW_RESTORE_APPLICATION_EXPECTED_RELEASE",
  );
  requireCondition(
    RELEASE_SHA.test(release),
    "RELEASE_INVALID",
    "Restore-application evidence must bind to an exact 40-character release SHA.",
  );
  const accessToken = required(
    environment,
    "KNOWHOW_RESTORE_APPLICATION_ACCESS_TOKEN",
  );
  requireCondition(
    accessToken.length >= 32 &&
      accessToken.length <= 512 &&
      !accessToken.toLowerCase().includes("replace-with-"),
    "ACCESS_TOKEN_INVALID",
    "The restore-application access token must be a non-placeholder secret of at least 32 characters.",
  );
  const syntheticDomain = required(
    environment,
    "KNOWHOW_RESTORE_APPLICATION_SYNTHETIC_EMAIL_DOMAIN",
  ).toLowerCase();
  requireCondition(
    EMAIL_DOMAIN.test(syntheticDomain),
    "SYNTHETIC_DOMAIN_INVALID",
    "The restore-application synthetic email domain is invalid.",
  );
  const actors = parsedActors(
    required(environment, "KNOWHOW_RESTORE_APPLICATION_ACTORS_JSON"),
    syntheticDomain,
  );
  const requestTimeoutMs = Number(
    environment.KNOWHOW_RESTORE_APPLICATION_REQUEST_TIMEOUT_MS ?? 30_000,
  );
  requireCondition(
    Number.isSafeInteger(requestTimeoutMs) &&
      requestTimeoutMs >= 5_000 &&
      requestTimeoutMs <= 120_000,
    "REQUEST_TIMEOUT_INVALID",
    "The restore-application request timeout must be between 5 and 120 seconds.",
  );
  const hmacKey = required(environment, "KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY");
  const hmacKeyId = required(
    environment,
    "KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY_ID",
  );
  requireCondition(
    Buffer.byteLength(hmacKey, "utf8") >= 32 &&
      !hmacKey.toLowerCase().includes("replace-with-"),
    "EVIDENCE_HMAC_KEY_INVALID",
    "The restore-application evidence HMAC key is invalid.",
  );
  requireCondition(
    HMAC_KEY_ID.test(hmacKeyId),
    "EVIDENCE_HMAC_KEY_ID_INVALID",
    "The restore-application evidence HMAC key ID is invalid.",
  );
  requireCondition(
    accessToken !== hmacKey &&
      actors.every((actor) => actor.password !== accessToken),
    "SECRET_SEPARATION_INVALID",
    "The Site access secret, evidence key, and actor passwords must be distinct.",
  );

  return {
    environment: "production",
    endpoint,
    siteOrigin,
    sourceSiteOrigin,
    expectedProjectId,
    databaseId,
    restorationId,
    disposableSiteId,
    release,
    accessToken,
    syntheticDomain,
    actors,
    requestTimeoutMs,
    hmacKey,
    hmacKeyId,
    restoreReportPath: privateEvidencePath(
      required(environment, "KNOWHOW_RESTORE_REPORT_PATH"),
      workspace,
    ),
    applicationReportPath: privateEvidencePath(
      required(environment, "KNOWHOW_RESTORE_APPLICATION_REPORT_PATH"),
      workspace,
    ),
    rtoTargetSeconds: RTO_TARGET_SECONDS,
  };
}

export function restoreApplicationVerificationConfiguration(
  environment = process.env,
  workspace = process.cwd(),
) {
  requireCondition(
    required(environment, "KNOWHOW_ENVIRONMENT") === "production",
    "ENVIRONMENT_INVALID",
    "Restored-application evidence verification is restricted to Production.",
  );
  const siteOrigin = exactSiteOrigin(
    required(environment, "KNOWHOW_RESTORE_APPLICATION_SITE_ORIGIN"),
  );
  const sourceSiteOrigin = exactSiteOrigin(
    required(environment, "KNOWHOW_RESTORE_APPLICATION_SOURCE_SITE_ORIGIN"),
  );
  requireCondition(
    siteOrigin !== sourceSiteOrigin,
    "SITE_NOT_ISOLATED",
    "The restore-application Site must differ from the active Production Site.",
  );
  const expectedProjectId = required(
    environment,
    "KNOWHOW_RESTORE_APPLICATION_EXPECTED_PROJECT_ID",
  );
  requireCondition(
    ID.test(expectedProjectId),
    "PROJECT_BINDING_INVALID",
    "The expected restore-application project ID is invalid.",
  );
  const databaseId = required(
    environment,
    "KNOWHOW_RESTORE_APPLICATION_DATABASE_ID",
  );
  requireCondition(
    RESTORE_DATABASE_ID.test(databaseId) && databaseId !== "knowhow_core",
    "RESTORE_DATABASE_ID_INVALID",
    "The restore-application database must be a new knowhow_restore_* destination.",
  );
  const restorationId = required(environment, "KNOWHOW_RESTORE_RESTORATION_ID");
  requireCondition(
    RESTORATION_ID.test(restorationId),
    "RESTORATION_ID_INVALID",
    "The restoration ID is invalid.",
  );
  const disposableSiteId = restoreSiteId(environment);
  const release = required(
    environment,
    "KNOWHOW_RESTORE_APPLICATION_EXPECTED_RELEASE",
  );
  requireCondition(RELEASE_SHA.test(release), "RELEASE_INVALID", "The expected release SHA is invalid.");
  const hmacKey = required(environment, "KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY");
  const hmacKeyId = required(
    environment,
    "KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY_ID",
  );
  requireCondition(
    Buffer.byteLength(hmacKey, "utf8") >= 32 &&
      !hmacKey.toLowerCase().includes("replace-with-") &&
      HMAC_KEY_ID.test(hmacKeyId),
    "EVIDENCE_HMAC_KEY_INVALID",
    "The restored-application evidence HMAC configuration is invalid.",
  );
  return {
    environment: "production",
    siteOrigin,
    sourceSiteOrigin,
    expectedProjectId,
    databaseId,
    restorationId,
    disposableSiteId,
    release,
    hmacKey,
    hmacKeyId,
    restoreReportPath: privateEvidencePath(
      required(environment, "KNOWHOW_RESTORE_REPORT_PATH"),
      workspace,
    ),
    applicationReportPath: privateEvidencePath(
      required(environment, "KNOWHOW_RESTORE_APPLICATION_REPORT_PATH"),
      workspace,
    ),
    rtoTargetSeconds: RTO_TARGET_SECONDS,
  };
}

function restoreCleanupBindings(environment, workspace) {
  const base = restoreApplicationVerificationConfiguration(
    environment,
    workspace,
  );
  return {
    ...base,
    cleanupReportPath: privateEvidencePath(
      required(environment, "KNOWHOW_RESTORE_CLEANUP_REPORT_PATH"),
      workspace,
    ),
  };
}

export function restoreCleanupConfiguration(
  environment = process.env,
  workspace = process.cwd(),
) {
  const bindings = restoreCleanupBindings(environment, workspace);
  requireCondition(
    environment.KNOWHOW_RESTORE_CLEANUP_CONFIRM ===
      "production-isolated-restore-cleanup",
    "CLEANUP_CONFIRMATION_INVALID",
    "The exact Production isolated restore cleanup confirmation is required.",
  );
  for (const name of [
    "KNOWHOW_RESTORE_CLEANUP_SECOND_OPERATOR",
    "KNOWHOW_RESTORE_CLEANUP_PLATFORM_REMOVED",
    "KNOWHOW_RESTORE_CLEANUP_RUNTIME_KEY_REVOKED",
    "KNOWHOW_RESTORE_CLEANUP_ACCESS_SECRET_DESTROYED",
  ]) {
    exactAttestation(environment, name);
  }
  const endpoint = exactFrankfurtEndpoint(
    required(environment, "APPWRITE_ENDPOINT"),
  );
  const projectId = required(environment, "APPWRITE_PROJECT_ID");
  requireCondition(
    projectId === bindings.expectedProjectId,
    "PROJECT_BINDING_INVALID",
    "The restore cleanup key belongs to another Appwrite project.",
  );
  const apiKey = required(environment, "APPWRITE_API_KEY");
  requireCondition(
    apiKey.length >= 20 &&
      apiKey.length <= 8_192 &&
      !apiKey.toLowerCase().includes("replace-with-"),
    "APPWRITE_API_KEY_INVALID",
    "The short-lived read-only restore cleanup API key is invalid.",
  );
  return { ...bindings, endpoint, projectId, apiKey };
}

export function restoreCleanupVerificationConfiguration(
  environment = process.env,
  workspace = process.cwd(),
) {
  return restoreCleanupBindings(environment, workspace);
}

export function hmacFingerprint(key, domain, value) {
  return createHmac("sha256", key)
    .update(`${domain}\0${value}`, "utf8")
    .digest("hex");
}

export function contentFreeActor(actor, key) {
  return {
    actorFingerprint: hmacFingerprint(key, "restore-actor", actor.userId),
    organizationFingerprint: hmacFingerprint(
      key,
      "restore-organization",
      actor.organizationId,
    ),
    workspaceFingerprint: hmacFingerprint(
      key,
      "restore-workspace",
      actor.workspaceId,
    ),
    guideFingerprint: hmacFingerprint(
      key,
      "restore-guide",
      actor.publishedGuideId,
    ),
    mediaFingerprint: hmacFingerprint(
      key,
      "restore-media",
      actor.privateMediaId,
    ),
  };
}

export function requestIdDigest(requestIds) {
  requireCondition(
    Array.isArray(requestIds) &&
      requestIds.length > 0 &&
      requestIds.every((value) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          value,
        ),
      ),
    "REQUEST_ID_INVALID",
    "Restore-application response correlation IDs are invalid.",
  );
  const hash = createHash("sha256");
  for (const value of requestIds) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

export function validateRestoreReport(payload, configuration) {
  exactKeys(
    payload,
    [
      "evidenceVersion",
      "kind",
      "status",
      "verifiedAt",
      "release",
      "source",
      "target",
      "database",
      "timing",
      "attestations",
    ],
    "RESTORE_REPORT_FIELDS_INVALID",
  );
  exactKeys(
    payload?.source,
    ["projectFingerprint", "databaseId", "archiveId"],
    "RESTORE_REPORT_SOURCE_FIELDS_INVALID",
  );
  exactKeys(
    payload?.target,
    ["endpointOrigin", "projectFingerprint", "databaseId", "restoration"],
    "RESTORE_REPORT_TARGET_FIELDS_INVALID",
  );
  exactKeys(
    payload?.target?.restoration,
    ["id", "archiveId", "startedAt", "completedAt"],
    "RESTORE_REPORT_RESTORATION_FIELDS_INVALID",
  );
  exactKeys(
    payload?.database,
    [
      "tableCount",
      "totalRows",
      "auditChainCount",
      "schemaSha256",
      "overallSha256",
    ],
    "RESTORE_REPORT_DATABASE_FIELDS_INVALID",
  );
  exactKeys(
    payload?.timing,
    [
      "incidentAt",
      "recoveryPointAt",
      "rpoSeconds",
      "databaseVerificationSeconds",
      "applicationRtoStillRequired",
    ],
    "RESTORE_REPORT_TIMING_FIELDS_INVALID",
  );
  exactKeys(
    payload?.attestations,
    ["isolatedTarget", "targetNotReferencedByDeployedRuntime", "syntheticDataOnly"],
    "RESTORE_REPORT_ATTESTATION_FIELDS_INVALID",
  );
  requireCondition(
    payload?.evidenceVersion === 1 &&
      payload.kind === "knowhow-isolated-restore-verification" &&
      payload.status === "passed",
    "RESTORE_REPORT_CONTRACT_INVALID",
    "The input restore report is not a passed KnowHow isolated restore verification.",
  );
  requireCondition(
    payload.release === configuration.release,
    "RESTORE_REPORT_RELEASE_MISMATCH",
    "The restore report belongs to another release.",
  );
  requireCondition(
    payload.source?.databaseId === "knowhow_core" &&
      payload.source?.projectFingerprint ===
        restoreEvidenceProjectFingerprint(configuration.expectedProjectId),
    "RESTORE_REPORT_SOURCE_MISMATCH",
    "The restore report does not belong to the expected Production source.",
  );
  requireCondition(
    payload.target?.endpointOrigin === "https://fra.cloud.appwrite.io" &&
      payload.target?.projectFingerprint ===
      restoreEvidenceProjectFingerprint(configuration.expectedProjectId) &&
      payload.target?.databaseId === configuration.databaseId &&
      payload.target?.restoration?.id === configuration.restorationId,
    "RESTORE_REPORT_TARGET_MISMATCH",
    "The restore report does not belong to the expected restored database and restoration.",
  );
  requireCondition(
    RESTORATION_ID.test(String(payload.source?.archiveId ?? "")) &&
      payload.target?.restoration?.archiveId === payload.source.archiveId &&
      validIso(payload.target?.restoration?.startedAt) &&
      validIso(payload.target?.restoration?.completedAt) &&
      Date.parse(payload.target.restoration.startedAt) <=
        Date.parse(payload.target.restoration.completedAt),
    "RESTORE_REPORT_RESTORATION_INVALID",
    "The restore report restoration binding or timing is invalid.",
  );
  requireCondition(
    SHA256.test(String(payload.database?.overallSha256 ?? "")) &&
      SHA256.test(String(payload.database?.schemaSha256 ?? "")) &&
      payload.database?.tableCount === 40 &&
      Number.isSafeInteger(payload.database?.totalRows) &&
      payload.database.totalRows >= 0 &&
      Number.isSafeInteger(payload.database?.auditChainCount) &&
      payload.database.auditChainCount >= 1,
    "RESTORE_REPORT_DATABASE_INVALID",
    "The restore report has no valid database-integrity fingerprint.",
  );
  requireCondition(
    validIso(payload.verifiedAt) &&
      validIso(payload.timing?.incidentAt) &&
      validIso(payload.timing?.recoveryPointAt) &&
      payload.timing?.applicationRtoStillRequired === true &&
      Number.isSafeInteger(payload.timing?.rpoSeconds) &&
      payload.timing.rpoSeconds >= 0 &&
      payload.timing.rpoSeconds <= RTO_TARGET_SECONDS &&
      payload.timing.rpoSeconds ===
        Math.floor(
          (Date.parse(payload.timing.incidentAt) -
            Date.parse(payload.timing.recoveryPointAt)) /
            1_000,
        ) &&
      Number.isSafeInteger(payload.timing?.databaseVerificationSeconds) &&
      payload.timing.databaseVerificationSeconds >= 0 &&
      payload.timing.databaseVerificationSeconds <= RTO_TARGET_SECONDS &&
      payload.timing.databaseVerificationSeconds ===
        Math.floor(
          (Date.parse(payload.verifiedAt) -
            Date.parse(payload.timing.incidentAt)) /
            1_000,
        ) &&
      Date.parse(payload.target.restoration.completedAt) <=
        Date.parse(payload.verifiedAt),
    "RESTORE_REPORT_TIMING_INVALID",
    "The restore report timing contract is invalid.",
  );
  requireCondition(
    payload.attestations?.isolatedTarget === true &&
      payload.attestations?.targetNotReferencedByDeployedRuntime === true &&
      payload.attestations?.syntheticDataOnly === true,
    "RESTORE_REPORT_ATTESTATION_INVALID",
    "The restore report lacks its isolation attestations.",
  );
  return payload;
}

export function openRestoreReport(sealed, configuration) {
  let payload;
  try {
    payload = verifyEvidenceSeal(
      sealed,
      configuration.hmacKey,
      configuration.hmacKeyId,
    );
  } catch {
    fail(
      "RESTORE_REPORT_SEAL_INVALID",
      "The input restore report failed HMAC verification.",
    );
  }
  return validateRestoreReport(payload, configuration);
}

export function restoreReportFingerprint(sealed) {
  return sha256(canonicalJson(sealed));
}

function exactKeys(value, expected, code) {
  requireCondition(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      canonicalJson(Object.keys(value).sort()) ===
        canonicalJson([...expected].sort()),
    code,
    "The restore evidence contains missing or unexpected fields.",
  );
}

export function validateApplicationEvidence(payload) {
  exactKeys(
    payload,
    [
      "evidenceVersion",
      "kind",
      "status",
      "environment",
      "release",
      "siteOrigin",
      "sourceSiteOrigin",
      "disposableSiteFingerprint",
      "projectFingerprint",
      "databaseFingerprint",
      "restorationFingerprint",
      "startedAt",
      "readinessReachedAt",
      "applicationVerifiedAt",
      "generatedAt",
      "sourceRestoreEvidence",
      "actors",
      "checks",
      "transaction",
      "timing",
      "correlation",
      "cleanup",
      "attestations",
      "externalActionsRequired",
    ],
    "APPLICATION_EVIDENCE_FIELDS_INVALID",
  );
  requireCondition(
    payload?.evidenceVersion === 1 &&
      payload.kind === "knowhow-restored-application-evidence" &&
      payload.status === "passed" &&
      payload.environment === "production" &&
      RELEASE_SHA.test(String(payload.release ?? "")),
    "APPLICATION_EVIDENCE_CONTRACT_INVALID",
    "The restored-application evidence contract is invalid.",
  );
  requireCondition(
    validIso(payload.startedAt) &&
      validIso(payload.readinessReachedAt) &&
      validIso(payload.applicationVerifiedAt) &&
      validIso(payload.generatedAt) &&
      Date.parse(payload.startedAt) <= Date.parse(payload.readinessReachedAt) &&
      Date.parse(payload.readinessReachedAt) <=
        Date.parse(payload.applicationVerifiedAt) &&
      Date.parse(payload.applicationVerifiedAt) <= Date.parse(payload.generatedAt),
    "APPLICATION_EVIDENCE_TIME_INVALID",
    "The restored-application evidence timestamps are invalid.",
  );
  requireCondition(
    exactSiteOrigin(payload.siteOrigin) === payload.siteOrigin &&
      exactSiteOrigin(payload.sourceSiteOrigin) === payload.sourceSiteOrigin &&
      payload.siteOrigin !== payload.sourceSiteOrigin,
    "APPLICATION_EVIDENCE_SITE_INVALID",
    "The restored-application evidence Site binding is invalid.",
  );
  for (const value of [
    payload.projectFingerprint,
    payload.databaseFingerprint,
    payload.restorationFingerprint,
    payload.disposableSiteFingerprint,
    payload.sourceRestoreEvidence?.reportSha256,
    payload.sourceRestoreEvidence?.databaseOverallSha256,
    payload.sourceRestoreEvidence?.archiveFingerprint,
    payload.correlation?.requestIdsSha256,
  ]) {
    requireCondition(
      SHA256.test(String(value ?? "")),
      "APPLICATION_EVIDENCE_DIGEST_INVALID",
      "The restored-application evidence contains an invalid digest.",
    );
  }
  requireCondition(
    validIso(payload.sourceRestoreEvidence?.verifiedAt) &&
      Date.parse(payload.sourceRestoreEvidence.verifiedAt) <=
        Date.parse(payload.startedAt),
    "APPLICATION_EVIDENCE_SOURCE_TIME_INVALID",
    "The restored-application evidence source verification time is invalid.",
  );
  exactKeys(
    payload.sourceRestoreEvidence,
    [
      "reportSha256",
      "databaseOverallSha256",
      "verifiedAt",
      "archiveFingerprint",
    ],
    "APPLICATION_EVIDENCE_SOURCE_FIELDS_INVALID",
  );
  requireCondition(
    Array.isArray(payload.actors) && payload.actors.length === 2,
    "APPLICATION_EVIDENCE_ACTORS_INVALID",
    "The restored-application evidence must contain exactly two content-free actors.",
  );
  for (const field of [
    "actorFingerprint",
    "organizationFingerprint",
    "workspaceFingerprint",
    "guideFingerprint",
    "mediaFingerprint",
  ]) {
    requireCondition(
      payload.actors.every((actor) => SHA256.test(String(actor?.[field] ?? ""))) &&
        new Set(payload.actors.map((actor) => actor[field])).size === 2,
      "APPLICATION_EVIDENCE_ACTORS_INVALID",
      "The restored-application actor evidence is missing or not distinct.",
    );
  }
  for (const actor of payload.actors) {
    exactKeys(
      actor,
      [
        "actorFingerprint",
        "organizationFingerprint",
        "workspaceFingerprint",
        "guideFingerprint",
        "mediaFingerprint",
      ],
      "APPLICATION_EVIDENCE_ACTOR_FIELDS_INVALID",
    );
  }
  const checks = payload.checks ?? {};
  exactKeys(
    checks,
    [
      "accessBoundary",
      "readinessBinding",
      "verifiedMfaSessions",
      "ownTenantReads",
      "organizationMetadataOnlyBoundary",
      "crossTenantBootstrapDenials",
      "crossTenantSearchDenials",
      "crossTenantMediaDenials",
      "transactionalMutation",
      "idempotentReplay",
      "auditChain",
      "exportCreation",
      "anonymousApiDenials",
    ],
    "APPLICATION_EVIDENCE_CHECK_FIELDS_INVALID",
  );
  requireCondition(
    checks.accessBoundary === "denied-without-secret" &&
      checks.readinessBinding === "exact" &&
      checks.verifiedMfaSessions === 2 &&
      checks.ownTenantReads === 2 &&
      checks.organizationMetadataOnlyBoundary === "passed" &&
      checks.crossTenantBootstrapDenials === 2 &&
      checks.crossTenantSearchDenials === 2 &&
      checks.crossTenantMediaDenials === 2 &&
      checks.transactionalMutation === "committed" &&
      checks.idempotentReplay === "passed" &&
      checks.auditChain === "sequential" &&
      checks.exportCreation === "queued" &&
      checks.anonymousApiDenials === 5,
    "APPLICATION_EVIDENCE_CHECKS_INVALID",
    "One or more restored-application checks are missing.",
  );
  const transaction = payload.transaction ?? {};
  exactKeys(
    transaction,
    [
      "auditSequenceBefore",
      "auditSequenceAfterCompletion",
      "auditSequenceAfterAuditExport",
      "auditSequenceAfterExportCreation",
      "exportJobFingerprint",
    ],
    "APPLICATION_EVIDENCE_TRANSACTION_FIELDS_INVALID",
  );
  requireCondition(
    Number.isSafeInteger(transaction.auditSequenceBefore) &&
      transaction.auditSequenceBefore >= 0 &&
      transaction.auditSequenceAfterCompletion ===
        transaction.auditSequenceBefore + 1 &&
      transaction.auditSequenceAfterAuditExport ===
        transaction.auditSequenceBefore + 2 &&
      transaction.auditSequenceAfterExportCreation ===
        transaction.auditSequenceBefore + 3 &&
      SHA256.test(String(transaction.exportJobFingerprint ?? "")),
    "APPLICATION_EVIDENCE_TRANSACTION_INVALID",
    "The restored-application transaction or audit sequence is invalid.",
  );
  const timing = payload.timing ?? {};
  exactKeys(
    timing,
    [
      "incidentAt",
      "rtoTargetSeconds",
      "applicationRtoSeconds",
      "applicationRtoSatisfied",
    ],
    "APPLICATION_EVIDENCE_TIMING_FIELDS_INVALID",
  );
  requireCondition(
    validIso(timing.incidentAt) &&
      timing.rtoTargetSeconds === RTO_TARGET_SECONDS &&
      Number.isSafeInteger(timing.applicationRtoSeconds) &&
      timing.applicationRtoSeconds >= 0 &&
      timing.applicationRtoSeconds <= RTO_TARGET_SECONDS &&
      timing.applicationRtoSatisfied === true &&
      timing.applicationRtoSeconds ===
        Math.floor(
          (Date.parse(payload.applicationVerifiedAt) -
            Date.parse(timing.incidentAt)) /
            1_000,
        ),
    "APPLICATION_EVIDENCE_RTO_INVALID",
    "The restored-application RTO evidence is invalid.",
  );
  exactKeys(
    payload.correlation,
    ["responseCount", "requestIdsSha256"],
    "APPLICATION_EVIDENCE_CORRELATION_FIELDS_INVALID",
  );
  requireCondition(
    Number.isSafeInteger(payload.correlation?.responseCount) &&
      payload.correlation.responseCount >= 20,
    "APPLICATION_EVIDENCE_CORRELATION_INVALID",
    "The restored-application request accounting is incomplete.",
  );
  exactKeys(
    payload.cleanup,
    [
      "serverSessionsRevoked",
      "restoreDatabaseDeletionRequired",
      "disposableSiteRemovalRequired",
      "testRowsConfinedToRestoredDatabase",
    ],
    "APPLICATION_EVIDENCE_CLEANUP_FIELDS_INVALID",
  );
  requireCondition(
    payload.cleanup?.serverSessionsRevoked === 2 &&
      payload.cleanup?.restoreDatabaseDeletionRequired === true &&
      payload.cleanup?.disposableSiteRemovalRequired === true &&
      payload.cleanup?.testRowsConfinedToRestoredDatabase === true,
    "APPLICATION_EVIDENCE_CLEANUP_INVALID",
    "The restored-application cleanup contract is invalid.",
  );
  exactKeys(
    payload.attestations,
    [
      "isolatedTarget",
      "accessControlledSite",
      "syntheticDataOnly",
      "emailDeliveryDisabled",
      "exclusiveRehearsal",
    ],
    "APPLICATION_EVIDENCE_ATTESTATION_FIELDS_INVALID",
  );
  requireCondition(
    payload.attestations?.isolatedTarget === true &&
      payload.attestations?.accessControlledSite === true &&
      payload.attestations?.syntheticDataOnly === true &&
      payload.attestations?.emailDeliveryDisabled === true &&
      payload.attestations?.exclusiveRehearsal === true,
    "APPLICATION_EVIDENCE_ATTESTATION_INVALID",
    "The restored-application evidence lacks its required attestations.",
  );
  requireCondition(
    canonicalJson(payload.externalActionsRequired) ===
      canonicalJson([
        "second-operator approval and exact restored-database deletion",
        "remove the disposable Site, Auth platform hostname, short-lived key, and restore access secret",
      ]),
    "APPLICATION_EVIDENCE_EXTERNAL_ACTIONS_INVALID",
    "The restored-application evidence must retain its independent cleanup requirements.",
  );
  return payload;
}

export function sealApplicationEvidence(payload, key, keyId) {
  validateApplicationEvidence(payload);
  return sealEvidence(payload, key, keyId);
}

export function openApplicationEvidence(sealed, key, keyId) {
  let payload;
  try {
    payload = verifyEvidenceSeal(sealed, key, keyId);
  } catch {
    fail(
      "APPLICATION_EVIDENCE_SEAL_INVALID",
      "The restored-application evidence failed HMAC verification.",
    );
  }
  return validateApplicationEvidence(payload);
}

export function validateRestoreCleanupEvidence(payload) {
  exactKeys(
    payload,
    [
      "evidenceVersion",
      "kind",
      "status",
      "environment",
      "release",
      "verifiedAt",
      "projectFingerprint",
      "databaseFingerprint",
      "restorationFingerprint",
      "disposableSiteFingerprint",
      "evidenceChain",
      "checks",
      "attestations",
      "remainingActions",
    ],
    "RESTORE_CLEANUP_EVIDENCE_FIELDS_INVALID",
  );
  requireCondition(
    payload.evidenceVersion === 1 &&
      payload.kind === "knowhow-restore-cleanup-evidence" &&
      payload.status === "passed" &&
      payload.environment === "production" &&
      RELEASE_SHA.test(String(payload.release ?? "")) &&
      validIso(payload.verifiedAt),
    "RESTORE_CLEANUP_EVIDENCE_CONTRACT_INVALID",
    "The restore cleanup evidence contract is invalid.",
  );
  for (const value of [
    payload.projectFingerprint,
    payload.databaseFingerprint,
    payload.restorationFingerprint,
    payload.disposableSiteFingerprint,
    payload.evidenceChain?.restoreReportSha256,
    payload.evidenceChain?.applicationReportSha256,
  ]) {
    requireCondition(
      SHA256.test(String(value ?? "")),
      "RESTORE_CLEANUP_EVIDENCE_DIGEST_INVALID",
      "The restore cleanup evidence contains an invalid digest.",
    );
  }
  exactKeys(
    payload.evidenceChain,
    ["restoreReportSha256", "applicationReportSha256"],
    "RESTORE_CLEANUP_EVIDENCE_CHAIN_FIELDS_INVALID",
  );
  exactKeys(
    payload.checks,
    [
      "sourceDatabase",
      "sourceSite",
      "restoredDatabase",
      "disposableSite",
    ],
    "RESTORE_CLEANUP_EVIDENCE_CHECK_FIELDS_INVALID",
  );
  requireCondition(
    payload.checks.sourceDatabase === "present" &&
      payload.checks.sourceSite === "present" &&
      payload.checks.restoredDatabase === "absent" &&
      payload.checks.disposableSite === "absent",
    "RESTORE_CLEANUP_EVIDENCE_CHECKS_INVALID",
    "The restore cleanup evidence does not prove exact source preservation and disposable-resource absence.",
  );
  exactKeys(
    payload.attestations,
    [
      "independentSecondOperator",
      "temporaryAuthPlatformRemoved",
      "disposableRuntimeKeyRevoked",
      "restoreAccessSecretDestroyed",
    ],
    "RESTORE_CLEANUP_EVIDENCE_ATTESTATION_FIELDS_INVALID",
  );
  requireCondition(
    payload.attestations.independentSecondOperator === true &&
      payload.attestations.temporaryAuthPlatformRemoved === true &&
      payload.attestations.disposableRuntimeKeyRevoked === true &&
      payload.attestations.restoreAccessSecretDestroyed === true,
    "RESTORE_CLEANUP_EVIDENCE_ATTESTATIONS_INVALID",
    "The restore cleanup evidence lacks its independent cleanup attestations.",
  );
  requireCondition(
    canonicalJson(payload.remainingActions) ===
      canonicalJson([
        "revoke the read-only cleanup verifier key after offline evidence verification",
      ]),
    "RESTORE_CLEANUP_EVIDENCE_REMAINDER_INVALID",
    "The restore cleanup evidence must retain cleanup-key revocation as an explicit final action.",
  );
  return payload;
}

export function sealRestoreCleanupEvidence(payload, key, keyId) {
  validateRestoreCleanupEvidence(payload);
  return sealEvidence(payload, key, keyId);
}

export function openRestoreCleanupEvidence(sealed, key, keyId) {
  let payload;
  try {
    payload = verifyEvidenceSeal(sealed, key, keyId);
  } catch {
    fail(
      "RESTORE_CLEANUP_EVIDENCE_SEAL_INVALID",
      "The restore cleanup evidence failed HMAC verification.",
    );
  }
  return validateRestoreCleanupEvidence(payload);
}

export function constantTimeSecretEqual(left, right) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function safeFailure(error) {
  if (error instanceof RestoreApplicationError) {
    return { status: "failed", code: error.code, message: error.message };
  }
  return {
    status: "failed",
    code: "RESTORE_APPLICATION_FAILED",
    message: "The isolated restored-application evidence gate failed.",
  };
}
