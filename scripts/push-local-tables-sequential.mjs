import fs from "node:fs/promises";
import path from "node:path";
import { AppwriteException, Client, Query, TablesDB } from "node-appwrite";

const EXACT_ENDPOINT = "http://localhost/v1";
const EXACT_PROJECT = "knowhow-local";
const TARGET_TABLES = new Set(["beta_access_grants", "beta_access_events"]);
const databaseId = process.env.APPWRITE_DATABASE_ID?.trim();
const endpoint = process.env.APPWRITE_ENDPOINT?.trim();
const projectId = process.env.APPWRITE_PROJECT_ID?.trim();
const apiKey = process.env.APPWRITE_API_KEY?.trim();
const environment = process.env.KNOWHOW_ENVIRONMENT?.trim();

if (
  endpoint !== EXACT_ENDPOINT ||
  projectId !== EXACT_PROJECT ||
  environment !== "development" ||
  !databaseId ||
  !apiKey
) {
  throw new Error(
    "Refusing schema repair: exact localhost development binding is required.",
  );
}

if (!process.argv.includes("--recreate-empty")) {
  throw new Error(
    "Pass --recreate-empty after confirming the two disposable beta tables are empty.",
  );
}

const manifest = JSON.parse(
  await fs.readFile(
    path.join(process.cwd(), "infrastructure", "appwrite", "tables.json"),
    "utf8",
  ),
);
const definitions = manifest.filter((table) => TARGET_TABLES.has(table.$id));
if (definitions.length !== TARGET_TABLES.size) {
  throw new Error("The beta table manifest is incomplete.");
}

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);
const tables = new TablesDB(client);

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function missingTable(tableId) {
  try {
    await tables.getTable({ databaseId, tableId });
    return false;
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return true;
    throw error;
  }
}

async function waitUntil(label, read, select, attempts = 90) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = select(await read());
    if (result?.status === "available") return result;
    if (result?.status === "failed") {
      throw new Error(`${label} failed: ${result.error || "unknown error"}`);
    }
    await delay(500);
  }
  throw new Error(`${label} did not become available.`);
}

async function createColumn(tableId, column) {
  const common = {
    databaseId,
    tableId,
    key: column.key,
    required: Boolean(column.required),
    ...(column.default !== null && column.default !== undefined
      ? { xdefault: column.default }
      : {}),
    array: Boolean(column.array),
  };
  if (column.type === "varchar") {
    await tables.createVarcharColumn({
      ...common,
      size: column.size,
      encrypt: false,
    });
  } else if (column.type === "text") {
    await tables.createTextColumn({ ...common, encrypt: false });
  } else if (column.type === "integer") {
    await tables.createIntegerColumn({
      ...common,
      ...(column.min !== undefined ? { min: column.min } : {}),
      ...(column.max !== undefined ? { max: column.max } : {}),
    });
  } else if (column.type === "datetime") {
    await tables.createDatetimeColumn(common);
  } else {
    throw new Error(`Unsupported local column type: ${column.type}`);
  }
  await waitUntil(
    `${tableId}.${column.key}`,
    () => tables.listColumns({ databaseId, tableId }),
    (response) => response.columns.find((item) => item.key === column.key),
  );
}

async function recreate(definition) {
  const tableId = definition.$id;
  if (!(await missingTable(tableId))) {
    const rows = await tables.listRows({
      databaseId,
      tableId,
      queries: [Query.limit(1)],
    });
    if (rows.total !== 0) {
      throw new Error(`Refusing to recreate non-empty table ${tableId}.`);
    }
    await tables.deleteTable({ databaseId, tableId });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await missingTable(tableId)) break;
      await delay(500);
    }
    if (!(await missingTable(tableId))) {
      throw new Error(`Table ${tableId} was not removed.`);
    }
  }

  await tables.createTable({
    databaseId,
    tableId,
    name: definition.name,
    permissions: definition.$permissions ?? [],
    rowSecurity: Boolean(definition.rowSecurity),
    enabled: definition.enabled !== false,
  });

  for (const column of definition.columns) {
    await createColumn(tableId, column);
  }
  for (const index of definition.indexes) {
    await tables.createIndex({
      databaseId,
      tableId,
      key: index.key,
      type: index.type,
      columns: index.columns,
    });
    await waitUntil(
      `${tableId}.${index.key}`,
      () => tables.listIndexes({ databaseId, tableId }),
      (response) => response.indexes.find((item) => item.key === index.key),
    );
  }
  console.log(
    `${tableId}: ${definition.columns.length} columns and ${definition.indexes.length} indexes available`,
  );
}

for (const definition of definitions) await recreate(definition);
