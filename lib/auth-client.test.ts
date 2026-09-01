import assert from "node:assert/strict";
import test from "node:test";
import {
  getAuthSession,
  authHealth,
  signInWithPassword,
  signOutSession,
  type SessionUser,
} from "./auth-client";

test("getAuthSession returns null on 401 status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  try {
    const session = await getAuthSession();
    assert.equal(session, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getAuthSession handles non-ok response with json parsing error (catch fallback on line 65)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Internal Server Error (non-JSON)", {
      status: 500,
      headers: { "content-type": "text/html" },
    });

  try {
    await assert.rejects(
      async () => {
        await getAuthSession();
      },
      {
        name: "Error",
        message: "Identity verification failed.",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getAuthSession handles non-ok response with custom error message from json body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Session expired or invalid" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });

  try {
    await assert.rejects(
      async () => {
        await getAuthSession();
      },
      {
        name: "Error",
        message: "Session expired or invalid",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getAuthSession returns session user when response is ok", async () => {
  const mockUser: SessionUser = {
    id: "user-123",
    email: "test@example.com",
    name: "Test User",
    emailVerification: true,
    mfa: false,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/auth/session");
    assert.equal((init?.headers as Record<string, string>)?.accept, "application/json");
    return new Response(JSON.stringify({ user: mockUser }), { status: 200 });
  };

  try {
    const session = await getAuthSession();
    assert.deepEqual(session, mockUser);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getAuthSession returns null when ok response body has no user", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({}), { status: 200 });

  try {
    const session = await getAuthSession();
    assert.equal(session, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authRequest (via authHealth/signInWithPassword) handles json parsing error on non-ok status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Bad Gateway", {
      status: 502,
      headers: { "content-type": "text/html" },
    });

  try {
    await assert.rejects(
      async () => {
        await authHealth();
      },
      {
        name: "Error",
        message: "Authentication failed (502).",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authRequest handles custom error response body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Invalid password" }), {
      status: 400,
    });

  try {
    await assert.rejects(
      async () => {
        await signInWithPassword("test@example.com", "wrongpass");
      },
      {
        name: "Error",
        message: "Invalid password",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authRequest attaches csrf token header when document.cookie is set", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;

  // Mock document.cookie
  globalThis.document = {
    cookie: "foo=bar; knowhow_csrf=secret-csrf-token-123; baz=qux",
  } as unknown as Document;

  let requestHeaders: Record<string, string> = {};

  globalThis.fetch = async (_input, init) => {
    requestHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ resumed: true }), { status: 200 });
  };

  try {
    await signOutSession();
    assert.equal(requestHeaders["x-csrf-token"], "secret-csrf-token-123");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  }
});
