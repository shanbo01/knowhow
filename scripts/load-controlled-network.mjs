import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, AppwriteException, Client } from "node-appwrite";
import {
  ControlledNetworkLoadError,
  contentFreeActor,
  controlledNetworkLoadConfiguration,
  evidenceKey,
  latencySummary,
  privateEvidencePath,
  projectFingerprint,
  requestIdDigest,
  safeFailure,
  sealNetworkLoadEvidence,
  verifyNetworkLoadEvidence,
} from "./controlled-network-load-guards.mjs";

const CSRF_COOKIE_NAME = "knowhow_csrf";
const JSON_LIMIT_BYTES = 2_000_000;
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function gateFailure(code, message) {
  throw new ControlledNetworkLoadError(code, message);
}

class CookieJar {
  #cookies = new Map();

  absorb(response) {
    const values = response.headers.getSetCookie?.();
    if (!Array.isArray(values)) {
      gateFailure("COOKIE_API_UNAVAILABLE", "Node.js 22 or later is required to retain controlled session cookies.");
    }
    for (const value of values) {
      const match = /^([^=;\s]+)=([^;]*)/.exec(value);
      if (!match) continue;
      if (match[2] === "" || /;\s*max-age=0(?:;|$)/i.test(value)) this.#cookies.delete(match[1]);
      else this.#cookies.set(match[1], match[2]);
    }
  }

  header() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  value(name) {
    return this.#cookies.get(name);
  }
}

function base32Bytes(input) {
  const secret = input.startsWith("otpauth://")
    ? new URL(input).searchParams.get("secret")
    : input;
  if (!secret) gateFailure("TOTP_SECRET_INVALID", "A controlled-load TOTP URI has no secret.");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.toUpperCase().replace(/[=\s-]/g, "");
  let bits = "";
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) gateFailure("TOTP_SECRET_INVALID", "A controlled-load TOTP secret is not valid base32.");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

async function totpCode(input) {
  const remainder = 30 - (Math.floor(Date.now() / 1_000) % 30);
  if (remainder <= 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_500));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", base32Bytes(input)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function runtimeFor(actor, configuration, runId) {
  return {
    actor,
    configuration,
    runId,
    jar: new CookieJar(),
    requestIds: [],
    userAgent: `KnowHow-Controlled-Load/1 (${actor.label})`,
    signedIn: false,
    pairingCreated: false,
    paired: false,
    accessToken: null,
    policyVersion: null,
    observedMemberCount: 0,
  };
}

function safeJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    gateFailure("RESPONSE_INVALID", "A controlled endpoint returned invalid JSON.");
  }
}

async function requestJson(runtime, path, options = {}) {
  const requestId = randomUUID();
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  headers.set("user-agent", runtime.userAgent);
  headers.set("x-request-id", requestId);
  if (options.origin) headers.set("origin", options.origin);
  if (options.authorization) headers.set("authorization", `Bearer ${options.authorization}`);
  if (options.useCookies !== false) {
    const cookie = runtime.jar.header();
    if (cookie) headers.set("cookie", cookie);
  }
  let body;
  if (options.body !== undefined) {
    headers.set("content-type", options.contentType ?? "application/json");
    body = options.contentType && options.contentType !== "application/json"
      ? options.body
      : JSON.stringify(options.body);
  }
  const started = performance.now();
  let response;
  try {
    response = await fetch(new URL(path, runtime.configuration.siteOrigin), {
      method: options.method ?? "GET",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(runtime.configuration.requestTimeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") gateFailure("REQUEST_TIMEOUT", "A controlled request exceeded its timeout.");
    gateFailure("REQUEST_FAILED", "A controlled request could not reach the expected Site.");
  }
  const elapsedMs = performance.now() - started;
  runtime.jar.absorb(response);
  const responseRequestId = response.headers.get("x-request-id")?.trim() ?? "";
  if (responseRequestId !== requestId) {
    gateFailure("REQUEST_ID_MISMATCH", "A controlled response did not preserve its exact correlation ID.");
  }
  runtime.requestIds.push(responseRequestId);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > JSON_LIMIT_BYTES) {
    gateFailure("RESPONSE_TOO_LARGE", "A controlled JSON response exceeded the evidence gate limit.");
  }
  const payload = safeJson(text);
  const expectedStatuses = options.expectedStatuses ?? [200];
  if (!expectedStatuses.includes(response.status)) {
    const code = typeof payload.code === "string" && /^[A-Z0-9_]{2,80}$/.test(payload.code)
      ? payload.code
      : "UNEXPECTED_STATUS";
    gateFailure(
      "HTTP_REQUEST_FAILED",
      `A controlled request returned HTTP ${response.status} (${code}) with request ID ${responseRequestId}.`,
    );
  }
  return { payload, status: response.status, elapsedMs, requestId: responseRequestId };
}

function csrfHeaders(runtime) {
  const csrf = runtime.jar.value(CSRF_COOKIE_NAME);
  if (!csrf) gateFailure("CSRF_COOKIE_MISSING", "The controlled session did not receive its CSRF cookie.");
  return { "x-csrf-token": csrf };
}

async function command(runtime, action, payload) {
  return requestJson(runtime, "/api/knowhow", {
    method: "POST",
    origin: runtime.configuration.siteOrigin,
    headers: {
      ...csrfHeaders(runtime),
      "x-idempotency-key": `load-${runtime.runId}-${randomUUID()}`,
    },
    body: { action, payload },
  });
}

async function authenticate(runtime) {
  const signIn = await requestJson(runtime, "/api/auth/sign-in", {
    method: "POST",
    origin: runtime.configuration.siteOrigin,
    body: { email: runtime.actor.email, password: runtime.actor.password },
  });
  runtime.signedIn = true;
  assert.equal(
    signIn.payload.mfaRequired,
    true,
    "Every controlled-load actor must require a fresh MFA challenge.",
  );
  assert.ok(
    Array.isArray(signIn.payload.factors) &&
      signIn.payload.factors.includes("totp"),
    "Every controlled-load actor must have a TOTP factor.",
  );
  const challenge = await requestJson(runtime, "/api/auth/mfa/challenge", {
    method: "POST",
    origin: runtime.configuration.siteOrigin,
    headers: csrfHeaders(runtime),
    body: { factor: "totp" },
  });
  assert.match(String(challenge.payload.challengeId ?? ""), /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  await requestJson(runtime, "/api/auth/mfa/complete", {
    method: "POST",
    origin: runtime.configuration.siteOrigin,
    headers: csrfHeaders(runtime),
    body: {
      challengeId: challenge.payload.challengeId,
      otp: await totpCode(runtime.actor.totpSecret),
    },
  });
  const session = await requestJson(runtime, "/api/auth/session");
  assert.equal(session.payload.user?.email, runtime.actor.email, "The controlled session resolved to another synthetic actor.");
  assert.equal(session.payload.user?.emailVerification, true, "A controlled load actor is not email verified.");
  assert.equal(session.payload.user?.mfa, true, "A controlled load actor does not have MFA enabled.");
  const bootstrap = await requestJson(
    runtime,
    `/api/knowhow?${new URLSearchParams({ workspaceId: runtime.actor.workspaceId })}`,
  );
  assert.equal(bootstrap.payload.activeWorkspace?.workspace?.id, runtime.actor.workspaceId, "The controlled actor did not resolve its exact workspace.");
  runtime.observedMemberCount = Number(bootstrap.payload.activeWorkspace?.workspace?.memberCount);
  assert.ok(
    Number.isSafeInteger(runtime.observedMemberCount) &&
      runtime.observedMemberCount >= runtime.configuration.minimumMembers,
    `The controlled workspace has fewer than ${runtime.configuration.minimumMembers} synthetic members.`,
  );
}

function validateSearchPayload(runtime, payload) {
  assert.ok(Array.isArray(payload.results), "The controlled search response has no result array.");
  const ids = payload.results.map((result) => String(result.guideId ?? ""));
  assert.ok(ids.includes(runtime.actor.expectedGuideId), "The controlled search sentinel was not visible in its own tenant.");
  const forbidden = new Set(
    runtime.configuration.actors
      .filter((actor) => actor.workspaceId !== runtime.actor.workspaceId)
      .map((actor) => actor.expectedGuideId),
  );
  assert.ok(ids.every((id) => !forbidden.has(id)), "A controlled search returned another tenant's sentinel guide.");
}

async function verifyTenantIsolation(runtimes) {
  for (const runtime of runtimes) {
    const own = await requestJson(
      runtime,
      `/api/knowhow/search?${new URLSearchParams({
        workspaceId: runtime.actor.workspaceId,
        q: runtime.actor.searchQuery,
      })}`,
    );
    validateSearchPayload(runtime, own.payload);
    for (const other of runtimes) {
      if (other === runtime) continue;
      await requestJson(
        runtime,
        `/api/knowhow/search?${new URLSearchParams({
          workspaceId: other.actor.workspaceId,
          q: runtime.actor.searchQuery,
        })}`,
        { expectedStatuses: [403, 404] },
      );
    }
  }
}

async function pairExtension(runtime) {
  const pairing = await command(runtime, "createPairingCode", {
    workspaceId: runtime.actor.workspaceId,
  });
  runtime.pairingCreated = true;
  assert.match(String(pairing.payload.code ?? ""), /^[A-HJ-NP-Z2-9]{12,20}$/);
  const paired = await requestJson(runtime, "/api/extension/pair", {
    method: "POST",
    origin: runtime.configuration.extensionOrigin,
    useCookies: false,
    body: {
      code: pairing.payload.code,
      deviceId: `load-${runtime.runId}-${runtime.actor.label}`,
      extensionVersion: runtime.configuration.extensionVersion,
    },
  });
  assert.equal(paired.payload.workspaceId, runtime.actor.workspaceId, "The paired extension token resolved to another workspace.");
  assert.match(String(paired.payload.accessToken ?? ""), /^[A-Za-z0-9._~-]{20,8192}$/);
  runtime.accessToken = paired.payload.accessToken;
  runtime.paired = true;
  const context = await requestJson(runtime, "/api/extension/context", {
    origin: runtime.configuration.extensionOrigin,
    authorization: runtime.accessToken,
    useCookies: false,
  });
  assert.equal(context.payload.workspaceId, runtime.actor.workspaceId, "The extension context resolved to another workspace.");
  assert.match(String(context.payload.policyVersion ?? ""), /^[A-Za-z0-9._-]{1,100}$/);
  runtime.policyVersion = context.payload.policyVersion;
}

async function measuredSearch(runtime) {
  try {
    const response = await requestJson(
      runtime,
      `/api/knowhow/search?${new URLSearchParams({
        workspaceId: runtime.actor.workspaceId,
        q: runtime.actor.searchQuery,
      })}`,
    );
    validateSearchPayload(runtime, response.payload);
    return { ok: true, elapsedMs: response.elapsedMs };
  } catch (error) {
    return { ok: false, error };
  }
}

async function measuredCapture(runtime, captureIndex) {
  const sessionId = `load_${runtime.runId}_${runtime.actor.label}_${String(captureIndex).padStart(2, "0")}`;
  const stepId = `step_${runtime.runId}_${runtime.actor.label}_${String(captureIndex).padStart(2, "0")}`;
  let captureId;
  let discarded = false;
  const startBody = {
    sessionId,
    title: `Synthetic load capture ${runtime.runId}-${runtime.actor.label}-${captureIndex}`,
    workspaceId: runtime.actor.workspaceId,
    policyVersion: runtime.policyVersion,
    sanitizedUrl: "https://synthetic.invalid/network-load",
    stepCount: 1,
  };
  const started = performance.now();
  try {
    const created = await requestJson(runtime, "/api/extension/captures", {
      method: "POST",
      origin: runtime.configuration.extensionOrigin,
      authorization: runtime.accessToken,
      useCookies: false,
      headers: { "idempotency-key": sessionId },
      body: startBody,
    });
    captureId = String(created.payload.captureId ?? "");
    assert.match(captureId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/);
    await requestJson(
      runtime,
      `/api/extension/captures/${encodeURIComponent(captureId)}/steps/${encodeURIComponent(stepId)}/screenshot`,
      {
        method: "PUT",
        origin: runtime.configuration.extensionOrigin,
        authorization: runtime.accessToken,
        useCookies: false,
        contentType: "image/png",
        headers: {
          "idempotency-key": `${sessionId}:${stepId}`,
          "x-knowhow-redacted": "true",
          "x-knowhow-source-rasterized": "true",
          "x-knowhow-image-width": "1",
          "x-knowhow-image-height": "1",
          "x-knowhow-step-title": "Synthetic%20load%20step",
        },
        body: onePixelPng,
      },
    );
    const discard = await requestJson(runtime, `/api/extension/captures/${encodeURIComponent(captureId)}`, {
      method: "DELETE",
      origin: runtime.configuration.extensionOrigin,
      authorization: runtime.accessToken,
      useCookies: false,
    });
    assert.equal(discard.payload.status, "discarded");
    discarded = true;
    const replay = await requestJson(runtime, `/api/extension/captures/${encodeURIComponent(captureId)}`, {
      method: "DELETE",
      origin: runtime.configuration.extensionOrigin,
      authorization: runtime.accessToken,
      useCookies: false,
    });
    assert.equal(replay.payload.status, "discarded");
    return { ok: true, elapsedMs: performance.now() - started, captureId, cleanupVerified: true };
  } catch (error) {
    if (!captureId) {
      try {
        const recovered = await requestJson(runtime, "/api/extension/captures", {
          method: "POST",
          origin: runtime.configuration.extensionOrigin,
          authorization: runtime.accessToken,
          useCookies: false,
          headers: { "idempotency-key": sessionId },
          body: startBody,
        });
        captureId = String(recovered.payload.captureId ?? "");
        assert.match(captureId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/);
      } catch (cleanupError) {
        return { ok: false, error, cleanupError, cleanupVerified: false };
      }
    }
    if (captureId && !discarded) {
      try {
        await requestJson(runtime, `/api/extension/captures/${encodeURIComponent(captureId)}`, {
          method: "DELETE",
          origin: runtime.configuration.extensionOrigin,
          authorization: runtime.accessToken,
          useCookies: false,
        });
        discarded = true;
      } catch (cleanupError) {
        return { ok: false, error, cleanupError, captureId, cleanupVerified: false };
      }
    }
    return { ok: false, error, captureId, cleanupVerified: discarded };
  }
}

async function cleanupRuntime(runtime) {
  const failures = [];
  if (runtime.signedIn && (runtime.pairingCreated || runtime.paired)) {
    try {
      await command(runtime, "revokeCaptureDevices", {
        workspaceId: runtime.actor.workspaceId,
      });
      if (runtime.accessToken) {
        await requestJson(runtime, "/api/extension/context", {
          origin: runtime.configuration.extensionOrigin,
          authorization: runtime.accessToken,
          useCookies: false,
          expectedStatuses: [401, 403],
        });
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (runtime.signedIn) {
    try {
      const encodedSession = runtime.jar.value(
        `a_session_${runtime.configuration.expectedProjectId}`,
      );
      if (!encodedSession) {
        gateFailure(
          "SESSION_COOKIE_MISSING",
          "The controlled actor has no Appwrite session cookie to revoke.",
        );
      }
      let session;
      try {
        session = decodeURIComponent(encodedSession);
      } catch {
        gateFailure(
          "SESSION_COOKIE_INVALID",
          "The controlled Appwrite session cookie is invalid.",
        );
      }
      await requestJson(runtime, "/api/auth/sign-out", {
        method: "POST",
        origin: runtime.configuration.siteOrigin,
        headers: csrfHeaders(runtime),
        body: {},
      });
      await requestJson(runtime, "/api/auth/session", { expectedStatuses: [401] });
      const account = new Account(
        new Client()
          .setEndpoint(runtime.configuration.endpoint)
          .setProject(runtime.configuration.expectedProjectId)
          .setSession(session),
      );
      let serverSessionRevoked = false;
      try {
        await account.get();
      } catch (error) {
        if (error instanceof AppwriteException && Number(error.code) === 401) {
          serverSessionRevoked = true;
        } else {
          throw error;
        }
      }
      if (!serverSessionRevoked) {
        gateFailure(
          "SERVER_SESSION_NOT_REVOKED",
          "A controlled-load Appwrite server session remains valid after sign-out.",
        );
      }
      runtime.signedIn = false;
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      gateFailure("EVIDENCE_PATH_EXISTS", "Controlled-load evidence is immutable; choose a new output path.");
    }
    throw error;
  }
}

async function assertDeployment(runtime) {
  const readiness = await requestJson(runtime, "/api/health?ready=1", {
    useCookies: false,
  });
  assert.equal(readiness.payload.status, "ready", "The controlled Site did not report ready.");
  assert.deepEqual(readiness.payload.deployment, {
    environment: runtime.configuration.target,
    release: runtime.configuration.release,
    projectFingerprint: projectFingerprint(runtime.configuration.expectedProjectId),
  });
}

async function run() {
  const configuration = controlledNetworkLoadConfiguration();
  const evidence = evidenceKey();
  const outputPath = privateEvidencePath(process.env.KNOWHOW_NETWORK_LOAD_EVIDENCE_PATH);
  const runId = randomUUID().replaceAll("-", "").slice(0, 10);
  const startedAt = new Date().toISOString();
  const runtimes = configuration.actors.map((actor) => runtimeFor(actor, configuration, runId));
  let primaryError;
  let searchResults = [];
  let captureResults = [];
  try {
    await assertDeployment(runtimes[0]);
    const authentication = await Promise.allSettled(runtimes.map((runtime) => authenticate(runtime)));
    const authenticationFailure = authentication.find((result) => result.status === "rejected");
    if (authenticationFailure) throw authenticationFailure.reason;
    await verifyTenantIsolation(runtimes);
    const pairing = await Promise.allSettled(runtimes.map((runtime) => pairExtension(runtime)));
    const pairingFailure = pairing.find((result) => result.status === "rejected");
    if (pairingFailure) throw pairingFailure.reason;
    searchResults = await Promise.all(
      runtimes.flatMap((runtime) =>
        Array.from({ length: configuration.readersPerTenant }, () => measuredSearch(runtime)),
      ),
    );
    captureResults = await Promise.all(
      runtimes.flatMap((runtime) =>
        Array.from({ length: configuration.capturesPerTenant }, (_, index) => measuredCapture(runtime, index)),
      ),
    );
    const searchFailures = searchResults.filter((result) => !result.ok);
    const captureFailures = captureResults.filter((result) => !result.ok);
    if (searchFailures.length || captureFailures.length) {
      gateFailure(
        "LOAD_OPERATIONS_FAILED",
        `Controlled load recorded ${searchFailures.length} search and ${captureFailures.length} capture pipeline failures.`,
      );
    }
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanup = await Promise.all(runtimes.map((runtime) => cleanupRuntime(runtime)));
    const cleanupFailures = cleanup.flat();
    const captureCleanupFailures = captureResults.filter((result) => !result.cleanupVerified);
    if (cleanupFailures.length || captureCleanupFailures.length) {
      primaryError = new ControlledNetworkLoadError(
        "LOAD_CLEANUP_FAILED",
        `Controlled load could not revoke or discard ${cleanupFailures.length + captureCleanupFailures.length} synthetic resources.`,
      );
    }
  }
  if (primaryError) throw primaryError;
  const searchSamples = searchResults.map((result) => result.elapsedMs);
  const captureSamples = captureResults.map((result) => result.elapsedMs);
  const search = latencySummary(searchSamples, searchResults.length, 0);
  const capture = latencySummary(captureSamples, captureResults.length, 0);
  assert.ok(search.p95Ms <= configuration.searchP95BudgetMs, `Controlled search p95 ${search.p95Ms}ms exceeded ${configuration.searchP95BudgetMs}ms.`);
  assert.ok(capture.p95Ms <= configuration.captureP95BudgetMs, `Controlled capture p95 ${capture.p95Ms}ms exceeded ${configuration.captureP95BudgetMs}ms.`);
  const requestIds = runtimes.flatMap((runtime) => runtime.requestIds);
  const payload = {
    evidenceVersion: 1,
    kind: "knowhow-controlled-network-load-evidence",
    status: "passed",
    generatedAt: new Date().toISOString(),
    startedAt,
    durationMs: Date.now() - Date.parse(startedAt),
    environment: configuration.target,
    release: configuration.release,
    siteOrigin: configuration.siteOrigin,
    projectFingerprint: projectFingerprint(configuration.expectedProjectId),
    boundary: {
      tenantActors: runtimes.length,
      minimumMembersPerTenant: configuration.minimumMembers,
      virtualReadersPerTenant: configuration.readersPerTenant,
      captureUploadPipelinesPerTenant: configuration.capturesPerTenant,
      extensionVersion: configuration.extensionVersion,
      searchP95BudgetMs: configuration.searchP95BudgetMs,
      captureP95BudgetMs: configuration.captureP95BudgetMs,
    },
    tenants: runtimes.map((runtime) =>
      contentFreeActor(runtime.actor, evidence.key, runtime.observedMemberCount),
    ),
    measurements: {
      authorizedSearch: search,
      redactedCaptureUploadDiscard: capture,
    },
    correlation: {
      responseCount: requestIds.length,
      requestIdsSha256: requestIdDigest(requestIds),
    },
    cleanup: {
      capturePipelinesDiscarded: captureResults.length,
      dedicatedExtensionActorsRevoked: runtimes.length,
      serverSessionsRevoked: runtimes.length,
      retainedSyntheticRows: "discarded/quarantined rows remain inside the dedicated synthetic tenants until the approved environment cleanup or final Production purge",
    },
    assertions: [
      "exact environment, project fingerprint, and release readiness matched",
      "every actor resolved only its configured workspace and synthetic member boundary",
      "cross-tenant workspace probes returned only 403 or 404",
      "every own-tenant search contained its sentinel and no other tenant sentinel",
      "every redacted screenshot upload was discarded idempotently",
      "all dedicated extension credentials and server sessions were revoked",
      "all response correlation IDs were preserved and measurement budgets passed",
    ],
    externalObservationsRequired: [
      "Appwrite Function execution failures and queue depth",
      "Appwrite database and Storage latency/error graphs",
      "Sentry error/regression dashboard for the exact load window",
    ],
  };
  const sealed = sealNetworkLoadEvidence(payload, evidence.key, evidence.keyId);
  await writeEvidence(outputPath, sealed);
  return {
    status: "passed",
    environment: payload.environment,
    release: payload.release,
    projectFingerprint: payload.projectFingerprint,
    boundary: payload.boundary,
    measurements: payload.measurements,
    cleanup: payload.cleanup,
    correlation: payload.correlation,
    evidencePath: outputPath,
    evidenceKeyId: evidence.keyId,
  };
}

function requiredVerifyValue(name) {
  const candidate = process.env[name]?.trim();
  if (!candidate) gateFailure("CONFIGURATION_REQUIRED", `${name} is required to verify controlled-load evidence.`);
  return candidate;
}

async function verifySavedEvidence() {
  const outputPath = privateEvidencePath(process.env.KNOWHOW_NETWORK_LOAD_EVIDENCE_PATH);
  const evidence = evidenceKey();
  let saved;
  try {
    saved = JSON.parse(await readFile(outputPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") gateFailure("EVIDENCE_FILE_NOT_FOUND", "The controlled-load evidence file was not found.");
    gateFailure("EVIDENCE_FILE_INVALID", "The controlled-load evidence file is not valid JSON.");
  }
  const payload = verifyNetworkLoadEvidence(saved, evidence.key, evidence.keyId);
  const expectedEnvironment = requiredVerifyValue("KNOWHOW_NETWORK_LOAD_ENVIRONMENT");
  const expectedRelease = requiredVerifyValue("KNOWHOW_NETWORK_LOAD_EXPECTED_RELEASE");
  const expectedProjectId = requiredVerifyValue("KNOWHOW_NETWORK_LOAD_EXPECTED_PROJECT_ID");
  assert.equal(payload.environment, expectedEnvironment, "Saved load evidence belongs to another environment.");
  assert.equal(payload.release, expectedRelease, "Saved load evidence belongs to another release.");
  assert.equal(payload.projectFingerprint, projectFingerprint(expectedProjectId), "Saved load evidence belongs to another Appwrite project.");
  return {
    status: "passed",
    environment: payload.environment,
    release: payload.release,
    projectFingerprint: payload.projectFingerprint,
    measurements: payload.measurements,
    correlation: payload.correlation,
    evidencePath: outputPath,
    evidenceKeyId: evidence.keyId,
  };
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry && entry === fileURLToPath(import.meta.url)) {
  const operation = process.argv[2] === "verify"
    ? verifySavedEvidence()
    : process.argv[2] === undefined || process.argv[2] === "capture"
      ? run()
      : Promise.reject(
          new ControlledNetworkLoadError(
            "COMMAND_INVALID",
            "Use `capture` (or no argument) for the live load gate, or `verify` for saved evidence.",
          ),
        );
  operation
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
      process.exitCode = 1;
    });
}
