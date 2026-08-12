import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { tables } from "../infrastructure/appwrite/schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [
  path.join(root, "lib", "server"),
  path.join(root, "app", "api"),
];

const tableIdByProperty = new Map(
  tables.map((table) => [
    table.$id.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
    table.$id,
  ]),
);
const tableById = new Map(tables.map((table) => [table.$id, table]));

const functionContracts = [
  [
    "workspace_members",
    ["workspace_id", "status"],
    "operations lifecycle recipients",
  ],
  ["support_grants", ["status", "expires_at"], "operations expiry sweep"],
  ["invitations", ["status", "expires_at"], "operations expiry sweep"],
  [
    "initial_admin_appointments",
    ["status", "expires_at"],
    "operations expiry sweep",
  ],
  ["extension_devices", ["status", "expires_at"], "operations expiry sweep"],
  ["idempotency_keys", ["expires_at"], "operations idempotency cleanup"],
  ["usage_events", ["occurred_at"], "operations usage rollup"],
  [
    "notification_deliveries",
    ["status", "scheduled_at"],
    "operations delivery queue",
  ],
  ["lifecycle_cases", ["kind", "scheduled_at"], "operations purge queue"],
  ["private_media", ["workspace_id"], "operations workspace purge"],
  ["export_jobs", ["workspace_id"], "operations workspace purge"],
  [
    "export_jobs",
    ["status", "scheduled_at"],
    "export worker retry and lease scan",
  ],
  [
    "export_jobs",
    ["status", "expires_at"],
    "operations export expiry cleanup",
  ],
  [
    "support_messages",
    ["workspace_id", "sequence"],
    "workspace bootstrap ordering",
  ],
  [
    "audit_segments",
    ["workspace_id", "sequence"],
    "workspace bootstrap ordering",
  ],
];

const purgeTables = [
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
  "subscriptions",
  "lifecycle_cases",
];
for (const tableId of purgeTables) {
  functionContracts.push([
    tableId,
    ["workspace_id"],
    "operations workspace purge",
  ]);
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(target)));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(target);
  }
  return files;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function tableProperty(node) {
  if (
    !ts.isPropertyAccessExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== "TABLES"
  ) {
    return null;
  }
  return node.name.text;
}

function literalField(filter) {
  if (!ts.isObjectLiteralExpression(filter)) return null;
  for (const property of filter.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      propertyName(property.name) !== "field"
    )
      continue;
    return ts.isStringLiteral(property.initializer)
      ? property.initializer.text
      : null;
  }
  return null;
}

function queryFromCall(node, sourceFile) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "list" ||
    node.arguments.length < 2
  ) {
    return null;
  }
  const property = tableProperty(node.arguments[0]);
  const options = node.arguments[1];
  if (!property || !ts.isObjectLiteralExpression(options)) return null;
  const fields = [];
  let orderBy = null;
  let dynamicFilters = false;
  for (const option of options.properties) {
    if (
      ts.isShorthandPropertyAssignment(option) &&
      option.name.text === "filters"
    ) {
      dynamicFilters = true;
      continue;
    }
    if (!ts.isPropertyAssignment(option)) continue;
    const name = propertyName(option.name);
    if (name === "filters") {
      if (ts.isArrayLiteralExpression(option.initializer)) {
        for (const filter of option.initializer.elements) {
          const field = literalField(filter);
          if (field) fields.push(field);
        }
      } else {
        dynamicFilters = true;
      }
    }
    if (name === "orderBy" && ts.isStringLiteral(option.initializer)) {
      orderBy = option.initializer.text;
    }
  }
  if (dynamicFilters) return null;
  if (orderBy && !orderBy.startsWith("$") && !fields.includes(orderBy))
    fields.push(orderBy);
  if (!fields.length || fields.every((field) => field.startsWith("$")))
    return null;
  const location = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return {
    tableId: tableIdByProperty.get(property),
    property,
    fields,
    source: `${path.relative(root, sourceFile.fileName)}:${location.line + 1}`,
  };
}

function indexSupports(index, fields) {
  if (index.columns.length < fields.length) return false;
  const prefix = index.columns.slice(0, fields.length);
  return fields.every((field) => prefix.includes(field));
}

const contracts = [];
for (const sourceRoot of sourceRoots) {
  for (const file of await filesUnder(sourceRoot)) {
    const text = await readFile(file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      const query = queryFromCall(node, source);
      if (query) contracts.push(query);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
for (const [tableId, fields, source] of functionContracts) {
  contracts.push({ tableId, property: tableId, fields, source });
}

const missing = [];
for (const contract of contracts) {
  assert.ok(
    contract.tableId,
    `Unknown TABLES property ${contract.property} at ${contract.source}`,
  );
  const table = tableById.get(contract.tableId);
  if (!table.indexes.some((index) => indexSupports(index, contract.fields))) {
    missing.push(
      `${contract.tableId} [${contract.fields.join(", ")}] at ${contract.source}`,
    );
  }
}

assert.deepEqual(
  missing,
  [],
  `Appwrite query contracts are missing indexes:\n${missing.map((item) => `- ${item}`).join("\n")}`,
);

console.log(`Verified ${contracts.length} Appwrite query/index contracts.`);
