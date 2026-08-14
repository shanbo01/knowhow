import { isDeepStrictEqual } from "node:util";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function equalContract(actual, expected, message) {
  requireCondition(isDeepStrictEqual(actual, expected), message);
}

function exactLocalUrl(raw, pathname) {
  if (typeof raw !== "string" || raw !== raw.trim()) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "host.docker.internal"].includes(
    url.hostname,
  );
  const normalized = url.toString().replace(/\/$/, "");
  const exactRaw = raw === normalized || raw === `${normalized}/`;
  if (
    !local ||
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname.replace(/\/$/, "") !== pathname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !exactRaw
  ) {
    return null;
  }
  return normalized;
}

export function resolveSmokeTarget(raw) {
  const endpoint = exactLocalUrl(raw, "/v1");
  requireCondition(
    endpoint,
    "The contract smoke accepts only an exact local Appwrite endpoint.",
  );
  return { endpoint, target: "local" };
}

export function localSiteOrigin(raw) {
  const origin = exactLocalUrl(raw, "");
  requireCondition(
    origin,
    "The smoke Site origin must be an exact local origin.",
  );
  return new URL(origin).origin;
}

function columnContract(column) {
  const normalized = {
    key: column.key,
    type: column.type,
    status: column.status,
    error: column.error,
    required: column.required,
    array: Boolean(column.array),
    default: column.default ?? null,
  };
  if (column.type === "varchar") normalized.size = column.size;
  if (column.type === "integer") {
    normalized.min = Number(column.min);
    normalized.max = Number(column.max);
  }
  return normalized;
}

function indexContract(index) {
  return {
    key: index.key,
    type: index.type,
    status: index.status ?? "available",
    error: index.error ?? "",
    columns: [...index.columns],
  };
}

export function assertDatabaseContract(expected, remote) {
  equalContract(
    { $id: remote.$id, name: remote.name, enabled: remote.enabled },
    { $id: expected.$id, name: expected.name, enabled: expected.enabled },
    `${expected.$id} database configuration drifted`,
  );
}

export function assertTableContract(expected, remote) {
  equalContract(
    {
      $id: remote.$id,
      databaseId: remote.databaseId,
      name: remote.name,
      enabled: remote.enabled,
      rowSecurity: remote.rowSecurity,
      $permissions: remote.$permissions,
    },
    {
      $id: expected.$id,
      databaseId: expected.databaseId,
      name: expected.name,
      enabled: expected.enabled,
      rowSecurity: expected.rowSecurity,
      $permissions: expected.$permissions,
    },
    `${expected.$id} table configuration drifted`,
  );
  equalContract(
    remote.columns
      .map(columnContract)
      .sort((left, right) => left.key.localeCompare(right.key)),
    expected.columns
      .map(columnContract)
      .sort((left, right) => left.key.localeCompare(right.key)),
    `${expected.$id} column contract drifted`,
  );
  equalContract(
    remote.indexes
      .map(indexContract)
      .sort((left, right) => left.key.localeCompare(right.key)),
    expected.indexes
      .map(indexContract)
      .sort((left, right) => left.key.localeCompare(right.key)),
    `${expected.$id} index contract drifted`,
  );
}

export function assertBucketContract(expected, remote) {
  equalContract(
    {
      $id: remote.$id,
      $permissions: remote.$permissions,
      fileSecurity: remote.fileSecurity,
      name: remote.name,
      enabled: remote.enabled,
      maximumFileSize: remote.maximumFileSize,
      allowedFileExtensions: [...remote.allowedFileExtensions].sort(),
      compression: remote.compression,
      encryption: remote.encryption,
      antivirus: remote.antivirus,
    },
    {
      $id: expected.$id,
      $permissions: expected.$permissions,
      fileSecurity: expected.fileSecurity,
      name: expected.name,
      enabled: expected.enabled,
      maximumFileSize: expected.maximumFileSize,
      allowedFileExtensions: [...expected.allowedFileExtensions].sort(),
      compression: expected.compression,
      encryption: expected.encryption,
      antivirus: expected.antivirus,
    },
    `${expected.$id} bucket contract drifted`,
  );
}
