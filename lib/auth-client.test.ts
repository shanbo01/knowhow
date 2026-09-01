import assert from "node:assert/strict";
import test from "node:test";
import { getAuthSession, SessionUser } from "./auth-client";

test("getAuthSession", async (t) => {
  const originalFetch = globalThis.fetch;

  t.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test("returns user object and uses correct request parameters on active session", async () => {
    const mockUser: SessionUser = {
      id: "usr_123",
      email: "test@example.com",
      name: "Test User",
      emailVerification: true,
      mfa: false,
    };

    let fetchCalledWith: { url: string; init?: RequestInit } | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalledWith = { url: String(input), init };
      return new Response(JSON.stringify({ user: mockUser }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const user = await getAuthSession();

    assert.deepEqual(user, mockUser);
    assert.ok(fetchCalledWith);
    const called = fetchCalledWith as unknown as { url: string; init?: RequestInit };
    assert.equal(called.url, "/api/auth/session");
    assert.deepEqual(called.init, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
  });

  await t.test("returns null when status is 401 unauthenticated", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const user = await getAuthSession();
    assert.equal(user, null);
  });

  await t.test("returns null when status is 200 OK but user is missing", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const user = await getAuthSession();
    assert.equal(user, null);
  });

  await t.test("throws error with custom message on non-ok non-401 response", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ error: "Custom verification error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await getAuthSession();
      },
      {
        name: "Error",
        message: "Custom verification error",
      },
    );
  });

  await t.test("throws default error message on non-ok response with invalid/non-JSON body", async () => {
    globalThis.fetch = (async () => {
      return new Response("Internal Server Error Page", {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await getAuthSession();
      },
      {
        name: "Error",
        message: "Identity verification failed.",
      },
    );
  });
});
