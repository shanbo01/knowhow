import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { signOutSession } from "./auth-client";

type OriginalFetch = typeof globalThis.fetch;

let originalFetch: OriginalFetch;
let originalDocument: typeof globalThis.document;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalDocument = globalThis.document;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDocument !== undefined) {
    globalThis.document = originalDocument;
  } else {
    delete (globalThis as unknown as Record<string, unknown>).document;
  }
});

test("signOutSession makes a POST request to /api/auth/sign-out with empty JSON body", async () => {
  let calledUrl: string | URL | Request = "";
  let calledInit: RequestInit | undefined;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calledUrl = url;
    calledInit = init;
    return new Response(JSON.stringify({ resumed: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as OriginalFetch;

  delete (globalThis as unknown as Record<string, unknown>).document;

  const result = await signOutSession();

  assert.equal(calledUrl, "/api/auth/sign-out");
  assert.equal(calledInit?.method, "POST");
  assert.equal(calledInit?.body, "{}");
  assert.equal(calledInit?.credentials, "same-origin");
  assert.deepEqual(calledInit?.headers, {
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.deepEqual(result, { resumed: true });
});

test("signOutSession includes x-csrf-token header when document cookie contains knowhow_csrf", async () => {
  let calledHeaders: Record<string, string> = {};

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calledHeaders = (init?.headers as Record<string, string>) ?? {};
    return new Response(JSON.stringify({}), { status: 200 });
  }) as OriginalFetch;

  (globalThis as unknown as Record<string, unknown>).document = {
    cookie: "other_cookie=123; knowhow_csrf=test-csrf-token%21; foo=bar",
  };

  await signOutSession();

  assert.equal(calledHeaders["x-csrf-token"], "test-csrf-token!");
});

test("signOutSession throws server error message when response is not ok", async () => {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: "Session expired or invalid" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }) as OriginalFetch;

  await assert.rejects(
    async () => {
      await signOutSession();
    },
    {
      name: "Error",
      message: "Session expired or invalid",
    },
  );
});

test("signOutSession throws fallback error message when response is not ok and body has no error property", async () => {
  globalThis.fetch = (async () => {
    return new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
  }) as OriginalFetch;

  await assert.rejects(
    async () => {
      await signOutSession();
    },
    {
      name: "Error",
      message: "Authentication failed (500).",
    },
  );
});
