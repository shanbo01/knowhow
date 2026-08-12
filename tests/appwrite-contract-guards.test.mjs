import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertBucketContract,
  assertControlledMutationBinding,
  assertDatabaseContract,
  assertFunctionContract,
  assertSiteContract,
  assertTableContract,
  controlledSiteOrigin,
  resolveSmokeTarget,
} from "../scripts/appwrite-contract-guards.mjs";

const root = new URL("../", import.meta.url);
const json = async (path) =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));

test("controlled smoke endpoints and Site origins are exact", () => {
  assert.deepEqual(
    resolveSmokeTarget("https://fra.cloud.appwrite.io/v1", {
      allowStaging: true,
      environment: "staging",
    }),
    {
      endpoint: "https://fra.cloud.appwrite.io/v1",
      target: "frankfurt-staging",
    },
  );
  assert.deepEqual(
    resolveSmokeTarget("https://fra.cloud.appwrite.io/v1", {
      allowProduction: true,
      environment: "production",
    }),
    {
      endpoint: "https://fra.cloud.appwrite.io/v1",
      target: "frankfurt-production",
    },
  );
  assert.equal(
    resolveSmokeTarget("http://localhost:8080/v1", {
      environment: "development",
    }).target,
    "self-host",
  );
  for (const endpoint of [
    "https://fra.cloud.appwrite.io:443/v1",
    "https://user@fra.cloud.appwrite.io/v1",
    "https://fra.cloud.appwrite.io/v1?project=staging",
    "https://fra.cloud.appwrite.io/v1#staging",
    "http://fra.cloud.appwrite.io/v1",
  ]) {
    assert.throws(
      () =>
        resolveSmokeTarget(endpoint, {
          allowStaging: true,
          environment: "staging",
        }),
      /exact local endpoint or Appwrite Cloud Frankfurt endpoint/,
    );
  }
  assert.throws(
    () =>
      resolveSmokeTarget("http://localhost/v1", {
        environment: "production",
      }),
    /cannot use a local Appwrite endpoint/,
  );
  assert.equal(
    controlledSiteOrigin("https://staging.knowhow.example", "frankfurt-staging"),
    "https://staging.knowhow.example",
  );
  assert.throws(
    () =>
      controlledSiteOrigin(
        "https://staging.knowhow.example/path",
        "frankfurt-staging",
      ),
    /exact controlled HTTPS origin/,
  );
});

test("controlled smoke mutations bind distinct reviewed project IDs", () => {
  assert.doesNotThrow(() =>
    assertControlledMutationBinding({
      target: "frankfurt-staging",
      projectId: "project-staging",
      expectedProjectId: "project-staging",
      forbiddenProjectId: "project-production",
      confirmation: "staging-transient-fixtures",
    }),
  );
  assert.throws(
    () =>
      assertControlledMutationBinding({
        target: "frankfurt-staging",
        projectId: "project-production",
        expectedProjectId: "project-staging",
        forbiddenProjectId: "project-production",
        confirmation: "staging-transient-fixtures",
      }),
    /reviewed environment binding/,
  );
  assert.throws(
    () =>
      assertControlledMutationBinding({
        target: "frankfurt-production",
        projectId: "project-production",
        expectedProjectId: "project-production",
        forbiddenProjectId: "project-staging",
        confirmation: "production-transient-fixtures",
        syntheticOnly: "1",
        finalProduction: "0",
      }),
    /final-Production and synthetic-only attestations/,
  );
});

test("live contracts reject schema, bucket, Function, and Site drift", async () => {
  const [databases, tables, buckets, config] = await Promise.all([
    json("infrastructure/appwrite/databases.json"),
    json("infrastructure/appwrite/tables.json"),
    json("infrastructure/appwrite/buckets.json"),
    json("appwrite.config.json"),
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

  const liveFunction = {
    ...config.functions[0],
    live: true,
    deploymentId: "deployment-a",
    latestDeploymentId: "deployment-a",
    latestDeploymentStatus: "ready",
  };
  assert.doesNotThrow(() =>
    assertFunctionContract(config.functions[0], liveFunction),
  );
  assert.throws(
    () =>
      assertFunctionContract(config.functions[0], {
        ...liveFunction,
        scopes: [...liveFunction.scopes, "keys.write"],
      }),
    /Function contract drifted/,
  );
  assert.throws(
    () => assertFunctionContract(config.functions[0], { ...liveFunction, live: false }),
    /undeployed configuration changes/,
  );

  const liveSite = {
    ...config.sites[0],
    live: true,
    deploymentId: "deployment-b",
    latestDeploymentId: "deployment-b",
    latestDeploymentStatus: "ready",
  };
  assert.doesNotThrow(() => assertSiteContract(config.sites[0], liveSite));
  assert.throws(
    () =>
      assertSiteContract(config.sites[0], {
        ...liveSite,
        latestDeploymentId: "deployment-c",
      }),
    /latest ready deployment active/,
  );
});
