import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  appwriteSessionCookieName,
  deploymentConfigurationIssues,
  getAppwriteServerConfig,
} from "../lib/server/appwrite-config";
import {
  assertCookieMutationRequest,
  HttpError,
  readJsonObject,
  toErrorResponse,
} from "../lib/server/http-security";
import { RecordConflictError } from "../lib/server/record-store";
import { sessionSecret } from "../lib/server/session-identity";
import { assertExportWorkerRequest } from "../lib/server/worker-auth";
import { scrubSentryEvent } from "../lib/telemetry-scrubber";

function withEnvironment(values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function mutationRequest(options: {
  origin?: string;
  fetchSite?: string;
  cookie?: string;
  csrf?: string;
} = {}) {
  return new Request("https://knowhow.example/api/knowhow", {
    method: "POST",
    headers: {
      ...(options.origin === undefined
        ? {}
        : { origin: options.origin }),
      ...(options.fetchSite ? { "sec-fetch-site": options.fetchSite } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrf ? { "x-csrf-token": options.csrf } : {}),
    },
  });
}

test("record conflicts return a safe retryable 409 envelope", async () => {
  const response = toErrorResponse(
    new RecordConflictError(),
    "request_conflict_0000000000000000",
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "The record changed while this request was running. Retry the operation.",
    code: "CONCURRENT_UPDATE",
    requestId: "request_conflict_0000000000000000",
  });
});
test("cookie mutations require same-origin proof and a matching CSRF token", () => {
  const token = "a".repeat(64);
  assert.doesNotThrow(() =>
    assertCookieMutationRequest(
      mutationRequest({
        origin: "https://knowhow.example",
        fetchSite: "same-origin",
        cookie: `knowhow_csrf=${token}`,
        csrf: token,
      }),
    ),
  );
  for (const request of [
    mutationRequest({ cookie: `knowhow_csrf=${token}`, csrf: token }),
    mutationRequest({
      origin: "https://evil.example",
      cookie: `knowhow_csrf=${token}`,
      csrf: token,
    }),
    mutationRequest({
      origin: "https://knowhow.example",
      fetchSite: "cross-site",
      cookie: `knowhow_csrf=${token}`,
      csrf: token,
    }),
    mutationRequest({
      origin: "https://knowhow.example",
      cookie: `knowhow_csrf=${token}`,
      csrf: "b".repeat(64),
    }),
  ]) {
    assert.throws(
      () => assertCookieMutationRequest(request),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );
  }
});

test("trusted origin accepts the browser-facing Host behind a stale forwarded host", () => {
  const token = "a".repeat(64);
  const request = new Request("http://site-runtime.internal/api/knowhow", {
    method: "POST",
    headers: {
      host: "current.reverse-proxy.test",
      origin: "https://current.reverse-proxy.test",
      "x-forwarded-host": "previous.reverse-proxy.test",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
      cookie: `knowhow_csrf=${token}`,
      "x-csrf-token": token,
    },
  });
  assert.doesNotThrow(() => assertCookieMutationRequest(request));

  const crossOrigin = new Request(request, {
    headers: {
      ...Object.fromEntries(request.headers),
      origin: "https://another.reverse-proxy.test",
    },
  });
  assert.throws(
    () => assertCookieMutationRequest(crossOrigin),
    (error: unknown) =>
      error instanceof HttpError && error.code === "UNTRUSTED_ORIGIN",
  );
});

test("JSON parsing enforces content type, object shape, and byte limits", async () => {
  assert.deepEqual(
    await readJsonObject(
      new Request("https://knowhow.example/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ safe: true }),
      }),
      64,
    ),
    { safe: true },
  );
  await assert.rejects(
    readJsonObject(
      new Request("https://knowhow.example/api", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "JSON_REQUIRED",
  );
  await assert.rejects(
    readJsonObject(
      new Request("https://knowhow.example/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(["not", "an", "object"]),
      }),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "JSON_OBJECT_REQUIRED",
  );
  await assert.rejects(
    readJsonObject(
      new Request("https://knowhow.example/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oversized: "x".repeat(100) }),
      }),
      32,
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "REQUEST_TOO_LARGE",
  );
});

test("session secrets are accepted only from the HTTP-only Appwrite cookie boundary", () => {
  const restore = withEnvironment({
    KNOWHOW_ENVIRONMENT: "development",
    APPWRITE_ENDPOINT: "http://localhost/v1",
    APPWRITE_PROJECT_ID: "project_test",
    APPWRITE_API_KEY: "test-api-key-with-at-least-twenty-characters",
  });
  try {
    assert.equal(appwriteSessionCookieName("project_test"), "a_session_project_test");
    assert.throws(() => appwriteSessionCookieName("bad project"));
    const request = new Request("https://knowhow.example/app", {
      headers: { cookie: "a_session_project_test=server-session-secret" },
    });
    assert.equal(sessionSecret(request), "server-session-secret");
    assert.throws(
      () => sessionSecret(new Request("https://knowhow.example/app")),
      (error: unknown) =>
        error instanceof HttpError && error.code === "AUTH_REQUIRED",
    );
  } finally {
    restore();
  }
});

test("runtime configuration accepts only local Appwrite endpoints and origins", () => {
  const restore = withEnvironment({
    KNOWHOW_ENVIRONMENT: "development",
    NEXT_PUBLIC_KNOWHOW_ENVIRONMENT: "development",
    KNOWHOW_RELEASE: "local",
    NEXT_PUBLIC_KNOWHOW_RELEASE: "local",
    APPWRITE_ENDPOINT: "http://localhost/v1",
    APPWRITE_INTERNAL_ENDPOINT: "http://appwrite-internal/v1",
    APPWRITE_PROJECT_ID: "knowhow-local",
    APPWRITE_API_KEY: "local-api-key-with-at-least-twenty-characters",
    KNOWHOW_ALLOWED_ORIGINS: "http://localhost:3001",
    KNOWHOW_SITE_ORIGIN: "http://localhost:3001",
    KNOWHOW_EXTENSION_ORIGINS:
      "chrome-extension://phbofjenfnnnnndghhinoldlfbpaedpo",
    KNOWHOW_RATE_LIMIT_PEPPER: "r".repeat(32),
    KNOWHOW_TOKEN_KEYS_JSON: JSON.stringify({ v1: "t".repeat(32) }),
    KNOWHOW_TOKEN_ACTIVE_KID: "v1",
    KNOWHOW_EXPORT_WORKER_SECRET: "e".repeat(32),
  });
  try {
    const config = getAppwriteServerConfig();
    assert.equal(config.endpoint, "http://localhost/v1");
    assert.equal(config.internalEndpoint, "http://appwrite-internal/v1");
    assert.deepEqual(deploymentConfigurationIssues(config), []);

    for (const endpoint of [
      "https://example.invalid/v1",
      "http://user@localhost/v1",
      "http://localhost/v1?target=test",
      "http://localhost/v1#test",
      "http://localhost/console",
    ]) {
      process.env.APPWRITE_ENDPOINT = endpoint;
      assert.throws(
        () => getAppwriteServerConfig(),
        /exact local Appwrite \/v1 endpoint/,
      );
    }

    process.env.APPWRITE_ENDPOINT = "http://localhost/v1";
    process.env.APPWRITE_INTERNAL_ENDPOINT = "https://example.invalid/v1";
    assert.throws(
      () => getAppwriteServerConfig(),
      /APPWRITE_INTERNAL_ENDPOINT must be an exact local Appwrite \/v1 endpoint/,
    );

    process.env.APPWRITE_INTERNAL_ENDPOINT = "http://appwrite-internal/v1";
    process.env.KNOWHOW_ALLOWED_ORIGINS = "https://example.invalid";
    assert.ok(deploymentConfigurationIssues().includes("allowed_origins"));
    process.env.KNOWHOW_ALLOWED_ORIGINS = "http://localhost:3001";
    process.env.APPWRITE_DATABASE_ID = "other_database";
    assert.ok(deploymentConfigurationIssues().includes("resource_ids"));
  } finally {
    restore();
  }
});

test("the internal export processor requires a fresh HMAC-authenticated request", async () => {
  const restore = withEnvironment({
    KNOWHOW_EXPORT_WORKER_SECRET: "worker-secret-with-at-least-thirty-two-bytes",
  });
  try {
    const jobId = "export_job_test";
    const timestamp = String(Date.now());
    const signature = createHmac(
      "sha256",
      process.env.KNOWHOW_EXPORT_WORKER_SECRET!,
    )
      .update(`${timestamp}.${jobId}`)
      .digest("hex");
    const request = new Request("https://knowhow.example/api/internal/export-worker", {
      method: "POST",
      headers: {
        "x-knowhow-worker-timestamp": timestamp,
        "x-knowhow-worker-signature": signature,
      },
    });
    await assertExportWorkerRequest(request, jobId);
    await assert.rejects(
      assertExportWorkerRequest(request, "another_job"),
      (error: unknown) =>
        error instanceof HttpError && error.code === "WORKER_AUTH_INVALID",
    );
    await assert.rejects(
      assertExportWorkerRequest(request, jobId, Date.now() + 6 * 60_000),
      (error: unknown) =>
        error instanceof HttpError && error.code === "WORKER_AUTH_EXPIRED",
    );
  } finally {
    restore();
  }
});

test("Sentry scrubbing removes PII, secrets, content, and dynamic tenant IDs", () => {
  const event = scrubSentryEvent({
    user: { id: "user-secret", email: "person@example.com" },
    message: "Guide content and token secret",
    transaction: "/w/acme-private/guides/guide_12345678901234567890?token=secret",
    request: {
      url: "https://knowhow.example/w/acme-private/guides/guide_12345678901234567890?token=secret",
      headers: { authorization: "Bearer secret" },
      cookies: { session: "secret" },
      data: { guide: "private content" },
      query_string: "token=secret",
    },
    extra: {
      requestId: "request-safe",
      guideText: "private content",
      authorization: "Bearer secret",
    },
    tags: { environment: "staging", email: "person@example.com" },
    exception: {
      values: [{ type: "HttpError", value: "secret guide content" }],
    },
  });
  assert.equal(event.user, undefined);
  assert.equal(event.message, "Application event");
  assert.equal(event.transaction, "/w/:workspace/guides/:id");
  assert.equal(event.request?.url, "/w/:workspace/guides/:id");
  assert.equal(event.request?.headers, undefined);
  assert.equal(event.request?.cookies, undefined);
  assert.equal(event.request?.data, undefined);
  assert.deepEqual(event.extra, { requestId: "request-safe" });
  assert.deepEqual(event.tags, { environment: "staging" });
  assert.equal(event.exception?.values?.[0].value, "HttpError captured");
});
