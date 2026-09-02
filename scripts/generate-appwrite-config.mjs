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

// The deployable functions are declared in appwrite.config.json rather than
// generated, because their shape belongs to the Appwrite CLI. What is checked
// here is that each declaration still points at code that exists, and asks for
// a runtime the function's own package.json agrees with — a rename or a moved
// entrypoint otherwise surfaces only as a failed push.
const appwriteConfig = JSON.parse(
  await readFile(path.join(root, "appwrite.config.json"), "utf8"),
);
const declaredFunctions = appwriteConfig.functions ?? [];
assert.ok(declaredFunctions.length > 0, "appwrite.config.json declares no functions");
for (const fn of declaredFunctions) {
  const label = fn.$id ?? "(unnamed function)";
  assert.match(label, /^[a-z][a-z0-9-]{0,35}$/, `${label} is not a valid function ID`);
  assert.ok(fn.path, `${label} has no path`);
  const functionRoot = path.join(root, fn.path);
  const manifestPath = path.join(functionRoot, "package.json");
  const entrypoint = path.join(functionRoot, fn.entrypoint ?? "");
  for (const [description, target] of [
    ["directory", functionRoot],
    ["package.json", manifestPath],
    ["entrypoint", entrypoint],
  ]) {
    assert.ok(
      await readFile(target).then(
        () => true,
        (error) => error.code === "EISDIR",
      ),
      `${label} ${description} is missing: ${path.relative(root, target)}`,
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const engine = manifest.engines?.node ?? "";
  const major = /(\d+)/.exec(engine)?.[1];
  assert.ok(
    major && fn.runtime === `node-${major}`,
    `${label} declares runtime ${fn.runtime} but its package.json engines.node is "${engine}"`,
  );
  assert.ok(
    Array.isArray(fn.scopes) && fn.scopes.length > 0,
    `${label} declares no scopes; its dynamic API key would be powerless`,
  );
  assert.deepEqual(
    fn.execute,
    [],
    `${label} must not be executable over HTTP; it is triggered by schedule and events`,
  );
}

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

