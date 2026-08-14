import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertBucketContract,
  assertDatabaseContract,
  assertTableContract,
  localSiteOrigin,
  resolveSmokeTarget,
} from "../scripts/appwrite-contract-guards.mjs";

const root = new URL("../", import.meta.url);
const json = async (path) =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));

test("smoke endpoints and application origins stay local", () => {
  assert.deepEqual(resolveSmokeTarget("http://localhost/v1"), {
    endpoint: "http://localhost/v1",
    target: "local",
  });
  assert.deepEqual(resolveSmokeTarget("http://127.0.0.1:8080/v1"), {
    endpoint: "http://127.0.0.1:8080/v1",
    target: "local",
  });
  assert.equal(localSiteOrigin("http://localhost:3001"), "http://localhost:3001");

  for (const endpoint of [
    "https://example.com/v1",
    "http://user@localhost/v1",
    "http://localhost/v1?project=test",
    "http://localhost/v1#test",
    "http://localhost/console",
  ]) {
    assert.throws(
      () => resolveSmokeTarget(endpoint),
      /only an exact local Appwrite endpoint/,
    );
  }
  assert.throws(
    () => localSiteOrigin("http://localhost:3001/path"),
    /exact local origin/,
  );
});

test("local contracts reject database, table, column, index, and bucket drift", async () => {
  const [databases, tables, buckets] = await Promise.all([
    json("infrastructure/appwrite/databases.json"),
    json("infrastructure/appwrite/tables.json"),
    json("infrastructure/appwrite/buckets.json"),
  ]);
  assert.doesNotThrow(() => assertDatabaseContract(databases[0], databases[0]));
  assert.doesNotThrow(() => assertTableContract(tables[0], tables[0]));

  const wrongColumn = structuredClone(tables[0]);
  wrongColumn.columns.find((column) => column.key === "organization_id").size = 35;
  assert.throws(
    () => assertTableContract(tables[0], wrongColumn),
    /column contract drifted/,
  );

  const wrongIndex = structuredClone(tables[0]);
  wrongIndex.indexes[0].columns = ["slug", "status"];
  assert.throws(
    () => assertTableContract(tables[0], wrongIndex),
    /index contract drifted/,
  );

  assert.doesNotThrow(() => assertBucketContract(buckets[0], buckets[0]));
  assert.throws(
    () =>
      assertBucketContract(buckets[0], {
        ...buckets[0],
        maximumFileSize: buckets[0].maximumFileSize + 1,
      }),
    /bucket contract drifted/,
  );
});
