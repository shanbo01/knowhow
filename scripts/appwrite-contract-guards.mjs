import { isDeepStrictEqual } from "node:util";
import { exactControlledAppwriteEndpoint } from "./controlled-appwrite-endpoint.mjs";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function equalContract(actual, expected, message) {
  requireCondition(isDeepStrictEqual(actual, expected), message);
}

function normalizedEndpoint(url) {
  return url.toString().replace(/\/$/, "");
}

export function resolveSmokeTarget(
  raw,
  {
    allowStaging = false,
    allowProduction = false,
    environment = "",
    residency = process.env.KNOWHOW_APPWRITE_RESIDENCY ?? "",
  } = {},
) {
  requireCondition(typeof raw === "string" && raw === raw.trim(), "APPWRITE_ENDPOINT is invalid.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("APPWRITE_ENDPOINT is invalid.");
  }
  const local = ["localhost", "127.0.0.1", "host.docker.internal"].includes(
    url.hostname,
  );
  if (local) {
    requireCondition(
      !["staging", "production"].includes(environment) &&
        ["http:", "https:"].includes(url.protocol) &&
        url.pathname.replace(/\/$/, "") === "/v1" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "Controlled environments cannot use a local Appwrite endpoint.",
    );
    return { endpoint: normalizedEndpoint(url), target: "self-host" };
  }
  const endpoint = exactControlledAppwriteEndpoint(raw, residency);
  requireCondition(endpoint, "The contract smoke accepts only an exact local or approved controlled Appwrite endpoint.");
  const location = url.hostname === "fra.cloud.appwrite.io" ? "frankfurt" : "qatar";
  if (environment === "staging" && allowStaging)
    return { endpoint, target: `${location}-staging` };
  if (environment === "production" && allowProduction)
    return { endpoint, target: `${location}-production` };
  throw new Error("The requested controlled smoke target was not explicitly enabled.");
}

export function assertControlledMutationBinding({
  target,
  projectId,
  expectedProjectId,
  forbiddenProjectId,
  confirmation,
  syntheticOnly,
  finalProduction,
}) {
  if (target === "self-host") return;
  requireCondition(
    PROJECT_ID_PATTERN.test(projectId) &&
      PROJECT_ID_PATTERN.test(expectedProjectId ?? "") &&
      PROJECT_ID_PATTERN.test(forbiddenProjectId ?? ""),
    "Controlled smoke project bindings are missing or invalid.",
  );
  requireCondition(
    expectedProjectId !== forbiddenProjectId &&
      projectId === expectedProjectId &&
      projectId !== forbiddenProjectId,
    "The Appwrite project does not match the reviewed environment binding.",
  );
  const environment = target.endsWith("-staging") ? "staging" : "production";
  requireCondition(
    confirmation === `${environment}-transient-fixtures`,
    `The ${environment} transient-fixture confirmation is missing.`,
  );
  if (environment === "production") {
    requireCondition(
      syntheticOnly === "1" && finalProduction === "1",
      "Production smoke requires final-Production and synthetic-only attestations.",
    );
  }
}

export function controlledSiteOrigin(raw, target) {
  requireCondition(typeof raw === "string" && raw === raw.trim(), "The smoke Site origin is invalid.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The smoke Site origin is invalid.");
  }
  const controlled = target !== "self-host";
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  requireCondition(
    (controlled ? url.protocol === "https:" : local && ["http:", "https:"].includes(url.protocol)) &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "The smoke Site origin must be an exact controlled HTTPS origin or local development origin.",
  );
  return url.origin;
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
    remote.columns.map(columnContract).sort((left, right) => left.key.localeCompare(right.key)),
    expected.columns.map(columnContract).sort((left, right) => left.key.localeCompare(right.key)),
    `${expected.$id} column contract drifted`,
  );
  equalContract(
    remote.indexes.map(indexContract).sort((left, right) => left.key.localeCompare(right.key)),
    expected.indexes.map(indexContract).sort((left, right) => left.key.localeCompare(right.key)),
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

function liveDeployment(remote, resource) {
  requireCondition(remote.live === true, `${resource} has undeployed configuration changes`);
  requireCondition(
    typeof remote.deploymentId === "string" &&
      remote.deploymentId.length > 0 &&
      remote.deploymentId === remote.latestDeploymentId &&
      remote.latestDeploymentStatus === "ready",
    `${resource} does not have its latest ready deployment active`,
  );
}

export function assertFunctionContract(expected, remote) {
  liveDeployment(remote, expected.$id);
  equalContract(
    {
      $id: remote.$id,
      name: remote.name,
      enabled: remote.enabled,
      logging: remote.logging,
      runtime: remote.runtime,
      execute: [...remote.execute].sort(),
      scopes: [...remote.scopes].sort(),
      events: [...remote.events].sort(),
      schedule: remote.schedule,
      timeout: remote.timeout,
      entrypoint: remote.entrypoint,
      commands: remote.commands,
    },
    {
      $id: expected.$id,
      name: expected.name,
      enabled: expected.enabled,
      logging: expected.logging,
      runtime: expected.runtime,
      execute: [...expected.execute].sort(),
      scopes: [...expected.scopes].sort(),
      events: [...expected.events].sort(),
      schedule: expected.schedule,
      timeout: expected.timeout,
      entrypoint: expected.entrypoint,
      commands: expected.commands,
    },
    `${expected.$id} Function contract drifted`,
  );
}

function normalizedPath(value) {
  return String(value).replace(/^\.\//, "");
}

export function assertSiteContract(expected, remote) {
  liveDeployment(remote, expected.$id);
  equalContract(
    {
      $id: remote.$id,
      name: remote.name,
      enabled: remote.enabled,
      logging: remote.logging,
      framework: remote.framework,
      timeout: remote.timeout,
      installCommand: remote.installCommand,
      buildCommand: remote.buildCommand,
      outputDirectory: normalizedPath(remote.outputDirectory),
      buildRuntime: remote.buildRuntime,
      adapter: remote.adapter,
      fallbackFile: remote.fallbackFile ?? "",
    },
    {
      $id: expected.$id,
      name: expected.name,
      enabled: expected.enabled,
      logging: expected.logging,
      framework: expected.framework,
      timeout: expected.timeout,
      installCommand: expected.installCommand,
      buildCommand: expected.buildCommand,
      outputDirectory: normalizedPath(expected.outputDirectory),
      buildRuntime: expected.buildRuntime,
      adapter: expected.adapter,
      fallbackFile: expected.fallbackFile ?? "",
    },
    `${expected.$id} Site contract drifted`,
  );
}
