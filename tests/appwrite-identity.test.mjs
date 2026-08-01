import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, afterEach, before } from "node:test";
import { build } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const originalFetch = globalThis.fetch;
let identity;
let outputDirectory;

before(async () => {
  outputDirectory = await mkdtemp(path.join(tmpdir(), "rivet-appwrite-identity-"));
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: {
      emptyOutDir: false,
      outDir: outputDirectory,
      target: "es2022",
      minify: false,
      lib: {
        entry: path.join(root, "tests", "helpers", "appwrite-identity-entry.ts"),
        formats: ["es"],
        fileName: () => "appwrite-identity.mjs",
      },
    },
  });
  identity = await import(
    `${pathToFileURL(path.join(outputDirectory, "appwrite-identity.mjs")).href}?test=${Date.now()}`
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(async () => {
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
});

function request() {
  return new Request("https://rivet.example/api/rivet", {
    headers: {
      authorization: "Bearer header.payload.signature",
      "user-agent": "Rivet test browser",
    },
  });
}

const config = {
  endpoint: "https://identity.example/v1",
  projectId: "rivet-project",
};

test("validates an Appwrite JWT using the native Fetch API", async () => {
  let outbound;
  globalThis.fetch = async (input, init) => {
    outbound = { input, init };
    return Response.json({
      $id: "user-1",
      email: " PERSON@Example.COM ",
      name: " Person ",
      emailVerification: true,
      labels: ["platform-administrator"],
    });
  };

  const result = await identity.authenticateAppwriteJwt(request(), config);

  assert.equal(outbound.input, "https://identity.example/v1/account");
  assert.equal(outbound.init.method, "GET");
  assert.equal(outbound.init.redirect, "manual");
  const headers = new Headers(outbound.init.headers);
  assert.equal(headers.get("x-appwrite-project"), "rivet-project");
  assert.equal(headers.get("x-appwrite-jwt"), "header.payload.signature");
  assert.equal(headers.get("x-forwarded-user-agent"), "Rivet test browser");
  assert.deepEqual(result, {
    userId: "user-1",
    email: "person@example.com",
    name: "Person",
    emailVerified: true,
    labels: ["platform-administrator"],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.labels), true);
});

for (const status of [401, 403]) {
  test(`maps Appwrite ${status} responses to an expired Rivet session`, async () => {
    globalThis.fetch = async () => new Response(null, { status });

    await assert.rejects(
      identity.authenticateAppwriteJwt(request(), config),
      (error) => error.status === 401 && error.code === "INVALID_APPWRITE_JWT",
    );
  });
}

test("maps Appwrite outages and invalid responses to service unavailable", async () => {
  globalThis.fetch = async () => new Response("upstream failure", { status: 502 });
  await assert.rejects(
    identity.authenticateAppwriteJwt(request(), config),
    (error) => error.status === 503 && error.code === "IDENTITY_PROVIDER_UNAVAILABLE",
  );

  globalThis.fetch = async () => Response.json({ $id: "incomplete" });
  await assert.rejects(
    identity.authenticateAppwriteJwt(request(), config),
    (error) => error.status === 503 && error.code === "IDENTITY_PROVIDER_UNAVAILABLE",
  );

  globalThis.fetch = async () => {
    throw new Error("network unavailable");
  };
  await assert.rejects(
    identity.authenticateAppwriteJwt(request(), config),
    (error) => error.status === 503 && error.code === "IDENTITY_PROVIDER_UNAVAILABLE",
  );
});

test("does not follow redirects that could expose the Appwrite JWT", async () => {
  globalThis.fetch = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://untrusted.example/collect" },
    });

  await assert.rejects(
    identity.authenticateAppwriteJwt(request(), config),
    (error) => error.status === 503 && error.code === "IDENTITY_PROVIDER_UNAVAILABLE",
  );
});

test("still requires Appwrite to report a verified email", async () => {
  globalThis.fetch = async () =>
    Response.json({
      $id: "user-1",
      email: "person@example.com",
      name: "Person",
      emailVerification: false,
      labels: [],
    });

  await assert.rejects(
    identity.requireVerifiedIdentity(request(), config),
    (error) => error.status === 403 && error.code === "EMAIL_NOT_VERIFIED",
  );
});
