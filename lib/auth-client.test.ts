import assert from "node:assert/strict";
import test from "node:test";
import { authHealth } from "./auth-client";

test("authHealth tests", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;

  t.afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  });

  await t.test("successfully calls /api/auth/health with default options", async () => {
    let calledUrl: string | URL | Request = "";
    let calledInit: RequestInit | undefined;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = url;
      calledInit = init;
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await authHealth();

    assert.equal(calledUrl, "/api/auth/health");
    assert.equal(calledInit?.credentials, "same-origin");
    assert.deepEqual(calledInit?.headers, {
      accept: "application/json",
    });
  });

  await t.test("includes CSRF token header when knowhow_csrf cookie is present", async () => {
    let calledInit: RequestInit | undefined;

    globalThis.document = {
      cookie: "other_cookie=123; knowhow_csrf=test-csrf-token-123; foo=bar",
    } as unknown as Document;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calledInit = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await authHealth();

    assert.deepEqual(calledInit?.headers, {
      accept: "application/json",
      "x-csrf-token": "test-csrf-token-123",
    });
  });

  await t.test("throws error when response is not ok and JSON payload has error field", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: "Service Unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await authHealth();
      },
      {
        name: "Error",
        message: "Service Unavailable",
      },
    );
  });

  await t.test("throws fallback error when response is not ok and response body is non-JSON or missing error", async () => {
    globalThis.fetch = (async () => {
      return new Response("Internal Server Error", {
        status: 500,
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
});
