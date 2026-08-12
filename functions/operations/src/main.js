import {
  Client,
  Messaging,
  Query,
  Storage,
  TablesDB,
  Users,
} from "node-appwrite";

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || "knowhow_core";
const PRIVATE_BUCKET =
  process.env.APPWRITE_PRIVATE_MEDIA_BUCKET_ID || "knowhow_private_media";
const EXPORTS_BUCKET =
  process.env.APPWRITE_EXPORTS_BUCKET_ID || "knowhow_exports";
const DAY = 86_400_000;
const MAX_PAGE_TOTAL = 50_000;
const PROVISIONING_DRAFT_RETENTION_DAYS = 30;

const PURGE_TABLES = [
  "guide_steps",
  "guide_audiences",
  "review_assignments",
  "guide_revisions",
  "captures",
  "completions",
  "private_media",
  "guides",
  "group_memberships",
  "workspace_groups",
  "workspace_settings",
  "workspace_members",
  "invitations",
  "initial_admin_appointments",
  "extension_devices",
  "support_cases",
  "support_grants",
  "support_tickets",
  "support_messages",
  "usage_events",
  "usage_rollups",
  "entitlements",
  "manual_invoices",
  "export_jobs",
  "idempotency_keys",
  "provisioning_runs",
  "onboarding_progress",
  "audit_segments",
  "notification_deliveries",
];
const ORGANIZATION_PURGE_TABLES = [
  "organizations",
  "organization_branding",
  "organization_domains",
  "organization_memberships",
  "workspaces",
  "workspace_settings",
  "workspace_members",
  "workspace_groups",
  "group_memberships",
  "guides",
  "guide_revisions",
  "guide_steps",
  "guide_audiences",
  "review_assignments",
  "captures",
  "completions",
  "private_media",
  "invitations",
  "initial_admin_appointments",
  "extension_devices",
  "support_cases",
  "support_grants",
  "audit_segments",
  "subscriptions",
  "entitlements",
  "usage_events",
  "usage_rollups",
  "manual_invoices",
  "support_tickets",
  "support_messages",
  "notification_deliveries",
  "lifecycle_cases",
  "export_jobs",
  "idempotency_keys",
  "provisioning_runs",
  "onboarding_progress",
];
const USER_REFERENCE_TABLES = [
  ...ORGANIZATION_PURGE_TABLES,
  "platform_roles",
  "catalog_items",
  "leads",
];

function services(req) {
  const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT;
  const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID;
  const apiKey =
    req?.headers?.["x-appwrite-key"] ||
    process.env.APPWRITE_FUNCTION_API_KEY;
  if (!endpoint || !projectId || !apiKey)
    throw new Error("APPWRITE_FUNCTION_CONTEXT_REQUIRED");
  const client = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setKey(apiKey);
  return {
    tables: new TablesDB(client),
    storage: new Storage(client),
    messaging: new Messaging(client),
    users: new Users(client),
  };
}

function payload(row, fallback = {}) {
  try {
    const parsed = JSON.parse(row.payload_json || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function fields(values, value) {
  return { ...values, payload_json: JSON.stringify(value) };
}

function date(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

async function hash(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function receiptHash(value) {
  const pepper = process.env.KNOWHOW_DELETION_RECEIPT_PEPPER || "";
  if (pepper.length < 32)
    throw new Error("DELETION_RECEIPT_PEPPER_NOT_CONFIGURED");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function constantTimeHexEqual(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    left.length !== right.length ||
    !/^[0-9a-f]+$/.test(left) ||
    !/^[0-9a-f]+$/.test(right)
  ) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("INVALID_BASE64URL");
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function notificationKeyring() {
  const configured = process.env.KNOWHOW_TOKEN_KEYS_JSON || "";
  const activeKeyId = process.env.KNOWHOW_TOKEN_ACTIVE_KID || "";
  const parsed = JSON.parse(configured);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("NOTIFICATION_KEYRING_INVALID");
  const entries = Object.entries(parsed);
  if (
    !entries.length ||
    entries.some(
      ([keyId, secret]) =>
        !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) ||
        typeof secret !== "string" ||
        new TextEncoder().encode(secret).byteLength < 32,
    ) ||
    typeof parsed[activeKeyId] !== "string"
  ) {
    throw new Error("NOTIFICATION_KEYRING_INVALID");
  }
  return parsed;
}

async function notificationEncryptionKey(secret) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`knowhow.notification.v1\0${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
}

async function decryptNotificationCredential(envelope, row) {
  if (
    !envelope ||
    envelope.version !== 1 ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(envelope.keyId)
  ) {
    throw new Error("NOTIFICATION_CREDENTIAL_INVALID");
  }
  const keyring = notificationKeyring();
  const secret = keyring[envelope.keyId];
  if (typeof secret !== "string")
    throw new Error("NOTIFICATION_CREDENTIAL_KEY_UNKNOWN");
  const additionalData = new TextEncoder().encode(
    JSON.stringify([
      row.kind,
      row.subject_id,
      String(row.email || "").trim().toLowerCase(),
    ]),
  );
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64Url(envelope.iv),
        additionalData,
        tagLength: 128,
      },
      await notificationEncryptionKey(secret),
      decodeBase64Url(envelope.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("NOTIFICATION_CREDENTIAL_DECRYPT_FAILED");
  }
}

function scrubNotificationCredential(details) {
  const scrubbed = { ...details };
  delete scrubbed.credential;
  delete scrubbed.credentialEnvelope;
  return scrubbed;
}

async function stableId(prefix, value) {
  return `${prefix}_${(await hash(value)).slice(0, 35 - prefix.length)}`;
}

async function listAll(tables, tableId, queries = [], limit = MAX_PAGE_TOTAL) {
  const rows = [];
  let cursor;
  while (rows.length < limit) {
    const size = Math.min(100, limit - rows.length);
    const page = await tables.listRows({
      databaseId: DATABASE_ID,
      tableId,
      queries: [
        ...queries,
        Query.orderAsc("$id"),
        Query.limit(size),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
      total: false,
    });
    rows.push(...page.rows);
    if (page.rows.length < size) break;
    cursor = page.rows.at(-1)?.$id;
    if (!cursor) break;
  }
  return rows;
}

async function listAllFiles(storage, bucketId, limit = MAX_PAGE_TOTAL) {
  const files = [];
  let cursor;
  while (files.length < limit) {
    const size = Math.min(100, limit - files.length);
    const page = await storage.listFiles({
      bucketId,
      queries: [
        Query.orderAsc("$id"),
        Query.limit(size),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
      total: false,
    });
    files.push(...page.files);
    if (page.files.length < size) break;
    cursor = page.files.at(-1)?.$id;
    if (!cursor) break;
  }
  return files;
}

const WORKSPACE_TARGET_TABLES = [
  ...PURGE_TABLES,
  "subscriptions",
  "lifecycle_cases",
];
const WORKSPACE_TARGET_TABLE_SET = new Set([
  ...WORKSPACE_TARGET_TABLES,
  "workspaces",
]);
const ORGANIZATION_PURGE_TABLE_SET = new Set(ORGANIZATION_PURGE_TABLES);

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function listAllExact(tables, tableId, queries = []) {
  const rows = await listAll(tables, tableId, queries, MAX_PAGE_TOTAL + 1);
  if (rows.length > MAX_PAGE_TOTAL)
    throw new Error(`PURGE_TARGET_LIMIT_EXCEEDED:${tableId}`);
  return rows;
}

async function getRowOrNull(tables, tableId, rowId) {
  try {
    return await tables.getRow({ databaseId: DATABASE_ID, tableId, rowId });
  } catch (caught) {
    if (caught?.code === 404) return null;
    throw caught;
  }
}

function addTarget(targets, tableId, row) {
  let rows = targets.get(tableId);
  if (!rows) {
    rows = new Map();
    targets.set(tableId, rows);
  }
  rows.set(row.$id, row);
}

function targetKey(tableId, rowId) {
  return `${tableId}\0${rowId}`;
}

function targetManifest(targets) {
  return [...targets.entries()]
    .map(([tableId, rows]) => ({
      tableId,
      rowIds: sortedUnique(rows.keys()),
    }))
    .filter((entry) => entry.rowIds.length)
    .sort((left, right) => left.tableId.localeCompare(right.tableId));
}

function targetKeys(targets) {
  const keys = new Set();
  for (const [tableId, rows] of targets)
    for (const rowId of rows.keys()) keys.add(targetKey(tableId, rowId));
  return keys;
}

function rowsFromTargets(targets) {
  return [...targets.values()].flatMap((rows) => [...rows.values()]);
}

function fileManifest(targets) {
  const byBucket = new Map([
    ["private", new Set()],
    ["exports", new Set()],
  ]);
  for (const [tableId, rows] of targets) {
    if (!['private_media', 'export_jobs'].includes(tableId)) continue;
    for (const row of rows.values()) {
      const fileId =
        tableId === "private_media"
          ? payload(row).storageFileId
          : payload(row).outputFileId;
      if (typeof fileId === "string" && fileId)
        byBucket
          .get(tableId === "private_media" ? "private" : "exports")
          .add(fileId);
    }
  }
  return [...byBucket.entries()]
    .map(([bucket, fileIds]) => ({ bucket, fileIds: sortedUnique(fileIds) }))
    .filter((entry) => entry.fileIds.length)
    .sort((left, right) => left.bucket.localeCompare(right.bucket));
}

function manifestCount(manifest, property) {
  return manifest.reduce((total, entry) => total + entry[property].length, 0);
}

function assertWorkspaceScope(rows, tableId, workspaceId, organizationId) {
  for (const row of rows) {
    if (row.organization_id !== organizationId)
      throw new Error(
        `PURGE_SCOPE_MISMATCH:${tableId}:${workspaceId}:${row.$id}`,
      );
  }
}

async function collectWorkspaceTargets(
  tables,
  workspaceId,
  organizationId,
  receiptCaseId,
  requireWorkspace,
) {
  const targets = new Map();
  for (const tableId of WORKSPACE_TARGET_TABLES) {
    const rows = await listAllExact(tables, tableId, [
      Query.equal("workspace_id", [workspaceId]),
    ]);
    assertWorkspaceScope(rows, tableId, workspaceId, organizationId);
    for (const row of rows) {
      if (tableId === "lifecycle_cases" && row.$id === receiptCaseId) continue;
      addTarget(targets, tableId, row);
    }
  }
  const workspace = await getRowOrNull(tables, "workspaces", workspaceId);
  if (requireWorkspace && !workspace)
    throw new Error(`PURGE_WORKSPACE_NOT_FOUND:${workspaceId}`);
  if (workspace) {
    assertWorkspaceScope(
      [workspace],
      "workspaces",
      workspaceId,
      organizationId,
    );
    addTarget(targets, "workspaces", workspace);
  }
  return targets;
}

async function collectOrganizationTargets(
  tables,
  organizationId,
  receiptCaseId,
  excludedKeys = new Set(),
) {
  const targets = new Map();
  for (const tableId of ORGANIZATION_PURGE_TABLES) {
    if (tableId === "organizations") continue;
    const rows = await listAllExact(tables, tableId);
    for (const row of rows) {
      if (
        row.organization_id !== organizationId ||
        (tableId === "lifecycle_cases" && row.$id === receiptCaseId) ||
        excludedKeys.has(targetKey(tableId, row.$id))
      ) {
        continue;
      }
      addTarget(targets, tableId, row);
    }
  }
  const organization = await getRowOrNull(
    tables,
    "organizations",
    organizationId,
  );
  if (
    organization &&
    !excludedKeys.has(targetKey("organizations", organizationId))
  ) {
    addTarget(targets, "organizations", organization);
  }
  return targets;
}

function candidateUserIds(...targetSets) {
  return sortedUnique(
    targetSets
      .flatMap((targets) => rowsFromTargets(targets))
      .map((row) => row.user_id)
      .filter((userId) => typeof userId === "string" && userId),
  );
}

async function buildPurgePlan(
  tables,
  workspaceId,
  organizationId,
  organizationDeleted,
  createdAt,
  receiptCaseId,
) {
  if (typeof receiptCaseId !== "string" || !receiptCaseId)
    throw new Error("PURGE_RECEIPT_CASE_REQUIRED");
  const organization = await getRowOrNull(
    tables,
    "organizations",
    organizationId,
  );
  if (!organization)
    throw new Error(`PURGE_ORGANIZATION_NOT_FOUND:${organizationId}`);
  const workspaceTargets = await collectWorkspaceTargets(
    tables,
    workspaceId,
    organizationId,
    receiptCaseId,
    true,
  );
  const organizationTargets = organizationDeleted
    ? await collectOrganizationTargets(
        tables,
        organizationId,
        receiptCaseId,
        targetKeys(workspaceTargets),
      )
    : new Map();
  const workspaceTargetManifest = targetManifest(workspaceTargets);
  const organizationTargetManifest = targetManifest(organizationTargets);
  const workspaceFileTargets = fileManifest(workspaceTargets);
  const organizationFileTargets = fileManifest(organizationTargets);
  const plan = {
    version: 3,
    createdAt,
    workspaceRows: manifestCount(workspaceTargetManifest, "rowIds"),
    workspaceFiles: manifestCount(workspaceFileTargets, "fileIds"),
    organizationDeleted,
    organizationRows: manifestCount(organizationTargetManifest, "rowIds"),
    organizationFiles: manifestCount(organizationFileTargets, "fileIds"),
    workspaceTargets: workspaceTargetManifest,
    workspaceFileTargets,
    organizationTargets: organizationTargetManifest,
    organizationFileTargets,
    candidateUserIds: candidateUserIds(workspaceTargets, organizationTargets),
  };
  return {
    ...plan,
    bindingHash: await purgePlanBindingHash(
      plan,
      receiptCaseId,
      organizationId,
      workspaceId,
    ),
  };
}

function unsignedPurgePlan(plan) {
  const unsigned = { ...plan };
  delete unsigned.bindingHash;
  return unsigned;
}

async function purgePlanBindingHash(
  plan,
  receiptCaseId,
  organizationId,
  workspaceId,
) {
  return receiptHash(
    `purge-plan\0${receiptCaseId}\0${organizationId}\0${workspaceId}\0${JSON.stringify(unsignedPurgePlan(plan))}`,
  );
}

async function verifyPurgePlanBinding(
  plan,
  receiptCaseId,
  organizationId,
  workspaceId,
) {
  return constantTimeHexEqual(
    plan.bindingHash,
    await purgePlanBindingHash(
      plan,
      receiptCaseId,
      organizationId,
      workspaceId,
    ),
  );
}

function validStringList(values) {
  return (
    Array.isArray(values) &&
    values.every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 128,
    ) &&
    values.every((value, index) => index === 0 || values[index - 1] < value)
  );
}

function disjointManifests(left, right, keySet) {
  const leftKeys = keySet(left);
  return [...keySet(right)].every((key) => !leftKeys.has(key));
}

function validTargetManifest(manifest, allowedTables) {
  return (
    Array.isArray(manifest) &&
    manifest.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        allowedTables.has(entry.tableId) &&
        validStringList(entry.rowIds),
    ) &&
    manifest.every(
      (entry, index) =>
        index === 0 || manifest[index - 1].tableId < entry.tableId,
    )
  );
}

function validFileManifest(manifest) {
  return (
    Array.isArray(manifest) &&
    manifest.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        ["exports", "private"].includes(entry.bucket) &&
        validStringList(entry.fileIds),
    ) &&
    manifest.every(
      (entry, index) => index === 0 || manifest[index - 1].bucket < entry.bucket,
    )
  );
}

function validPurgePlan(value) {
  return (
    value?.version === 3 &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.bindingHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.bindingHash) &&
    typeof value.organizationDeleted === "boolean" &&
    validTargetManifest(value.workspaceTargets, WORKSPACE_TARGET_TABLE_SET) &&
    validTargetManifest(
      value.organizationTargets,
      ORGANIZATION_PURGE_TABLE_SET,
    ) &&
    validFileManifest(value.workspaceFileTargets) &&
    validFileManifest(value.organizationFileTargets) &&
    validStringList(value.candidateUserIds) &&
    value.candidateUserIds.every((userId) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(userId),
    ) &&
    disjointManifests(
      value.workspaceTargets,
      value.organizationTargets,
      manifestKeySet,
    ) &&
    disjointManifests(
      value.workspaceFileTargets,
      value.organizationFileTargets,
      fileManifestKeySet,
    ) &&
    value.workspaceRows === manifestCount(value.workspaceTargets, "rowIds") &&
    value.workspaceFiles ===
      manifestCount(value.workspaceFileTargets, "fileIds") &&
    value.organizationRows ===
      manifestCount(value.organizationTargets, "rowIds") &&
    value.organizationFiles ===
      manifestCount(value.organizationFileTargets, "fileIds") &&
    value.workspaceRows > 0 &&
    (value.organizationDeleted
      ? value.organizationRows > 0
      : value.organizationRows === 0 &&
        value.organizationFiles === 0 &&
        value.organizationTargets.length === 0 &&
        value.organizationFileTargets.length === 0)
  );
}

async function createOnce(tables, tableId, rowId, data) {
  try {
    await tables.createRow({
      databaseId: DATABASE_ID,
      tableId,
      rowId,
      data,
      permissions: [],
    });
    return true;
  } catch (caught) {
    if (caught && typeof caught === "object" && caught.code === 409)
      return false;
    throw caught;
  }
}

async function queueNotice(tables, input) {
  const rowId = await stableId("notice", input.idempotencyKey);
  return createOnce(
    tables,
    "notification_deliveries",
    rowId,
    fields(
      {
        organization_id: input.organizationId || null,
        workspace_id: input.workspaceId || null,
        user_id: input.userId || null,
        email: input.email || null,
        kind: input.kind,
        subject_id: input.subjectId,
        status: "queued",
        scheduled_at: input.scheduledAt,
        idempotency_key: input.idempotencyKey,
        created_by: "knowhow_ops",
      },
      input.details || {},
    ),
  );
}

function normalizedSubscription(row) {
  const value = payload(row);
  return {
    ...value,
    kind: value.kind || row.kind || "design_partner",
    status: value.status || row.status || "active",
    startsAt: value.startsAt || row.$createdAt,
    expiresAt: value.expiresAt || null,
    graceDays: Number.isInteger(value.graceDays)
      ? Math.min(30, Math.max(0, value.graceDays))
      : 7,
    retentionDays: Number.isInteger(value.retentionDays)
      ? Math.min(365, Math.max(30, value.retentionDays))
      : 90,
    publicTrial: false,
    manualContract: value.manualContract !== false,
  };
}

function evaluate(subscription, now) {
  const expiry = date(subscription.expiresAt);
  const graceEnd =
    expiry === null ? null : expiry + subscription.graceDays * DAY;
  const eligible =
    expiry === null ? null : expiry + subscription.retentionDays * DAY;
  let access = "active";
  if (subscription.status === "deleted") access = "deleted";
  else if (subscription.status === "deleting") access = "deleting";
  else if (subscription.status === "deletion_pending")
    access = "deletion_pending";
  else if (subscription.status === "cancelled") access = "suspended";
  else if (
    expiry !== null &&
    now >= expiry &&
    graceEnd !== null &&
    now < graceEnd
  )
    access = "read_only";
  else if (expiry !== null && eligible !== null && now >= eligible)
    access = "deletion_pending";
  else if (expiry !== null && graceEnd !== null && now >= graceEnd)
    access = "suspended";
  return { access, expiry, graceEnd, eligible };
}

function lifecycleNotices(subscription) {
  const start = date(subscription.startsAt);
  const expiry = date(subscription.expiresAt);
  if (start === null || expiry === null) return [];
  const prefix =
    subscription.kind === "trial"
      ? "trial"
      : subscription.kind === "design_partner"
        ? "pilot"
        : "subscription";
  const graceEnd = expiry + subscription.graceDays * DAY;
  const eligible = expiry + subscription.retentionDays * DAY;
  return [
    [`${prefix}.welcome`, start],
    ...(subscription.kind === "trial"
      ? [["trial.activation_help", start + 7 * DAY]]
      : []),
    [`${prefix}.expiry_4d`, expiry - 4 * DAY],
    [`${prefix}.expiry_1d`, expiry - DAY],
    [`${prefix}.expired`, expiry],
    [
      `${prefix}.grace_midpoint`,
      expiry + Math.floor(subscription.graceDays / 2) * DAY,
    ],
    [`${prefix}.grace_1d`, graceEnd - DAY],
    [`${prefix}.suspended`, graceEnd],
    ["retention.30d_after_expiry", expiry + 30 * DAY],
    ["retention.eligibility_7d", eligible - 7 * DAY],
    ["retention.eligibility_1d", eligible - DAY],
  ];
}

async function runLifecycle({ tables }, now) {
  const subscriptions = await listAll(tables, "subscriptions");
  let transitions = 0;
  let queued = 0;
  let skippedDeleted = 0;
  for (const row of subscriptions) {
    if (!row.workspace_id) continue;
    const subscription = normalizedSubscription(row);
    if (subscription.status === "deleted") {
      skippedDeleted += 1;
      continue;
    }
    const result = evaluate(subscription, now.getTime());
    const status =
      result.access === "read_only"
        ? "grace"
        : result.access === "active"
          ? "active"
          : result.access;
    if (subscription.status !== status) transitions += 1;
    await tables.updateRow({
      databaseId: DATABASE_ID,
      tableId: "subscriptions",
      rowId: row.$id,
      data: fields(
        { status, kind: subscription.kind, updated_by: "knowhow_ops" },
        { ...subscription, status, lastEvaluatedAt: now.toISOString() },
      ),
      permissions: [],
    });
    let workspace;
    try {
      workspace = await tables.getRow({
        databaseId: DATABASE_ID,
        tableId: "workspaces",
        rowId: row.workspace_id,
      });
    } catch {
      continue;
    }
    const workspaceData = payload(workspace);
    const suspend = [
      "suspended",
      "deletion_pending",
      "deleting",
      "deleted",
    ].includes(result.access);
    if (
      suspend &&
      (workspace.status !== "suspended" ||
        workspaceData.suspensionReason !== "lifecycle")
    ) {
      await tables.updateRow({
        databaseId: DATABASE_ID,
        tableId: "workspaces",
        rowId: workspace.$id,
        data: fields(
          { status: "suspended", updated_by: "knowhow_ops" },
          {
            ...workspaceData,
            status: "suspended",
            suspensionReason: "lifecycle",
          },
        ),
        permissions: [],
      });
    } else if (
      !suspend &&
      workspace.status === "suspended" &&
      workspaceData.suspensionReason === "lifecycle"
    ) {
      await tables.updateRow({
        databaseId: DATABASE_ID,
        tableId: "workspaces",
        rowId: workspace.$id,
        data: fields(
          { status: "active", updated_by: "knowhow_ops" },
          { ...workspaceData, status: "active", suspensionReason: null },
        ),
        permissions: [],
      });
    }
    const members = await listAll(tables, "workspace_members", [
      Query.equal("workspace_id", [row.workspace_id]),
      Query.equal("status", ["active"]),
    ]);
    const administrators = members.filter((member) =>
      (payload(member).roles || []).includes("administrator"),
    );
    const details = {
      workspaceName: workspaceData.name || "KnowHow workspace",
      expiresAt:
        result.expiry === null ? null : new Date(result.expiry).toISOString(),
      graceEndsAt:
        result.graceEnd === null
          ? null
          : new Date(result.graceEnd).toISOString(),
      deletionEligibleAt:
        result.eligible === null
          ? null
          : new Date(result.eligible).toISOString(),
    };
    for (const [kind, milestone] of lifecycleNotices(subscription)) {
      if (milestone > now.getTime()) continue;
      for (const administrator of administrators) {
        if (!administrator.email) continue;
        if (
          await queueNotice(tables, {
            organizationId: workspace.organization_id,
            workspaceId: workspace.$id,
            userId: administrator.user_id,
            email: administrator.email,
            kind,
            subjectId: row.$id,
            scheduledAt: now.toISOString(),
            idempotencyKey: `${row.$id}:${kind}:${administrator.user_id}`,
            details,
          })
        )
          queued += 1;
      }
    }
    if (result.access !== "deletion_pending" || result.eligible === null)
      continue;
    const caseId = await stableId("delete", `${row.$id}:tenant-deletion`);
    const organization = await tables
      .getRow({
        databaseId: DATABASE_ID,
        tableId: "organizations",
        rowId: workspace.organization_id,
      })
      .catch(() => null);
    const organizationData = organization ? payload(organization) : {};
    await createOnce(
      tables,
      "lifecycle_cases",
      caseId,
      fields(
        {
          organization_id: workspace.organization_id,
          workspace_id: workspace.$id,
          subject_id: row.$id,
          kind: "tenant_deletion_approval",
          status: "awaiting_approval",
          scheduled_at: now.toISOString(),
          created_by: "knowhow_ops",
        },
        {
          kind: "tenant_deletion_approval",
          subscriptionId: row.$id,
          status: "awaiting_approval",
          eligibleAt: new Date(result.eligible).toISOString(),
          confirmationText: `DELETE ${organizationData.displayName || workspaceData.name}`,
          createdAt: now.toISOString(),
        },
      ),
    );
    const day = now.toISOString().slice(0, 10);
    for (const email of (process.env.KNOWHOW_PLATFORM_OWNER_EMAILS || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)) {
      if (
        await queueNotice(tables, {
          organizationId: workspace.organization_id,
          workspaceId: workspace.$id,
          email,
          kind: "deletion.approval_overdue",
          subjectId: caseId,
          scheduledAt: now.toISOString(),
          idempotencyKey: `${caseId}:critical:${day}:${email}`,
          details: {
            ...details,
            organizationName:
              organizationData.displayName || workspaceData.name,
          },
        })
      )
        queued += 1;
    }
  }
  return { checked: subscriptions.length, skippedDeleted, transitions, queued };
}

async function expireCredentials({ tables }, now) {
  let expired = 0;
  for (const [tableId, statuses] of [
    ["support_grants", ["active"]],
    ["invitations", ["active"]],
    ["initial_admin_appointments", ["active"]],
    ["extension_devices", ["active", "pairing"]],
  ]) {
    for (const status of statuses) {
      const rows = await listAll(tables, tableId, [
        Query.equal("status", [status]),
        Query.lessThanEqual("expires_at", now.toISOString()),
      ]);
      for (const row of rows) {
        await tables.updateRow({
          databaseId: DATABASE_ID,
          tableId,
          rowId: row.$id,
          data: fields(
            { status: "expired", updated_by: "knowhow_ops" },
            { ...payload(row), expiredAt: now.toISOString() },
          ),
          permissions: [],
        });
        expired += 1;
      }
    }
  }
  const idempotency = await listAll(tables, "idempotency_keys", [
    Query.lessThanEqual("expires_at", now.toISOString()),
  ]);
  for (const row of idempotency)
    await tables.deleteRow({
      databaseId: DATABASE_ID,
      tableId: "idempotency_keys",
      rowId: row.$id,
    });
  return { expired, cleanedIdempotency: idempotency.length };
}

async function rollupUsage({ tables }, now) {
  const cutoff = new Date(now.getTime() - 35 * DAY).toISOString();
  const events = await listAll(tables, "usage_events", [
    Query.greaterThanEqual("occurred_at", cutoff),
  ]);
  const groups = new Map();
  for (const event of events) {
    const day = String(event.occurred_at || event.$createdAt).slice(0, 10);
    const key = `${event.workspace_id}:${event.kind}:${day}`;
    groups.set(key, {
      workspaceId: event.workspace_id,
      organizationId: event.organization_id,
      kind: event.kind,
      day,
      count: (groups.get(key)?.count || 0) + 1,
    });
  }
  for (const group of groups.values()) {
    const id = await stableId(
      "rollup",
      `${group.workspaceId}:${group.kind}:${group.day}`,
    );
    await tables.upsertRow({
      databaseId: DATABASE_ID,
      tableId: "usage_rollups",
      rowId: id,
      data: fields(
        {
          organization_id: group.organizationId || null,
          workspace_id: group.workspaceId,
          kind: group.kind,
          status: "ready",
          occurred_at: `${group.day}T00:00:00.000Z`,
          updated_by: "knowhow_ops",
        },
        { count: group.count, contentIncluded: false },
      ),
      permissions: [],
    });
  }
  return { events: events.length, rollups: groups.size };
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

function emailTemplate(kind, details) {
  const workspace = escapeHtml(
    details.workspaceName || "your KnowHow workspace",
  );
  const origin = (process.env.KNOWHOW_WEB_ORIGIN || "").replace(/\/$/, "");
  let subject = "KnowHow notification";
  let copy = "There is an update to your KnowHow pilot.";
  let action;
  if (kind === "lead.confirmation") {
    subject = "We received your KnowHow request";
    copy =
      "Thank you. We will review the fit and reply by email. No account or pilot has been created.";
  } else if (kind === "lead.received") {
    subject = "New KnowHow request";
    copy = `A new ${escapeHtml(details.kind || "pilot")} request was received from ${escapeHtml(details.organization || "an organization")}.`;
  } else if (kind === "administrator.appointed") {
    const organizationRoles = Array.isArray(details.organizationRoles)
      ? details.organizationRoles
      : [];
    const workspaceAdministrator = details.workspaceAdministrator !== false;
    const organization = escapeHtml(details.organizationName || workspace);
    subject = workspaceAdministrator
      ? `Administrator appointment for ${workspace}`
      : `Organization appointment for ${organization}`;
    copy = workspaceAdministrator
      ? organizationRoles.length
        ? "You were appointed to organization governance and as an explicit workspace administrator. Verify this email, set up an authenticator, and accept the one-use appointment before it expires."
        : "You were appointed as an explicit workspace administrator. Verify this email, set up an authenticator, and accept the one-use appointment before it expires."
      : "You were appointed to organization governance without workspace guide access. Verify this email, set up an authenticator, and accept the one-use appointment before it expires.";
    action = details.credential
      ? `${origin}/app?appointment=${encodeURIComponent(details.credential)}`
      : undefined;
  } else if (kind === "invitation.created") {
    subject = `Invitation to ${workspace}`;
    copy =
      "A workspace administrator invited this email address to KnowHow. The invitation is single-use and expires automatically.";
    action = details.credential
      ? `${origin}/app?invite=${encodeURIComponent(details.credential)}`
      : undefined;
  } else if (kind === "support.approval_requested") {
    subject = `Support access approval requested for ${workspace}`;
    copy =
      "A support operator requested temporary access. Review the reason, role, and duration in KnowHow. Access remains denied until an administrator approves it.";
    action = `${origin}/app`;
  } else if (kind === "support.approved") {
    subject = `Temporary support access approved for ${workspace}`;
    copy =
      "Temporary access was approved and will expire automatically. Every action is audited.";
    action = `${origin}/app`;
  } else if (kind === "support.ticket_opened") {
    subject = `New support ticket for ${workspace}`;
    copy =
      "A member opened an in-app support ticket. Open KnowHow to read and respond; message content is intentionally omitted from email.";
    action = `${origin}/platform`;
  } else if (kind === "support.ticket_updated") {
    subject = `Support ticket updated for ${workspace}`;
    copy =
      "An in-app support ticket has a new reply. Open KnowHow to read it; message content is intentionally omitted from email.";
    action = `${origin}/app`;
  } else if (kind === "deletion.approval_overdue") {
    subject = `CRITICAL: deletion approval required for ${workspace}`;
    copy =
      "The retention period ended. Content remains inaccessible and will not be purged until a platform owner reauthenticates and gives explicit typed approval.";
    action = `${origin}/platform`;
  } else if (kind.includes("expiry_4d")) {
    subject = `${workspace} expires in four days`;
    copy =
      "The subscription will enter seven days of read-only grace at expiry unless it is extended or converted.";
  } else if (kind.includes("expiry_1d")) {
    subject = `${workspace} expires tomorrow`;
    copy =
      "The subscription will enter read-only grace tomorrow unless it is extended or converted.";
  } else if (kind.endsWith(".expired")) {
    subject = `${workspace} is now read-only`;
    copy =
      "The subscription expired. Sign-in, viewing, export, and account/settings inspection remain available during grace; changes and capture are disabled.";
  } else if (kind.includes("grace_midpoint")) {
    subject = `Read-only grace update for ${workspace}`;
    copy =
      "The grace period is halfway complete. Contact KnowHow to extend or convert the subscription.";
  } else if (kind.includes("grace_1d")) {
    subject = `${workspace} will be suspended tomorrow`;
    copy =
      "Read-only grace ends in 24 hours. After suspension, only the recovery screen and extension revocation remain available.";
  } else if (kind.endsWith(".suspended")) {
    subject = `${workspace} has been suspended`;
    copy =
      "The grace period ended. The workspace is inaccessible while retained for recovery under the pilot retention schedule.";
  } else if (kind.startsWith("retention.")) {
    subject = `Retention notice for ${workspace}`;
    copy = `The suspended workspace remains retained. Deletion eligibility is ${escapeHtml(details.deletionEligibleAt || "shown in KnowHow")}; purge still requires explicit platform-owner approval.`;
  } else if (kind.endsWith(".welcome")) {
    subject = `Welcome to the ${workspace} pilot`;
    copy =
      "Your controlled pilot has started. Use ordinary business-process data only and complete onboarding before live use.";
    action = `${origin}/app`;
  } else if (kind === "trial.activation_help") {
    subject = `Activation help for ${workspace}`;
    copy =
      "A week into the trial, complete the first capture, publication, teammate view, and completion to validate the workflow.";
    action = `${origin}/app`;
  }
  const button = action
    ? `<p><a href="${escapeHtml(action)}" style="display:inline-block;padding:12px 18px;background:#1f6a48;color:white;text-decoration:none;border-radius:8px">Open KnowHow</a></p>`
    : "";
  return {
    subject: String(subject).replace(/<[^>]*>/g, ""),
    html: `<div style="font:16px/1.6 system-ui,sans-serif;color:#172019;max-width:620px"><h1 style="font-size:24px">KnowHow</h1><p>${copy}</p>${button}<p style="font-size:12px;color:#59645c">This operational email contains no guide text, screenshots, form values, or customer content.</p></div>`,
  };
}

async function sendViaResend(email, template, idempotencyKey) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) throw new Error("RESEND_NOT_CONFIGURED");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: template.subject,
      html: template.html,
    }),
  });
  if (!response.ok) throw new Error(`RESEND_${response.status}`);
  return "resend";
}

async function deliverNotifications({ tables, messaging, users }, now) {
  const due = await listAll(
    tables,
    "notification_deliveries",
    [
      Query.equal("status", ["queued"]),
      Query.lessThanEqual("scheduled_at", now.toISOString()),
    ],
    100,
  );
  let sent = 0;
  let failed = 0;
  for (const row of due) {
    const details = payload(row);
    const attempts = Number(details.attempts || 0) + 1;
    try {
      const templateDetails = { ...details };
      if (details.credentialEnvelope) {
        templateDetails.credential = await decryptNotificationCredential(
          details.credentialEnvelope,
          row,
        );
      }
      const template = emailTemplate(row.kind, templateDetails);
      let delivery = "appwrite-messaging";
      let userId = row.user_id;
      if (!userId && row.email) {
        const match = await users.list({
          queries: [Query.equal("email", [row.email]), Query.limit(1)],
          total: false,
        });
        userId = match.users[0]?.$id;
      }
      if (userId) {
        try {
          await messaging.createEmail({
            messageId: row.$id,
            subject: template.subject,
            content: template.html,
            users: [userId],
            html: true,
          });
        } catch (caught) {
          if (caught?.code !== 409) throw caught;
          delivery = "appwrite-messaging-replay";
        }
      } else if (row.email) {
        delivery = await sendViaResend(row.email, template, row.$id);
      } else {
        throw new Error("NOTIFICATION_TARGET_MISSING");
      }
      await tables.updateRow({
        databaseId: DATABASE_ID,
        tableId: "notification_deliveries",
        rowId: row.$id,
        data: fields(
          {
            status: "sent",
            occurred_at: now.toISOString(),
            updated_by: "knowhow_ops",
          },
          {
            ...scrubNotificationCredential(details),
            attempts,
            delivery,
            sentAt: now.toISOString(),
          },
        ),
        permissions: [],
      });
      sent += 1;
    } catch (caught) {
      const terminal = attempts >= 5;
      const delayMinutes = Math.min(24 * 60, 5 * 2 ** (attempts - 1));
      const failureClass =
        caught instanceof Error
          ? caught.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 80)
          : "DELIVERY_FAILED";
      await tables.updateRow({
        databaseId: DATABASE_ID,
        tableId: "notification_deliveries",
        rowId: row.$id,
        data: fields(
          {
            status: terminal ? "failed" : "queued",
            scheduled_at: new Date(
              now.getTime() + delayMinutes * 60_000,
            ).toISOString(),
            updated_by: "knowhow_ops",
          },
          {
            ...(terminal ? scrubNotificationCredential(details) : details),
            attempts,
            lastFailureClass: failureClass,
            lastFailedAt: now.toISOString(),
            ...(terminal
              ? { credentialDiscardedAt: now.toISOString() }
              : {}),
          },
        ),
        permissions: [],
      });
      failed += 1;
    }
  }
  return { due: due.length, sent, failed };
}

function manifestKeySet(manifest) {
  return new Set(
    manifest.flatMap((entry) =>
      entry.rowIds.map((rowId) => targetKey(entry.tableId, rowId)),
    ),
  );
}

function fileKey(bucket, fileId) {
  return `${bucket}\0${fileId}`;
}

function fileManifestKeySet(manifest) {
  return new Set(
    manifest.flatMap((entry) =>
      entry.fileIds.map((fileId) => fileKey(entry.bucket, fileId)),
    ),
  );
}

function assertFrozenRows(currentTargets, plannedManifest, scope) {
  const planned = manifestKeySet(plannedManifest);
  for (const key of targetKeys(currentTargets)) {
    if (!planned.has(key)) throw new Error(`PURGE_SCOPE_CHANGED:${scope}`);
  }
}

function assertFrozenFiles(currentTargets, plannedManifest, scope) {
  const planned = fileManifestKeySet(plannedManifest);
  for (const entry of fileManifest(currentTargets)) {
    for (const fileId of entry.fileIds) {
      if (!planned.has(fileKey(entry.bucket, fileId)))
        throw new Error(`PURGE_FILE_SCOPE_CHANGED:${scope}`);
    }
  }
}

async function deletePlannedFiles(storage, manifest) {
  let failures = 0;
  for (const entry of manifest) {
    const bucketId = entry.bucket === "private" ? PRIVATE_BUCKET : EXPORTS_BUCKET;
    for (const fileId of entry.fileIds) {
      try {
        await storage.deleteFile({ bucketId, fileId });
      } catch (caught) {
        if (caught?.code !== 404) failures += 1;
      }
    }
  }
  return failures;
}

async function deletePlannedRows(tables, manifest) {
  for (const entry of manifest) {
    for (const rowId of entry.rowIds) {
      try {
        await tables.deleteRow({
          databaseId: DATABASE_ID,
          tableId: entry.tableId,
          rowId,
        });
      } catch (caught) {
        if (caught?.code !== 404) throw caught;
      }
    }
  }
}

async function organizationCanBeDeleted(tables, organizationId, workspaceId) {
  const workspaces = (await listAllExact(tables, "workspaces")).filter(
    (workspace) => workspace.organization_id === organizationId,
  );
  return workspaces.every(
    (workspace) =>
      workspace.$id === workspaceId || workspace.status === "deleted",
  );
}

async function remainingUserReferences(tables, candidateIds) {
  const candidates = new Set(candidateIds);
  const referenced = new Set();
  if (!candidates.size) return referenced;
  for (const tableId of USER_REFERENCE_TABLES) {
    const rows = await listAllExact(tables, tableId);
    for (const row of rows) {
      for (const field of ["user_id", "created_by", "updated_by"]) {
        if (candidates.has(row[field])) referenced.add(row[field]);
      }
    }
  }
  return referenced;
}

async function cleanupUnreferencedUsers(tables, users, candidateIds) {
  const referenced = await remainingUserReferences(tables, candidateIds);
  let authUsersRemoved = 0;
  let authUsersPreserved = 0;
  let userPreferenceRowsDeleted = 0;
  for (const userId of candidateIds) {
    if (referenced.has(userId)) {
      authUsersPreserved += 1;
      continue;
    }
    const preferences = await listAllExact(tables, "user_preferences", [
      Query.equal("user_id", [userId]),
    ]);
    for (const preference of preferences) {
      try {
        await tables.deleteRow({
          databaseId: DATABASE_ID,
          tableId: "user_preferences",
          rowId: preference.$id,
        });
        userPreferenceRowsDeleted += 1;
      } catch (caught) {
        if (caught?.code !== 404) throw caught;
      }
    }
    if (!users?.delete) throw new Error("PURGE_USERS_SERVICE_REQUIRED");
    try {
      await users.delete({ userId });
    } catch (caught) {
      if (caught?.code !== 404) throw caught;
    }
    authUsersRemoved += 1;
  }
  return {
    authUsersRemoved,
    authUsersPreserved,
    userPreferenceRowsDeleted,
  };
}

async function purgeApproved({ tables, storage, users }, now) {
  const due = await listAll(
    tables,
    "lifecycle_cases",
    [
      Query.equal("kind", ["tenant_deletion_approval"]),
      Query.lessThanEqual("scheduled_at", now.toISOString()),
    ],
    100,
  );
  const approved = due
    .filter((row) => ["approved", "purging"].includes(row.status))
    .slice(0, 10);
  const receipts = [];
  for (const row of approved) {
    let details = payload(row);
    const workspaceId = row.workspace_id;
    const organizationId = row.organization_id;
    if (
      typeof workspaceId !== "string" ||
      !workspaceId ||
      typeof organizationId !== "string" ||
      !organizationId
    ) {
      throw new Error(`PURGE_CASE_SCOPE_INVALID:${row.$id}`);
    }
    if (
      typeof details.approvedBy !== "string" ||
      !details.approvedBy ||
      !Number.isFinite(Date.parse(details.approvedAt || ""))
    ) {
      throw new Error(`PURGE_APPROVAL_EVIDENCE_INVALID:${row.$id}`);
    }
    const workspaceHash = await receiptHash(`workspace\0${workspaceId}`);
    const organizationHash = await receiptHash(
      `organization\0${organizationId}`,
    );
    const approvedByHash = await receiptHash(`actor\0${details.approvedBy}`);
    const deletingOrganization = await organizationCanBeDeleted(
      tables,
      organizationId,
      workspaceId,
    );
    let purgePlan = details.purgePlan;
    const hadStoredPurgePlan = purgePlan !== undefined;
    if (hadStoredPurgePlan) {
      if (
        !validPurgePlan(purgePlan) ||
        !(await verifyPurgePlanBinding(
          purgePlan,
          row.$id,
          organizationId,
          workspaceId,
        ))
      ) {
        throw new Error(`PURGE_PLAN_BINDING_INVALID:${row.$id}`);
      }
    } else {
      if (row.status === "purging")
        throw new Error(`PURGE_PLAN_REQUIRED:${row.$id}`);
      purgePlan = await buildPurgePlan(
        tables,
        workspaceId,
        organizationId,
        deletingOrganization,
        now.toISOString(),
        row.$id,
      );
      details = { ...details, purgePlan };
    }
    if (row.status !== "purging" || !hadStoredPurgePlan) {
      await tables.updateRow({
        databaseId: DATABASE_ID,
        tableId: "lifecycle_cases",
        rowId: row.$id,
        data: fields(
          { status: "purging", updated_by: "knowhow_ops" },
          {
            ...details,
            status: "purging",
            purgeStartedAt: details.purgeStartedAt || now.toISOString(),
          },
        ),
        permissions: [],
      });
    }
    const liveWorkspaceTargets = await collectWorkspaceTargets(
      tables,
      workspaceId,
      organizationId,
      row.$id,
      false,
    );
    assertFrozenRows(
      liveWorkspaceTargets,
      purgePlan.workspaceTargets,
      "workspace",
    );
    assertFrozenFiles(
      liveWorkspaceTargets,
      purgePlan.workspaceFileTargets,
      "workspace",
    );
    let organizationWasDeleted = false;
    if (purgePlan.organizationDeleted) {
      if (
        !(await organizationCanBeDeleted(tables, organizationId, workspaceId))
      ) {
        throw new Error("PURGE_SCOPE_CHANGED:organization");
      }
      organizationWasDeleted = true;
    }
    let liveOrganizationTargets = new Map();
    if (organizationWasDeleted) {
      liveOrganizationTargets = await collectOrganizationTargets(
        tables,
        organizationId,
        row.$id,
        manifestKeySet(purgePlan.workspaceTargets),
      );
      assertFrozenRows(
        liveOrganizationTargets,
        purgePlan.organizationTargets,
        "organization",
      );
      assertFrozenFiles(
        liveOrganizationTargets,
        purgePlan.organizationFileTargets,
        "organization",
      );
    }
    let failedFiles = await deletePlannedFiles(
      storage,
      purgePlan.workspaceFileTargets,
    );
    if (organizationWasDeleted)
      failedFiles += await deletePlannedFiles(
        storage,
        purgePlan.organizationFileTargets,
      );
    if (failedFiles) {
      await tables.updateRow({
        databaseId: DATABASE_ID,
        tableId: "lifecycle_cases",
        rowId: row.$id,
        data: fields(
          {
            status: "approved",
            scheduled_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
            updated_by: "knowhow_ops",
          },
          {
            ...details,
            status: "approved",
            lastFailureClass: "STORAGE_DELETE_FAILED",
            failedFiles,
          },
        ),
        permissions: [],
      });
      continue;
    }
    await deletePlannedRows(tables, purgePlan.workspaceTargets);
    if (organizationWasDeleted)
      await deletePlannedRows(tables, purgePlan.organizationTargets);
    const userCleanup = await cleanupUnreferencedUsers(
      tables,
      users,
      purgePlan.candidateUserIds,
    );
    const workspaceResidue = await collectWorkspaceTargets(
      tables,
      workspaceId,
      organizationId,
      row.$id,
      false,
    );
    if (targetKeys(workspaceResidue).size)
      throw new Error(`PURGE_WORKSPACE_RESIDUE:${row.$id}`);
    if (organizationWasDeleted) {
      const organizationResidue = await collectOrganizationTargets(
        tables,
        organizationId,
        row.$id,
      );
      if (targetKeys(organizationResidue).size)
        throw new Error(`PURGE_ORGANIZATION_RESIDUE:${row.$id}`);
    }
    const completedAt = new Date().toISOString();
    const receipt = {
      version: 2,
      deletedRows: purgePlan.workspaceRows,
      deletedFiles: purgePlan.workspaceFiles,
      failedFiles: 0,
      organizationHash,
      workspaceHash,
      organizationDeleted: organizationWasDeleted,
      organizationRowsDeleted: organizationWasDeleted
        ? purgePlan.organizationRows
        : 0,
      organizationFilesDeleted: organizationWasDeleted
        ? purgePlan.organizationFiles
        : 0,
      ...userCleanup,
    };
    await tables.updateRow({
      databaseId: DATABASE_ID,
      tableId: "lifecycle_cases",
      rowId: row.$id,
      data: fields(
        {
          organization_id: null,
          workspace_id: null,
          user_id: null,
          subject_id: null,
          slug: null,
          email: null,
          kind: "tenant_deletion_approval",
          status: "completed",
          idempotency_key: null,
          request_id: null,
          occurred_at: completedAt,
          expires_at: null,
          scheduled_at: null,
          deleted_at: null,
          created_by: "knowhow_ops",
          updated_by: "knowhow_ops",
        },
        {
          kind: "tenant_deletion_approval",
          status: "completed",
          eligibleAt: details.eligibleAt,
          createdAt: details.createdAt,
          approvedAt: details.approvedAt,
          approvedByHash,
          completedAt,
          receipt,
        },
      ),
      permissions: [],
    });
    receipts.push({ caseId: row.$id, ...receipt });
  }
  return receipts;
}

async function cleanupStagedProvisioning({ tables, storage }, now) {
  const runs = await listAll(tables, "provisioning_runs");
  const activeLogoIds = new Set();
  const staleBefore = now.getTime() - PROVISIONING_DRAFT_RETENTION_DAYS * DAY;
  let expiredDrafts = 0;
  for (const run of runs) {
    if (run.status !== "draft") continue;
    const runData = payload(run);
    const updatedAt = date(
      runData.updatedAt || run.$updatedAt || run.$createdAt,
    );
    if (updatedAt !== null && updatedAt < staleBefore) {
      await tables.updateRow({
        databaseId: DATABASE_ID,
        tableId: "provisioning_runs",
        rowId: run.$id,
        data: fields(
          { status: "expired", updated_by: "knowhow_ops" },
          { ...runData, expiredAt: now.toISOString() },
        ),
        permissions: [],
      });
      expiredDrafts += 1;
      continue;
    }
    const logoId = runData.steps?.["2"]?.logoMediaId;
    if (typeof logoId === "string" && logoId) activeLogoIds.add(logoId);
  }

  const mediaRows = (await listAll(tables, "private_media")).filter(
    (row) => row.kind === "provisioning-logo" && row.status === "staged",
  );
  let removedRows = 0;
  let removedFiles = 0;
  let failures = 0;
  for (const row of mediaRows) {
    const details = payload(row);
    const createdAt = date(details.createdAt || row.$createdAt);
    if (
      activeLogoIds.has(row.$id) ||
      createdAt === null ||
      createdAt > now.getTime() - DAY
    ) {
      continue;
    }
    const fileId = details.storageFileId || row.$id;
    try {
      await storage.deleteFile({ bucketId: PRIVATE_BUCKET, fileId });
      removedFiles += 1;
    } catch (caught) {
      if (caught?.code !== 404) {
        failures += 1;
        continue;
      }
    }
    await tables.deleteRow({
      databaseId: DATABASE_ID,
      tableId: "private_media",
      rowId: row.$id,
    });
    removedRows += 1;
  }
  return { expiredDrafts, removedRows, removedFiles, failures };
}

async function cleanupExpiredExports({ tables, storage }, now) {
  const rows = await listAll(tables, "export_jobs", [
    Query.equal("status", ["ready"]),
    Query.lessThanEqual("expires_at", now.toISOString()),
  ]);
  let expired = 0;
  let failures = 0;
  for (const row of rows) {
    const details = payload(row);
    const fileId = details.outputFileId;
    try {
      if (fileId) {
        await storage.deleteFile({ bucketId: EXPORTS_BUCKET, fileId });
      }
    } catch (caught) {
      if (caught?.code !== 404) {
        failures += 1;
        continue;
      }
    }
    const scrubbed = { ...details };
    delete scrubbed.byteSize;
    delete scrubbed.sha256;
    delete scrubbed.contentType;
    if (scrubbed.requester) {
      scrubbed.requester = {
        userId: scrubbed.requester.userId,
        name: "",
        email: "",
      };
    }
    await tables.updateRow({
      databaseId: DATABASE_ID,
      tableId: "export_jobs",
      rowId: row.$id,
      data: fields(
        {
          status: "expired",
          expires_at: row.expires_at,
          scheduled_at: null,
          updated_by: "knowhow_ops",
        },
        { ...scrubbed, expiredAt: now.toISOString() },
      ),
      permissions: [],
    });
    expired += 1;
  }
  return { inspected: rows.length, expired, failures };
}

async function reconcileOrphans({ tables, storage }, now) {
  const [mediaRows, exportRows, privateFiles, exportFiles] = await Promise.all([
    listAll(tables, "private_media"),
    listAll(tables, "export_jobs"),
    listAllFiles(storage, PRIVATE_BUCKET),
    listAllFiles(storage, EXPORTS_BUCKET),
  ]);
  const knownPrivate = new Set(
    mediaRows.map((row) => payload(row).storageFileId).filter(Boolean),
  );
  const knownExports = new Set(
    exportRows.map((row) => payload(row).outputFileId).filter(Boolean),
  );
  const reconcile = async (bucketId, files, known) => {
    let removed = 0;
    for (const file of files) {
      if (known.has(file.$id) || date(file.$createdAt) > now.getTime() - DAY)
        continue;
      await storage.deleteFile({ bucketId, fileId: file.$id });
      removed += 1;
    }
    return { inspected: files.length, removed };
  };
  const [privateMedia, exports] = await Promise.all([
    reconcile(PRIVATE_BUCKET, privateFiles, knownPrivate),
    reconcile(EXPORTS_BUCKET, exportFiles, knownExports),
  ]);
  return {
    privateMedia,
    exports,
    inspected: privateMedia.inspected + exports.inspected,
    removed: privateMedia.removed + exports.removed,
  };
}

const operationsWorker = async ({ req, res, log, error }) => {
  const started = new Date();
  const requestId = crypto.randomUUID();
  try {
    const api = services(req);
    const [lifecycle, expiry, rollups] = await Promise.all([
      runLifecycle(api, started),
      expireCredentials(api, started),
      rollupUsage(api, started),
    ]);
    const purge = await purgeApproved(api, started);
    const notifications = await deliverNotifications(api, new Date());
    const provisioningCleanup = await cleanupStagedProvisioning(
      api,
      new Date(),
    );
    const exportCleanup = await cleanupExpiredExports(api, new Date());
    const orphans = await reconcileOrphans(api, new Date());
    const result = {
      ok: true,
      requestId,
      startedAt: started.toISOString(),
      durationMs: Date.now() - started.getTime(),
      lifecycle,
      expiry,
      rollups,
      purge,
      notifications,
      provisioningCleanup,
      exportCleanup,
      orphans,
    };
    log(
      JSON.stringify({
        event: "knowhow.operations.completed",
        requestId,
        durationMs: result.durationMs,
        transitions: lifecycle.transitions,
        notificationFailures: notifications.failed,
        purges: purge.length,
      }),
    );
    return res.json(result);
  } catch (caught) {
    error(
      JSON.stringify({
        event: "knowhow.operations.failed",
        requestId,
        failureClass: caught instanceof Error ? caught.name : "UnknownError",
      }),
    );
    return res.json(
      { ok: false, requestId, startedAt: started.toISOString() },
      500,
    );
  }
};

export {
  ORGANIZATION_PURGE_TABLES,
  PURGE_TABLES,
  USER_REFERENCE_TABLES,
  buildPurgePlan,
  cleanupStagedProvisioning,
  cleanupExpiredExports,
  deliverNotifications,
  decryptNotificationCredential,
  emailTemplate,
  evaluate,
  lifecycleNotices,
  purgeApproved,
  reconcileOrphans,
  runLifecycle,
  scrubNotificationCredential,
  validPurgePlan,
};
export default operationsWorker;
