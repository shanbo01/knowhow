import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Functions, Models } from "node-appwrite";
import type { AppwriteServerConfig } from "./appwrite-config";
import { workerReadiness } from "./worker-readiness";

const NOW = new Date("2026-03-01T12:00:00.000Z");

const config: AppwriteServerConfig = {
  endpoint: "https://appwrite.example.com/v1",
  internalEndpoint: "https://appwrite.example.com/v1",
  projectId: "knowhow-prod",
  apiKey: "x".repeat(40),
  databaseId: "knowhow_core",
  privateMediaBucketId: "knowhow_private_media",
  exportsBucketId: "knowhow_exports",
  environment: "production",
};

const TOUCHED = [
  "KNOWHOW_WORKER_HEALTH_URL",
  "KNOWHOW_WORKER_HEALTH_TOKEN",
  "KNOWHOW_WORKER_MAX_AGE_MS",
  "KNOWHOW_OPERATIONS_FUNCTION_ID",
  "KNOWHOW_RELEASE",
];

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

/** Minimal stand-in for the one Functions method readiness calls. */
function functionsReturning(
  executions: Array<Partial<Models.Execution>>,
): Pick<Functions, "listExecutions"> {
  return {
    listExecutions: async () => ({
      total: executions.length,
      executions: executions as Models.Execution[],
    }),
  } as unknown as Pick<Functions, "listExecutions">;
}

function execution(
  minutesAgo: number,
  status: string,
): Partial<Models.Execution> {
  return {
    $id: "exec",
    $createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    status: status as Models.Execution["status"],
    trigger: "schedule" as Models.Execution["trigger"],
  };
}

describe("workerReadiness on a controlled deployment", () => {
  it("is ready when the operations function completed recently", async () => {
    const result = await workerReadiness(config, {
      now: NOW,
      functions: functionsReturning([execution(2, "completed")]),
    });
    assert.equal(result.ready, true);
    assert.equal(result.mode, "scheduled");
    assert.equal(result.state, "ready");
    assert.equal(result.ageMs, 2 * 60_000);
  });

  it("stays ready while a run is still in flight", async () => {
    for (const status of ["waiting", "processing"]) {
      const result = await workerReadiness(config, {
        now: NOW,
        functions: functionsReturning([execution(1, status)]),
      });
      assert.equal(result.ready, true, `${status} should not be a fault`);
    }
  });

  it("is stale once the last run outlives three schedule cycles", async () => {
    const result = await workerReadiness(config, {
      now: NOW,
      functions: functionsReturning([execution(16, "completed")]),
    });
    assert.equal(result.ready, false);
    assert.equal(result.state, "stale");
  });

  it("tolerates a backlog inside the age window", async () => {
    const result = await workerReadiness(config, {
      now: NOW,
      functions: functionsReturning([execution(14, "completed")]),
    });
    assert.equal(result.ready, true, "14 minutes is under the 15 minute ceiling");
  });

  it("reports a failed run as failed, not stale", async () => {
    const result = await workerReadiness(config, {
      now: NOW,
      functions: functionsReturning([execution(1, "failed")]),
    });
    assert.equal(result.ready, false);
    assert.equal(result.state, "failed");
  });

  it("reports a function that has never run as missing", async () => {
    const result = await workerReadiness(config, {
      now: NOW,
      functions: functionsReturning([]),
    });
    assert.equal(result.ready, false);
    assert.equal(result.state, "missing");
  });

  it("refuses to claim readiness when Appwrite cannot be reached", async () => {
    const functions = {
      listExecutions: async () => {
        throw new Error("network");
      },
    } as unknown as Pick<Functions, "listExecutions">;
    const result = await workerReadiness(config, { now: NOW, functions });
    assert.equal(result.ready, false);
    assert.equal(result.state, "invalid");
  });

  it("rejects an execution timestamped in the future", async () => {
    const result = await workerReadiness(config, {
      now: NOW,
      functions: functionsReturning([execution(-5, "completed")]),
    });
    assert.equal(result.ready, false);
    assert.equal(result.state, "stale");
  });

  it("honours a configured age ceiling", async () => {
    process.env.KNOWHOW_WORKER_MAX_AGE_MS = String(30 * 60_000);
    const result = await workerReadiness(config, {
      now: NOW,
      functions: functionsReturning([execution(25, "completed")]),
    });
    assert.equal(result.ready, true);
  });

  it("never reports ready without a way to check", async () => {
    const result = await workerReadiness(config, { now: NOW });
    assert.equal(result.ready, false);
    assert.equal(result.state, "invalid");
  });
});

describe("workerReadiness with an external worker service", () => {
  it("uses the remote endpoint instead of execution history", async () => {
    process.env.KNOWHOW_WORKER_HEALTH_URL =
      "https://workers.example.com/health/ready";
    process.env.KNOWHOW_WORKER_HEALTH_TOKEN = "t".repeat(32);
    const result = await workerReadiness(config, {
      now: NOW,
      functions: functionsReturning([execution(999, "failed")]),
      fetcher: (async () =>
        new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    assert.equal(result.mode, "remote");
    assert.equal(result.ready, true);
  });

  it("refuses a half-configured external service rather than falling back", async () => {
    process.env.KNOWHOW_WORKER_HEALTH_URL =
      "https://workers.example.com/health/ready";
    const result = await workerReadiness(config, {
      now: NOW,
      functions: functionsReturning([execution(1, "completed")]),
    });
    assert.equal(result.mode, "remote");
    assert.equal(result.state, "invalid");
  });

  it("rejects a worker reporting a different release", async () => {
    process.env.KNOWHOW_WORKER_HEALTH_URL =
      "https://workers.example.com/health/ready";
    process.env.KNOWHOW_WORKER_HEALTH_TOKEN = "t".repeat(32);
    process.env.KNOWHOW_RELEASE = "abc123";
    const result = await workerReadiness(config, {
      now: NOW,
      fetcher: (async () =>
        new Response(JSON.stringify({ status: "ready", release: "stale" }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    assert.equal(result.ready, false);
  });
});
