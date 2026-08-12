import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppwriteException,
  Client,
  Query,
  Storage,
  TablesDB,
  Users,
} from "node-appwrite";

const EVIDENCE_VERSION = 1;
const PAGE_SIZE = 100;
const MAX_TABLE_ROWS = 250_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^[a-f0-9]{40}$/;
const RECEIPT_PAYLOAD_KEYS = [
  "approvedAt",
  "approvedByHash",
  "completedAt",
  "createdAt",
  "eligibleAt",
  "kind",
  "receipt",
  "status",
];
const RECEIPT_KEYS = [
  "authUsersPreserved",
  "authUsersRemoved",
  "deletedFiles",
  "deletedRows",
  "failedFiles",
  "organizationDeleted",
  "organizationFilesDeleted",
  "organizationHash",
  "organizationRowsDeleted",
  "userPreferenceRowsDeleted",
  "version",
  "workspaceHash",
];
const SCRUBBED_RECEIPT_FIELDS = [
  "organization_id",
  "workspace_id",
  "user_id",
  "subject_id",
  "slug",
  "email",
  "idempotency_key",
  "request_id",
  "expires_at",
  "scheduled_at",
  "deleted_at",
];

export class CleanupEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CleanupEvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CleanupEvidenceError(code, message);
}

function requireCondition(condition, code, message) {
  if (!condition) fail(code, message);
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) fail("ENVIRONMENT_REQUIRED", `${name} is required.`);
  return value;
}

function requireAttestation(name) {
  requireCondition(
    process.env[name] === "1",
    "ATTESTATION_REQUIRED",
    `${name}=1 is required for this controlled Production gate.`,
  );
}

export function canonicalJson(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    requireCondition(
      Number.isFinite(value),
      "EVIDENCE_VALUE_INVALID",
      "Evidence contains a non-finite number.",
    );
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => {
        requireCondition(
          item !== undefined,
          "EVIDENCE_VALUE_INVALID",
          "Evidence contains an undefined value.",
        );
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(",")}}`;
  }
  fail("EVIDENCE_VALUE_INVALID", "Evidence contains an unsupported value.");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function keyedHash(value, key) {
  return createHmac("sha256", key).update(value).digest("hex");
}

export function controlledProductionEndpoint(raw) {
  requireCondition(
    /^https:\/\/fra\.cloud\.appwrite\.io\/v1\/?$/.test(raw),
    "APPWRITE_ENDPOINT_NOT_FRANKFURT",
    "Production cleanup evidence accepts only the Appwrite Cloud Frankfurt API endpoint.",
  );
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    fail("APPWRITE_ENDPOINT_INVALID", "APPWRITE_ENDPOINT must be a valid URL.");
  }
  requireCondition(
    endpoint.protocol === "https:" &&
      endpoint.hostname === "fra.cloud.appwrite.io" &&
      endpoint.pathname.replace(/\/$/, "") === "/v1" &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.port &&
      !endpoint.search &&
      !endpoint.hash,
    "APPWRITE_ENDPOINT_NOT_FRANKFURT",
    "Production cleanup evidence accepts only the Appwrite Cloud Frankfurt API endpoint.",
  );
  return endpoint.toString().replace(/\/$/, "");
}

function parseJsonEnvironment(name) {
  try {
    return JSON.parse(requiredEnvironment(name));
  } catch (error) {
    if (error instanceof CleanupEvidenceError) throw error;
    fail("ENVIRONMENT_JSON_INVALID", `${name} must contain valid JSON.`);
  }
}

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function validateCleanupTargets(value) {
  requireCondition(
    Array.isArray(value) && value.length > 0 && value.length <= 10,
    "CLEANUP_TARGETS_INVALID",
    "Cleanup targets must contain between one and ten receipt mappings.",
  );
  const targets = value.map((target) => {
    requireCondition(
      target &&
        typeof target === "object" &&
        !Array.isArray(target) &&
        validId(target.caseId) &&
        validId(target.organizationId) &&
        validId(target.workspaceId) &&
        typeof target.organizationDeleted === "boolean",
      "CLEANUP_TARGET_INVALID",
      "Each cleanup target needs valid case, organization, and workspace IDs plus organizationDeleted.",
    );
    return {
      caseId: target.caseId,
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      organizationDeleted: target.organizationDeleted,
    };
  });
  requireCondition(
    new Set(targets.map((target) => target.caseId)).size === targets.length &&
      new Set(targets.map((target) => target.workspaceId)).size ===
        targets.length,
    "CLEANUP_TARGET_DUPLICATE",
    "Cleanup case and workspace IDs must be unique.",
  );
  for (const organizationId of new Set(
    targets.map((target) => target.organizationId),
  )) {
    requireCondition(
      targets.filter(
        (target) =>
          target.organizationId === organizationId && target.organizationDeleted,
      ).length === 1,
      "CLEANUP_ORGANIZATION_RECEIPT_MISSING",
      "Every rehearsal organization needs exactly one receipt that confirms root deletion.",
    );
  }
  return targets;
}

export function validateRehearsalUserIds(value) {
  requireCondition(
    Array.isArray(value) && value.length === 2 && value.every(validId),
    "CLEANUP_USERS_INVALID",
    "The Production gate requires exactly the two synthetic rehearsal user IDs.",
  );
  requireCondition(
    new Set(value).size === value.length,
    "CLEANUP_USERS_DUPLICATE",
    "Synthetic rehearsal user IDs must be unique.",
  );
  return [...value].sort((left, right) => left.localeCompare(right));
}

function parsePayload(row) {
  try {
    const value = JSON.parse(row.payload_json);
    requireCondition(
      value && typeof value === "object" && !Array.isArray(value),
      "CLEANUP_RECEIPT_PAYLOAD_INVALID",
      "A cleanup receipt payload is not an object.",
    );
    return value;
  } catch (error) {
    if (error instanceof CleanupEvidenceError) throw error;
    fail(
      "CLEANUP_RECEIPT_PAYLOAD_INVALID",
      "A cleanup receipt payload is not valid JSON.",
    );
  }
}

function exactKeys(value, expected) {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validIso(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function validateCleanupReceipt(row, target, receiptPepper) {
  requireCondition(
    Buffer.byteLength(receiptPepper, "utf8") >= 32 &&
      !receiptPepper.toLowerCase().includes("replace-with-"),
    "DELETION_RECEIPT_PEPPER_INVALID",
    "The deletion receipt pepper must contain at least 32 non-placeholder bytes.",
  );
  requireCondition(
    row.$id === target.caseId &&
      row.kind === "tenant_deletion_approval" &&
      row.status === "completed" &&
      row.created_by === "knowhow_ops" &&
      row.updated_by === "knowhow_ops",
    "CLEANUP_RECEIPT_STATE_INVALID",
    "A cleanup receipt is not in the completed worker-owned state.",
  );
  requireCondition(
    SCRUBBED_RECEIPT_FIELDS.every((field) => row[field] == null),
    "CLEANUP_RECEIPT_IDENTIFIER_RETAINED",
    "A cleanup receipt still contains a raw scalar identifier.",
  );
  const value = parsePayload(row);
  const lifecycleTimes = [
    value.createdAt,
    value.eligibleAt,
    value.approvedAt,
    value.completedAt,
  ];
  requireCondition(
    exactKeys(value, RECEIPT_PAYLOAD_KEYS) &&
      value.kind === "tenant_deletion_approval" &&
      value.status === "completed" &&
      SHA256_PATTERN.test(String(value.approvedByHash)) &&
      lifecycleTimes.every(validIso) &&
      lifecycleTimes.every(
        (time, index) =>
          index === 0 || Date.parse(lifecycleTimes[index - 1]) <= Date.parse(time),
      ) &&
      row.occurred_at === value.completedAt,
    "CLEANUP_RECEIPT_PAYLOAD_INVALID",
    "A cleanup receipt contains fields outside the content-free contract.",
  );
  const receipt = value.receipt;
  requireCondition(
    receipt &&
      typeof receipt === "object" &&
      !Array.isArray(receipt) &&
      exactKeys(receipt, RECEIPT_KEYS) &&
      receipt.version === 2 &&
      receipt.failedFiles === 0 &&
      receipt.organizationDeleted === target.organizationDeleted &&
      [
        receipt.deletedRows,
        receipt.deletedFiles,
        receipt.organizationRowsDeleted,
        receipt.organizationFilesDeleted,
        receipt.authUsersRemoved,
        receipt.authUsersPreserved,
        receipt.userPreferenceRowsDeleted,
      ].every(validCount),
    "CLEANUP_RECEIPT_COUNTS_INVALID",
    "A cleanup receipt has invalid or incomplete deletion counts.",
  );
  requireCondition(
    receipt.workspaceHash ===
      keyedHash(`workspace\0${target.workspaceId}`, receiptPepper) &&
      receipt.organizationHash ===
        keyedHash(`organization\0${target.organizationId}`, receiptPepper),
    "CLEANUP_RECEIPT_HASH_MISMATCH",
    "A cleanup receipt does not bind to its approved tenant target.",
  );
  requireCondition(
    receipt.deletedRows > 0 &&
      (target.organizationDeleted
        ? receipt.organizationRowsDeleted > 0
        : receipt.organizationRowsDeleted === 0 &&
          receipt.organizationFilesDeleted === 0),
    "CLEANUP_ORGANIZATION_COUNT_INVALID",
    "A cleanup receipt does not record the exact required root deletion scope.",
  );
  return {
    workspaceHash: receipt.workspaceHash,
    organizationHash: receipt.organizationHash,
    organizationDeleted: receipt.organizationDeleted,
    deletedRows: receipt.deletedRows + receipt.organizationRowsDeleted,
    deletedFiles: receipt.deletedFiles + receipt.organizationFilesDeleted,
    authUsersRemoved: receipt.authUsersRemoved,
    authUsersPreserved: receipt.authUsersPreserved,
    completedAt: value.completedAt,
  };
}

function containsIdentifier(value, identifiers) {
  if (typeof value === "string")
    return [...identifiers].some((identifier) => value.includes(identifier));
  if (Array.isArray(value))
    return value.some((item) => containsIdentifier(item, identifiers));
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, item]) =>
        containsIdentifier(key, identifiers) ||
        containsIdentifier(item, identifiers),
    );
  return false;
}

export function assertRowsAreClean(tableId, rows, identifiers) {
  if (tableId === "organizations" || tableId === "workspaces") {
    requireCondition(
      rows.length === 0,
      "CLEANUP_TENANT_ROOT_REMAINS",
      "Production still contains an organization or workspace root row.",
    );
  }
  for (const row of rows) {
    requireCondition(
      row.organization_id == null && row.workspace_id == null,
      "CLEANUP_SCOPED_ROW_REMAINS",
      `Production still contains a customer-scoped ${tableId} row.`,
    );
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(row.payload_json || "{}");
    } catch {
      fail(
        "CLEANUP_ROW_PAYLOAD_INVALID",
        `Production contains an invalid ${tableId} payload.`,
      );
    }
    const scalarRow = { ...row };
    delete scalarRow.payload_json;
    requireCondition(
      !containsIdentifier(scalarRow, identifiers) &&
        !containsIdentifier(parsedPayload, identifiers),
      "CLEANUP_IDENTIFIER_REMAINS",
      `Production still contains a rehearsal identifier in ${tableId}.`,
    );
  }
}

export function assertCleanupUserReceipts(receipts, rehearsalUserIds) {
  const authUsersRemoved = receipts.reduce(
    (total, receipt) => total + receipt.authUsersRemoved,
    0,
  );
  const finalAuthUsersPreserved = receipts
    .filter((receipt) => receipt.organizationDeleted)
    .reduce((total, receipt) => total + receipt.authUsersPreserved, 0);
  requireCondition(
    authUsersRemoved === rehearsalUserIds.length &&
      finalAuthUsersPreserved === 0,
    "CLEANUP_USER_RECEIPT_INCOMPLETE",
    "Cleanup receipts do not prove exact automatic removal of both isolated rehearsal users at final organization deletion.",
  );
}

async function listAllRows(tables, databaseId, tableId) {
  const rows = [];
  let cursor;
  while (rows.length <= MAX_TABLE_ROWS) {
    const page = await tables.listRows({
      databaseId,
      tableId,
      queries: [
        Query.orderAsc("$id"),
        Query.limit(PAGE_SIZE),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
      total: false,
      ttl: 0,
    });
    rows.push(...page.rows);
    if (page.rows.length < PAGE_SIZE) break;
    const nextCursor = page.rows.at(-1)?.$id;
    requireCondition(
      typeof nextCursor === "string" &&
        nextCursor.length > 0 &&
        nextCursor !== cursor,
      "CLEANUP_PAGINATION_INVALID",
      `Cleanup verification could not advance ${tableId} pagination.`,
    );
    cursor = nextCursor;
  }
  requireCondition(
    rows.length <= MAX_TABLE_ROWS,
    "CLEANUP_TABLE_LIMIT_EXCEEDED",
    `${tableId} exceeds the cleanup verifier's row safety limit.`,
  );
  return rows;
}

async function expectRowAbsent(tables, databaseId, tableId, rowId) {
  try {
    await tables.getRow({ databaseId, tableId, rowId });
  } catch (error) {
    if (error?.code === 404) return;
    throw error;
  }
  fail(
    "CLEANUP_TARGET_ROW_REMAINS",
    `An approved ${tableId} target still exists.`,
  );
}

async function expectUserAbsent(users, userId) {
  try {
    await users.get({ userId });
  } catch (error) {
    if (error?.code === 404) return;
    throw error;
  }
  fail(
    "CLEANUP_REHEARSAL_USER_REMAINS",
    "A synthetic Production rehearsal user still exists.",
  );
}

async function requireEmptyBucket(storage, bucketId) {
  const files = await storage.listFiles({
    bucketId,
    queries: [Query.orderAsc("$id"), Query.limit(1)],
    total: false,
  });
  requireCondition(
    files.files.length === 0,
    "CLEANUP_STORAGE_NOT_EMPTY",
    "A Production private Storage bucket still contains a file.",
  );
}

export function privateEvidencePath(candidate, workspace = process.cwd()) {
  requireCondition(
    typeof candidate === "string" && candidate.trim(),
    "EVIDENCE_PATH_REQUIRED",
    "A private cleanup evidence path is required.",
  );
  const absolute = resolve(candidate);
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
      "Evidence inside the repository must be written beneath the ignored .tmp directory.",
    );
  }
  return absolute;
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST")
      fail(
        "EVIDENCE_PATH_EXISTS",
        "Cleanup evidence is immutable; choose a new output path.",
      );
    throw error;
  }
}

export function validateCleanupEvidenceBindings(environment = process.env) {
  const binding = (name) => {
    const value = environment[name]?.trim();
    if (!value) fail("ENVIRONMENT_REQUIRED", `${name} is required.`);
    return value;
  };
  const expectedProjectId = binding("KNOWHOW_CLEANUP_EXPECTED_PROJECT_ID");
  const forbiddenProjectId = binding("KNOWHOW_CLEANUP_FORBIDDEN_PROJECT_ID");
  const expectedRelease = binding("KNOWHOW_CLEANUP_EXPECTED_RELEASE");
  requireCondition(
    validId(expectedProjectId) &&
      validId(forbiddenProjectId) &&
      expectedProjectId !== forbiddenProjectId,
    "CLEANUP_PROJECT_BINDING_INVALID",
    "Cleanup evidence requires distinct reviewed Production and forbidden Staging project IDs.",
  );
  requireCondition(
    RELEASE_SHA.test(expectedRelease),
    "CLEANUP_RELEASE_BINDING_INVALID",
    "Cleanup evidence must bind to an exact 40-character release SHA.",
  );
  return { expectedProjectId, forbiddenProjectId, expectedRelease };
}

function appwriteServices(bindings) {
  const endpoint = controlledProductionEndpoint(
    requiredEnvironment("APPWRITE_ENDPOINT"),
  );
  const projectId = requiredEnvironment("APPWRITE_PROJECT_ID");
  const apiKey = requiredEnvironment("APPWRITE_API_KEY");
  const databaseId = requiredEnvironment("APPWRITE_DATABASE_ID");
  requireCondition(
    validId(projectId) &&
      projectId === bindings.expectedProjectId &&
      projectId !== bindings.forbiddenProjectId &&
      databaseId === "knowhow_core",
    "APPWRITE_RESOURCE_ID_INVALID",
    "Cleanup evidence is not bound to the reviewed Production project and knowhow_core database.",
  );
  requireCondition(
    apiKey.length >= 20 && !apiKey.toLowerCase().includes("replace-with-"),
    "APPWRITE_API_KEY_INVALID",
    "APPWRITE_API_KEY is invalid.",
  );
  const client = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setKey(apiKey);
  return {
    endpoint,
    projectId,
    databaseId,
    tables: new TablesDB(client),
    storage: new Storage(client),
    users: new Users(client),
  };
}

function evidenceKey() {
  const key = requiredEnvironment("KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY");
  const keyId = requiredEnvironment("KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY_ID");
  requireCondition(
    Buffer.byteLength(key, "utf8") >= 32 &&
      !key.toLowerCase().includes("replace-with-") &&
      ID_PATTERN.test(keyId),
    "EVIDENCE_HMAC_KEY_INVALID",
    "The cleanup evidence HMAC key or key ID is invalid.",
  );
  return { key, keyId };
}

function sealEvidence(payload, key, keyId) {
  return {
    ...payload,
    seal: {
      algorithm: "HMAC-SHA-256",
      keyId,
      hmac: keyedHash(canonicalJson(payload), key),
    },
  };
}

export function verifyCleanupEvidenceSeal(evidence, key, expectedKeyId) {
  requireCondition(
    Buffer.byteLength(key, "utf8") >= 32,
    "EVIDENCE_HMAC_KEY_INVALID",
    "The cleanup evidence HMAC key must contain at least 32 bytes.",
  );
  requireCondition(
    evidence?.seal?.algorithm === "HMAC-SHA-256" &&
      evidence.seal.keyId === expectedKeyId &&
      SHA256_PATTERN.test(String(evidence.seal.hmac)),
    "EVIDENCE_SEAL_INVALID",
    "The cleanup evidence seal is missing, malformed, or uses another key ID.",
  );
  const payload = { ...evidence };
  delete payload.seal;
  const expected = Buffer.from(keyedHash(canonicalJson(payload), key), "hex");
  const actual = Buffer.from(evidence.seal.hmac, "hex");
  requireCondition(
    actual.length === expected.length && timingSafeEqual(actual, expected),
    "EVIDENCE_SEAL_MISMATCH",
    "The cleanup evidence seal does not match its contents.",
  );
  requireCondition(
    payload &&
      exactKeys(payload, [
        "evidenceVersion",
        "kind",
        "checkedAt",
        "release",
        "environment",
        "source",
        "cleanup",
        "attestations",
      ]) &&
      payload.evidenceVersion === EVIDENCE_VERSION &&
      payload.kind === "knowhow-production-cleanup-evidence" &&
      payload.environment === "production" &&
      validIso(payload.checkedAt) &&
      RELEASE_SHA.test(String(payload.release ?? "")) &&
      exactKeys(payload.source ?? {}, [
        "endpointOrigin",
        "projectFingerprint",
        "databaseId",
      ]) &&
      payload.source.endpointOrigin === "https://fra.cloud.appwrite.io" &&
      SHA256_PATTERN.test(String(payload.source.projectFingerprint ?? "")) &&
      payload.source.databaseId === "knowhow_core" &&
      exactKeys(payload.cleanup ?? {}, [
        "tableCount",
        "totalRowsScanned",
        "receipts",
        "rehearsalUserFingerprints",
        "privateFiles",
        "exportFiles",
        "scopedRows",
        "rehearsalUsersPresent",
      ]) &&
      payload.cleanup.tableCount === 40 &&
      validCount(payload.cleanup.totalRowsScanned) &&
      payload.cleanup.scopedRows === 0 &&
      payload.cleanup.rehearsalUsersPresent === 0 &&
      payload.cleanup.privateFiles === 0 &&
      payload.cleanup.exportFiles === 0 &&
      Array.isArray(payload.cleanup.receipts) &&
      payload.cleanup.receipts.length > 0 &&
      payload.cleanup.receipts.length <= 10 &&
      payload.cleanup.receipts.every(
        (receipt) =>
          receipt &&
          exactKeys(receipt, [
            "caseFingerprint",
            "workspaceHash",
            "organizationHash",
            "organizationDeleted",
            "deletedRows",
            "deletedFiles",
            "authUsersRemoved",
            "authUsersPreserved",
            "completedAt",
          ]) &&
          SHA256_PATTERN.test(String(receipt.caseFingerprint ?? "")) &&
          SHA256_PATTERN.test(String(receipt.workspaceHash ?? "")) &&
          SHA256_PATTERN.test(String(receipt.organizationHash ?? "")) &&
          typeof receipt.organizationDeleted === "boolean" &&
          validCount(receipt.deletedRows) &&
          receipt.deletedRows > 0 &&
          validCount(receipt.deletedFiles) &&
          validCount(receipt.authUsersRemoved) &&
          validCount(receipt.authUsersPreserved) &&
          validIso(receipt.completedAt),
      ) &&
      new Set(
        payload.cleanup.receipts.map((receipt) => receipt.caseFingerprint),
      ).size === payload.cleanup.receipts.length &&
      Array.isArray(payload.cleanup.rehearsalUserFingerprints) &&
      payload.cleanup.rehearsalUserFingerprints.length === 2 &&
      payload.cleanup.rehearsalUserFingerprints.every((fingerprint) =>
        SHA256_PATTERN.test(String(fingerprint ?? "")),
      ) &&
      new Set(payload.cleanup.rehearsalUserFingerprints).size === 2 &&
      exactKeys(payload.attestations ?? {}, [
        "finalProductionProject",
        "syntheticDataOnly",
        "readOnlyVerification",
      ]) &&
      payload.attestations.finalProductionProject === true &&
      payload.attestations.syntheticDataOnly === true &&
      payload.attestations.readOnlyVerification === true,
    "EVIDENCE_PAYLOAD_INVALID",
    "The sealed file is not a passing KnowHow Production cleanup report.",
  );
  return payload;
}

async function tableManifest() {
  return JSON.parse(
    await readFile(
      new URL("../infrastructure/appwrite/tables.json", import.meta.url),
      "utf8",
    ),
  );
}

export async function verifyProductionCleanup(input) {
  const {
    services,
    tables: manifest,
    targets,
    rehearsalUserIds,
    receiptPepper,
    evidenceHmacKey,
  } = input;
  const identifiers = new Set([
    ...targets.flatMap((target) => [
      target.caseId,
      target.organizationId,
      target.workspaceId,
    ]),
    ...rehearsalUserIds,
  ]);
  const receipts = [];
  for (const target of targets) {
    await Promise.all([
      expectRowAbsent(
        services.tables,
        services.databaseId,
        "organizations",
        target.organizationId,
      ),
      expectRowAbsent(
        services.tables,
        services.databaseId,
        "workspaces",
        target.workspaceId,
      ),
    ]);
    const row = await services.tables.getRow({
      databaseId: services.databaseId,
      tableId: "lifecycle_cases",
      rowId: target.caseId,
    });
    receipts.push(validateCleanupReceipt(row, target, receiptPepper));
  }
  await Promise.all(
    rehearsalUserIds.map((userId) => expectUserAbsent(services.users, userId)),
  );
  await Promise.all([
    requireEmptyBucket(services.storage, input.privateBucketId),
    requireEmptyBucket(services.storage, input.exportsBucketId),
  ]);
  let totalRowsScanned = 0;
  for (const table of manifest) {
    const rows = await listAllRows(
      services.tables,
      services.databaseId,
      table.$id,
    );
    totalRowsScanned += rows.length;
    if (table.$id === "lifecycle_cases") {
      const expectedCaseIds = new Set(targets.map((target) => target.caseId));
      requireCondition(
        rows.every(
          (row) =>
            row.kind !== "tenant_deletion_approval" ||
            row.status !== "completed" ||
            expectedCaseIds.has(row.$id),
        ),
        "CLEANUP_RECEIPT_UNDECLARED",
        "Production contains a completed deletion receipt missing from the cleanup target manifest.",
      );
    }
    const rowsWithoutExpectedReceipts =
      table.$id === "lifecycle_cases"
        ? rows.filter(
            (row) => !targets.some((target) => target.caseId === row.$id),
          )
        : rows;
    assertRowsAreClean(table.$id, rowsWithoutExpectedReceipts, identifiers);
  }
  assertCleanupUserReceipts(receipts, rehearsalUserIds);
  return {
    tableCount: manifest.length,
    totalRowsScanned,
    receipts: receipts.map((receipt, index) => ({
      caseFingerprint: keyedHash(
        `case\0${targets[index].caseId}`,
        evidenceHmacKey,
      ),
      ...receipt,
    })),
    rehearsalUserFingerprints: rehearsalUserIds.map((userId) =>
      keyedHash(`user\0${userId}`, evidenceHmacKey),
    ),
    privateFiles: 0,
    exportFiles: 0,
    scopedRows: 0,
    rehearsalUsersPresent: 0,
  };
}

async function run() {
  requireCondition(
    requiredEnvironment("KNOWHOW_ENVIRONMENT") === "production",
    "ENVIRONMENT_NOT_PRODUCTION",
    "Cleanup evidence runs only against Production.",
  );
  requireAttestation("KNOWHOW_CLEANUP_SYNTHETIC_ONLY");
  requireAttestation("KNOWHOW_CLEANUP_FINAL_PRODUCTION");
  const targets = validateCleanupTargets(
    parseJsonEnvironment("KNOWHOW_CLEANUP_TARGETS_JSON"),
  );
  const rehearsalUserIds = validateRehearsalUserIds(
    parseJsonEnvironment("KNOWHOW_CLEANUP_USER_IDS_JSON"),
  );
  const receiptPepper = requiredEnvironment(
    "KNOWHOW_DELETION_RECEIPT_PEPPER",
  );
  const evidence = evidenceKey();
  const bindings = validateCleanupEvidenceBindings();
  const release = requiredEnvironment("KNOWHOW_RELEASE");
  requireCondition(
    release === bindings.expectedRelease,
    "CLEANUP_RELEASE_BINDING_INVALID",
    "The cleanup verifier release does not match the reviewed deployed release.",
  );
  const services = appwriteServices(bindings);
  const manifest = await tableManifest();
  requireCondition(
    manifest.length === 40,
    "CLEANUP_SCHEMA_BINDING_INVALID",
    "Cleanup verification requires the exact 40-table private schema.",
  );
  const privateBucketId =
    process.env.APPWRITE_PRIVATE_MEDIA_BUCKET_ID || "knowhow_private_media";
  const exportsBucketId =
    process.env.APPWRITE_EXPORTS_BUCKET_ID || "knowhow_exports";
  requireCondition(
    privateBucketId === "knowhow_private_media" &&
      exportsBucketId === "knowhow_exports",
    "CLEANUP_BUCKET_BINDING_INVALID",
    "Cleanup evidence requires the two stable Production private bucket IDs.",
  );
  const checkedAt = new Date().toISOString();
  const result = await verifyProductionCleanup({
    services,
    tables: manifest,
    targets,
    rehearsalUserIds,
    receiptPepper,
    evidenceHmacKey: evidence.key,
    privateBucketId,
    exportsBucketId,
  });
  const payload = {
    evidenceVersion: EVIDENCE_VERSION,
    kind: "knowhow-production-cleanup-evidence",
    checkedAt,
    release,
    environment: "production",
    source: {
      endpointOrigin: new URL(services.endpoint).origin,
      projectFingerprint: sha256(`project\0${services.projectId}`),
      databaseId: services.databaseId,
    },
    cleanup: result,
    attestations: {
      finalProductionProject: true,
      syntheticDataOnly: true,
      readOnlyVerification: true,
    },
  };
  const sealed = sealEvidence(payload, evidence.key, evidence.keyId);
  const outputPath = privateEvidencePath(
    requiredEnvironment("KNOWHOW_CLEANUP_EVIDENCE_PATH"),
  );
  await writeEvidence(outputPath, sealed);
  return {
    status: "passed",
    kind: payload.kind,
    release: payload.release,
    receiptCount: result.receipts.length,
    rehearsalUsersPresent: 0,
    scopedRows: 0,
    privateFiles: 0,
    exportFiles: 0,
    evidencePath: outputPath,
  };
}

async function verifySavedEvidence() {
  const path = privateEvidencePath(
    requiredEnvironment("KNOWHOW_CLEANUP_EVIDENCE_PATH"),
  );
  let evidence;
  try {
    evidence = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT")
      fail("EVIDENCE_FILE_NOT_FOUND", "The cleanup evidence file was not found.");
    if (error instanceof SyntaxError)
      fail("EVIDENCE_FILE_INVALID", "The cleanup evidence file is not valid JSON.");
    throw error;
  }
  const key = evidenceKey();
  const bindings = validateCleanupEvidenceBindings();
  const payload = verifyCleanupEvidenceSeal(evidence, key.key, key.keyId);
  requireCondition(
    payload.release === bindings.expectedRelease &&
      payload.source.projectFingerprint ===
        sha256(`project\0${bindings.expectedProjectId}`),
    "EVIDENCE_BINDING_INVALID",
    "The cleanup evidence belongs to another release or Appwrite project.",
  );
  return {
    status: "passed",
    kind: payload.kind,
    release: payload.release,
    checkedAt: payload.checkedAt,
    receiptCount: payload.cleanup.receipts.length,
    evidencePath: path,
  };
}

function safeFailure(error) {
  if (error instanceof CleanupEvidenceError)
    return { status: "failed", code: error.code, message: error.message };
  if (error instanceof AppwriteException)
    return {
      status: "failed",
      code: `APPWRITE_${error.code || "REQUEST_FAILED"}`,
      message: "An Appwrite cleanup verification request failed.",
    };
  return {
    status: "failed",
    code: "CLEANUP_EVIDENCE_FAILED",
    message: "Production cleanup evidence generation failed.",
  };
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry && entry === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const operation =
    command === undefined || command === "capture"
      ? run()
      : command === "verify"
        ? verifySavedEvidence()
        : Promise.reject(
            new CleanupEvidenceError(
              "COMMAND_INVALID",
              "Use `capture` (or no argument) for the live gate, or `verify` for saved evidence.",
            ),
          );
  operation
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
      process.exitCode = 1;
    });
}
