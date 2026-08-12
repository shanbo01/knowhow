import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  appwriteSessionCookieName,
  deploymentConfigurationIssues,
  getAppwriteServerConfig,
  restoreApplicationConfiguration,
} from "../lib/server/appwrite-config";
import { proxy } from "../proxy";
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
      host: "current-deployment.appwrite.network",
      origin: "https://current-deployment.appwrite.network",
      "x-forwarded-host": "previous-deployment.appwrite.network",
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
      origin: "https://another-deployment.appwrite.network",
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
    APPWRITE_ENDPOINT: "https://fra.cloud.appwrite.io/v1",
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

test("controlled environments accept only attested Frankfurt fallback or Azure Qatar endpoints", () => {
  const restore = withEnvironment({
    KNOWHOW_ENVIRONMENT: "production",
    NEXT_PUBLIC_KNOWHOW_ENVIRONMENT: "production",
    APPWRITE_ENDPOINT: "https://fra.cloud.appwrite.io/v1",
    APPWRITE_PROJECT_ID: "project_production",
    APPWRITE_API_KEY: "production-api-key-with-at-least-twenty-characters",
    KNOWHOW_ALLOWED_ORIGINS: "https://knowhow.example",
    KNOWHOW_EXTENSION_ORIGINS:
      "chrome-extension://phbofjenfnnnnndghhinoldlfbpaedpo",
    NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL:
      "https://chromewebstore.google.com/detail/knowhow/example",
    NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL:
      "https://microsoftedge.microsoft.com/addons/detail/knowhow/example",
    KNOWHOW_RATE_LIMIT_PEPPER: "r".repeat(32),
    KNOWHOW_TOKEN_KEYS_JSON: JSON.stringify({ v1: "t".repeat(32) }),
    KNOWHOW_TOKEN_ACTIVE_KID: "v1",
    NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    KNOWHOW_RELEASE: "release-1",
    NEXT_PUBLIC_KNOWHOW_RELEASE: "release-1",
    KNOWHOW_EXPORT_WORKER_SECRET: "e".repeat(32),
    KNOWHOW_SITE_ORIGIN: "https://knowhow.example",
  });
  try {
    assert.equal(getAppwriteServerConfig().endpoint, "https://fra.cloud.appwrite.io/v1");
    assert.deepEqual(deploymentConfigurationIssues(), []);
    for (const endpoint of [
      "https://nyc.cloud.appwrite.io/v1",
      "https://fra.cloud.appwrite.io:443/v1",
      "https://user@fra.cloud.appwrite.io/v1",
      "https://fra.cloud.appwrite.io/v1?target=production",
      "https://fra.cloud.appwrite.io/v1#production",
    ]) {
      process.env.APPWRITE_ENDPOINT = endpoint;
      assert.throws(() => getAppwriteServerConfig(), /approved Frankfurt Cloud or Azure Qatar Central/);
    }
    process.env.APPWRITE_ENDPOINT =
      "https://knowhowbeta-abc123.qatarcentral.cloudapp.azure.com/v1";
    assert.throws(() => getAppwriteServerConfig(), /approved Frankfurt Cloud or Azure Qatar Central/);
    process.env.KNOWHOW_APPWRITE_RESIDENCY = "azure-qatar-central";
    assert.equal(
      getAppwriteServerConfig().endpoint,
      "https://knowhowbeta-abc123.qatarcentral.cloudapp.azure.com/v1",
    );
    for (const endpoint of [
      "http://knowhowbeta-abc123.qatarcentral.cloudapp.azure.com/v1",
      "https://knowhowbeta-abc123.qatarcentral.cloudapp.azure.com:443/v1",
      "https://knowhowbeta-abc123.qatarcentral.cloudapp.azure.com/v1?target=production",
      "https://qatarcentral.cloudapp.azure.com/v1",
      "https://knowhowbeta-abc123.uaenorth.cloudapp.azure.com/v1",
    ]) {
      process.env.APPWRITE_ENDPOINT = endpoint;
      assert.throws(() => getAppwriteServerConfig(), /approved Frankfurt Cloud or Azure Qatar Central|must use HTTPS/);
    }
    delete process.env.KNOWHOW_APPWRITE_RESIDENCY;
    process.env.APPWRITE_ENDPOINT = "https://fra.cloud.appwrite.io/v1";
    process.env.KNOWHOW_ALLOWED_ORIGINS = "https://knowhow.example/path";
    assert.ok(deploymentConfigurationIssues().includes("allowed_origins"));
    process.env.KNOWHOW_ALLOWED_ORIGINS = "https://knowhow.example";
    process.env.NEXT_PUBLIC_KNOWHOW_RELEASE = "another-release";
    assert.ok(
      deploymentConfigurationIssues().includes("public_deployment_identity"),
    );
    process.env.NEXT_PUBLIC_KNOWHOW_RELEASE = "release-1";
    process.env.APPWRITE_DATABASE_ID = "other_database";
    assert.ok(deploymentConfigurationIssues().includes("resource_ids"));
    delete process.env.APPWRITE_DATABASE_ID;
    delete process.env.KNOWHOW_EXPORT_WORKER_SECRET;
    assert.ok(deploymentConfigurationIssues().includes("export_worker_secret"));
  } finally {
    restore();
  }
});

test("isolated restore mode permits only an access-controlled alternate Production database", () => {
  const restore = withEnvironment({
    KNOWHOW_ENVIRONMENT: "production",
    NEXT_PUBLIC_KNOWHOW_ENVIRONMENT: "production",
    APPWRITE_ENDPOINT: "https://fra.cloud.appwrite.io/v1",
    APPWRITE_PROJECT_ID: "project_production",
    APPWRITE_API_KEY: "production-api-key-with-at-least-twenty-characters",
    APPWRITE_DATABASE_ID: "knowhow_restore_releasea",
    KNOWHOW_ALLOWED_ORIGINS: "https://restore.knowhow.example",
    KNOWHOW_EXTENSION_ORIGINS:
      "chrome-extension://phbofjenfnnnnndghhinoldlfbpaedpo",
    NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL:
      "https://chromewebstore.google.com/detail/knowhow/example",
    NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL:
      "https://microsoftedge.microsoft.com/addons/detail/knowhow/example",
    KNOWHOW_RATE_LIMIT_PEPPER: "r".repeat(32),
    KNOWHOW_TOKEN_KEYS_JSON: JSON.stringify({ v1: "t".repeat(32) }),
    KNOWHOW_TOKEN_ACTIVE_KID: "v1",
    NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    KNOWHOW_RELEASE: "a".repeat(40),
    NEXT_PUBLIC_KNOWHOW_RELEASE: "a".repeat(40),
    KNOWHOW_EXPORT_WORKER_SECRET: "e".repeat(32),
    KNOWHOW_SITE_ORIGIN: "https://restore.knowhow.example",
    KNOWHOW_RESTORE_APPLICATION_MODE: "1",
    KNOWHOW_RESTORE_APPLICATION_CONFIRM:
      "production-isolated-restore-application",
    KNOWHOW_RESTORE_APPLICATION_DATABASE_ID: "knowhow_restore_releasea",
    KNOWHOW_RESTORE_APPLICATION_SITE_ID: "knowhow_restore_web_releasea",
    KNOWHOW_RESTORE_RESTORATION_ID: "restoration_releasea",
    KNOWHOW_RESTORE_APPLICATION_SITE_ORIGIN:
      "https://restore.knowhow.example",
    KNOWHOW_RESTORE_APPLICATION_EXPECTED_PROJECT_ID: "project_production",
    KNOWHOW_RESTORE_APPLICATION_EXPECTED_RELEASE: "a".repeat(40),
    KNOWHOW_RESTORE_APPLICATION_SOURCE_PROJECT_ID: "project_production",
    KNOWHOW_RESTORE_APPLICATION_SOURCE_SITE_ORIGIN:
      "https://knowhow.example",
    KNOWHOW_RESTORE_APPLICATION_ACCESS_TOKEN: "x".repeat(48),
    KNOWHOW_RESTORE_APPLICATION_ISOLATED: "1",
    KNOWHOW_RESTORE_APPLICATION_NON_PUBLIC: "1",
    KNOWHOW_RESTORE_APPLICATION_SYNTHETIC_ONLY: "1",
    KNOWHOW_RESTORE_APPLICATION_EMAIL_DISABLED: "1",
    KNOWHOW_RESTORE_APPLICATION_EXCLUSIVE: "1",
  });
  try {
    const config = getAppwriteServerConfig();
    assert.equal(config.databaseId, "knowhow_restore_releasea");
    assert.deepEqual(restoreApplicationConfiguration(config), {
      enabled: true,
      valid: true,
      databaseId: "knowhow_restore_releasea",
      restorationId: "restoration_releasea",
      siteId: "knowhow_restore_web_releasea",
      siteOrigin: "https://restore.knowhow.example",
      sourceSiteOrigin: "https://knowhow.example",
      issues: [],
    });
    assert.deepEqual(deploymentConfigurationIssues(config), []);

    const denied = proxy(
      new NextRequest("https://restore.knowhow.example/api/health?ready=1"),
    );
    assert.equal(denied.status, 404);
    assert.match(denied.headers.get("x-robots-tag") ?? "", /noindex/);
    const allowed = proxy(
      new NextRequest("https://restore.knowhow.example/api/health?ready=1", {
        headers: { "x-knowhow-restore-access": "x".repeat(48) },
      }),
    );
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("x-middleware-next"), "1");
    assert.equal(
      allowed.headers.has("x-middleware-request-x-knowhow-restore-access"),
      false,
    );

    process.env.APPWRITE_DATABASE_ID = "knowhow_core";
    assert.equal(
      proxy(
        new NextRequest("https://restore.knowhow.example/api/health?ready=1", {
          headers: { "x-knowhow-restore-access": "x".repeat(48) },
        }),
      ).status,
      404,
    );
    process.env.APPWRITE_DATABASE_ID = "knowhow_restore_releasea";

    process.env.KNOWHOW_RESTORE_APPLICATION_SITE_ID = "knowhow_web";
    assert.equal(
      proxy(
        new NextRequest("https://restore.knowhow.example/api/health?ready=1", {
          headers: { "x-knowhow-restore-access": "x".repeat(48) },
        }),
      ).status,
      404,
    );
    process.env.KNOWHOW_RESTORE_APPLICATION_SITE_ID =
      "knowhow_restore_web_releasea";

    process.env.KNOWHOW_RESTORE_APPLICATION_ACCESS_TOKEN = "weak";
    assert.ok(
      deploymentConfigurationIssues(config).includes("restore_application"),
    );
    assert.equal(
      proxy(
        new NextRequest("https://restore.knowhow.example/api/health?ready=1", {
          headers: { "x-knowhow-restore-access": "weak" },
        }),
      ).status,
      404,
    );
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
