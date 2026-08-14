import assert from "node:assert/strict";
import test from "node:test";
import {
  localWorkerEmulation,
  sendViaMailpit,
} from "../functions/operations/src/main.js";
import {
  exactLoopbackUrl,
  validateLocalWorkerEnvironment,
} from "../scripts/run-local-workers.mjs";

function localEnvironment(overrides = {}) {
  return {
    KNOWHOW_LOCAL_WORKER_MODE: "emulated",
    KNOWHOW_ENVIRONMENT: "development",
    APPWRITE_ENDPOINT: "http://localhost/v1",
    APPWRITE_PROJECT_ID: "knowhow-local",
    APPWRITE_DATABASE_ID: "knowhow_core",
    APPWRITE_PRIVATE_MEDIA_BUCKET_ID: "knowhow_private_media",
    APPWRITE_EXPORTS_BUCKET_ID: "knowhow_exports",
    APPWRITE_API_KEY: "local-disposable-key",
    KNOWHOW_LOCAL_MAILPIT_URL: "http://127.0.0.1:8025",
    KNOWHOW_SITE_ORIGIN: "http://localhost:3001",
    ...overrides,
  };
}

test("local worker guard accepts only the exact disposable loopback contract", () => {
  const result = validateLocalWorkerEnvironment(localEnvironment());
  assert.equal(result.endpoint.origin, "http://localhost");
  assert.equal(result.mailpit.origin, "http://127.0.0.1:8025");
  assert.equal(
    exactLoopbackUrl("http://localhost/v1", "/v1")?.pathname,
    "/v1",
  );
});

test("local worker guard rejects remote endpoints, non-development mode, and alternate projects", () => {
  assert.throws(
    () =>
      validateLocalWorkerEnvironment(
        localEnvironment({
          APPWRITE_ENDPOINT: "https://example.invalid/v1",
        }),
      ),
    /LOCAL_WORKER_ENDPOINT_INVALID/,
  );
  assert.throws(
    () =>
      validateLocalWorkerEnvironment(
        localEnvironment({ KNOWHOW_ENVIRONMENT: "production" }),
      ),
    /LOCAL_WORKER_ENVIRONMENT_INVALID/,
  );
  assert.throws(
    () =>
      validateLocalWorkerEnvironment(
        localEnvironment({ APPWRITE_PROJECT_ID: "another-project" }),
      ),
    /LOCAL_WORKER_PROJECT_INVALID/,
  );
});

test("Mailpit delivery is available only behind the local emulation guard", async () => {
  const keys = [
    "KNOWHOW_LOCAL_WORKER_MODE",
    "KNOWHOW_ENVIRONMENT",
    "APPWRITE_FUNCTION_PROJECT_ID",
    "APPWRITE_FUNCTION_API_ENDPOINT",
    "KNOWHOW_LOCAL_MAILPIT_URL",
  ];
  const before = new Map(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    Object.assign(process.env, {
      KNOWHOW_LOCAL_WORKER_MODE: "emulated",
      KNOWHOW_ENVIRONMENT: "development",
      APPWRITE_FUNCTION_PROJECT_ID: "knowhow-local",
      APPWRITE_FUNCTION_API_ENDPOINT: "http://localhost/v1",
      KNOWHOW_LOCAL_MAILPIT_URL: "http://127.0.0.1:8025",
    });
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url, init };
      return new Response("{}", { status: 200 });
    };
    assert.equal(localWorkerEmulation()?.mailpitOrigin, "http://127.0.0.1:8025");
    assert.equal(
      await sendViaMailpit("tester@example.test", {
        subject: "Local delivery",
        html: "<p>Safe local message</p>",
      }),
      "mailpit-http",
    );
    assert.equal(request.url, "http://127.0.0.1:8025/api/v1/send");
    const body = JSON.parse(request.init.body);
    assert.deepEqual(body.To, [{ Email: "tester@example.test" }]);
    assert.equal(body.Subject, "Local delivery");

    process.env.APPWRITE_FUNCTION_PROJECT_ID = "another-project";
    assert.throws(() => localWorkerEmulation(), /LOCAL_WORKER_PROJECT_INVALID/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      const value = before.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
