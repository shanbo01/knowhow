import assert from "node:assert/strict";
import test from "node:test";
import type { AppwriteServerConfig } from "../lib/server/appwrite-config";
import {
  remoteHealthUrl,
  workerReadiness,
} from "../lib/server/worker-readiness";

const controlledConfig: AppwriteServerConfig = {
  endpoint: "https://appwrite.staging.example/v1",
  internalEndpoint: "https://appwrite.staging.example/v1",
  projectId: "knowhow-staging",
  apiKey: "s".repeat(40),
  databaseId: "knowhow_core_staging",
  privateMediaBucketId: "knowhow_private_media_staging",
  exportsBucketId: "knowhow_exports_staging",
  environment: "staging",
};

function withWorkerEnvironment(
  url: string | undefined,
  token: string | undefined,
) {
  const previousUrl = process.env.KNOWHOW_WORKER_HEALTH_URL;
  const previousToken = process.env.KNOWHOW_WORKER_HEALTH_TOKEN;
  if (url === undefined) delete process.env.KNOWHOW_WORKER_HEALTH_URL;
  else process.env.KNOWHOW_WORKER_HEALTH_URL = url;
  if (token === undefined) delete process.env.KNOWHOW_WORKER_HEALTH_TOKEN;
  else process.env.KNOWHOW_WORKER_HEALTH_TOKEN = token;
  return () => {
    if (previousUrl === undefined) delete process.env.KNOWHOW_WORKER_HEALTH_URL;
    else process.env.KNOWHOW_WORKER_HEALTH_URL = previousUrl;
    if (previousToken === undefined)
      delete process.env.KNOWHOW_WORKER_HEALTH_TOKEN;
    else process.env.KNOWHOW_WORKER_HEALTH_TOKEN = previousToken;
  };
}

test("controlled worker readiness fails closed when its health contract is missing", async () => {
  const restore = withWorkerEnvironment(undefined, undefined);
  try {
    assert.deepEqual(await workerReadiness(controlledConfig), {
      enabled: true,
      ready: false,
      mode: "remote",
      state: "missing",
    });
  } finally {
    restore();
  }
});

test("controlled worker readiness authenticates and release-matches the remote service", async () => {
  const token = "w".repeat(32);
  const restore = withWorkerEnvironment(
    "https://workers.staging.example/health/ready",
    token,
  );
  const previousRelease = process.env.KNOWHOW_RELEASE;
  process.env.KNOWHOW_RELEASE = "release-test";
  try {
    const result = await workerReadiness(controlledConfig, {
      fetcher: async (input, init) => {
        assert.equal(input, "https://workers.staging.example/health/ready");
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          `Bearer ${token}`,
        );
        return Response.json({ status: "ready", release: "release-test" });
      },
    });
    assert.deepEqual(result, {
      enabled: true,
      ready: true,
      mode: "remote",
      state: "ready",
    });
  } finally {
    restore();
    if (previousRelease === undefined) delete process.env.KNOWHOW_RELEASE;
    else process.env.KNOWHOW_RELEASE = previousRelease;
  }
});

test("remote worker health URLs must be exact non-local HTTPS endpoints", () => {
  assert.equal(
    remoteHealthUrl("https://workers.example/health/ready"),
    "https://workers.example/health/ready",
  );
  assert.equal(remoteHealthUrl("http://workers.example/health/ready"), null);
  assert.equal(remoteHealthUrl("https://localhost/health/ready"), null);
  assert.equal(remoteHealthUrl("https://workers.example/"), null);
  assert.equal(remoteHealthUrl("https://workers.example/health?ready=1"), null);
});
