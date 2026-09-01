import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { authHealth } from "./auth-client";

type FetchArgs = {
  url: string;
  init: RequestInit;
};

const originalFetch = globalThis.fetch;
const originalDocument = (globalThis as unknown as { document?: unknown }).document;

beforeEach(() => {
  // Reset document before each test
  delete (globalThis as unknown as { document?: unknown }).document;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDocument !== undefined) {
    (globalThis as unknown as { document?: unknown }).document = originalDocument;
  } else {
    delete (globalThis as unknown as { document?: unknown }).document;
  }
});

test("authHealth makes a GET request to /api/auth/health with standard headers", async () => {
  const calls: FetchArgs[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await authHealth();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/auth/health");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.deepEqual(calls[0].init.headers, {
    accept: "application/json",
  });
});

test("authHealth includes x-csrf-token header when knowhow_csrf cookie exists", async () => {
  const calls: FetchArgs[] = [];
  (globalThis as unknown as { document?: { cookie: string } }).document = {
    cookie: "other_cookie=123; knowhow_csrf=test-csrf-token%20123; session=abc",
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await authHealth();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].init.headers, {
    accept: "application/json",
    "x-csrf-token": "test-csrf-token 123",
  });
});

test("authHealth throws custom error message from body when response is not ok", async () => {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ error: "Service unavailable for maintenance." }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  await assert.rejects(
    async () => {
      await authHealth();
    },
    {
      name: "Error",
      message: "Service unavailable for maintenance.",
    },
  );
});

test("authHealth throws fallback error message when response is not ok and body lacks error property", async () => {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ details: "Internal server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await assert.rejects(
    async () => {
      await authHealth();
    },
    {
      name: "Error",
      message: "Authentication failed (500).",
    },
  );
});

test("authHealth throws fallback error message when response body is not valid JSON", async () => {
  globalThis.fetch = (async () => {
    return new Response("Bad Gateway", {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  await assert.rejects(
    async () => {
      await authHealth();
    },
    {
      name: "Error",
      message: "Authentication failed (502).",
    },
  );
});
