import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databases, expectedTableIds, tables } from "../infrastructure/appwrite/schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = (name) => path.join(root, "infrastructure", "appwrite", name);
const rendered = {
  "databases.json": `${JSON.stringify(databases, null, 2)}\n`,
  "tables.json": `${JSON.stringify(tables, null, 2)}\n`,
};

for (const table of tables) {
  assert.equal(table.databaseId, "knowhow_core");
  assert.equal(table.$permissions.length, 0, `${table.$id} must stay server-only`);
  assert.equal(table.rowSecurity, false);
  assert.ok(table.columns.some((column) => column.key === "organization_id"));
  assert.ok(table.columns.some((column) => column.key === "workspace_id"));
  assert.ok(table.columns.some((column) => column.key === "payload_json"));
}
assert.deepEqual(
  [...new Set(expectedTableIds)].sort(),
  [...expectedTableIds].sort(),
  "table IDs must be unique",
);

const check = process.argv.includes("--check");
for (const [name, contents] of Object.entries(rendered)) {
  const target = output(name);
  if (check) {
    const current = await readFile(target, "utf8").catch(() => "");
    assert.equal(current, contents, `${name} is out of date; run npm run appwrite:generate`);
  } else {
    await writeFile(target, contents, "utf8");
  }
}

if (!check) console.log(`Generated ${Object.keys(rendered).length} Appwrite resource files.`);

