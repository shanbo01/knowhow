import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { signUp } from "./auth-client.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { document?: unknown }).document;
});

test("signUp sends POST request with standard user input and returns AuthResponse", async () => {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calledUrl = String(input);
    calledInit = init;
    return new Response(
      JSON.stringify({
        user: {
          id: "usr_123",
          email: "jane@example.com",
          name: "Jane Doe",
          emailVerification: false,
          mfa: false,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const result = await signUp({
    name: "Jane Doe",
    email: "jane@example.com",
    password: "Password123!",
  });

  assert.equal(calledUrl, "/api/auth/sign-up");
  assert.equal(calledInit?.method, "POST");
  assert.equal(calledInit?.credentials, "same-origin");

  const headers = calledInit?.headers as Record<string, string>;
  assert.equal(headers["accept"], "application/json");
  assert.equal(headers["content-type"], "application/json");

  assert.equal(
    calledInit?.body,
    JSON.stringify({
      name: "Jane Doe",
      email: "jane@example.com",
      password: "Password123!",
    }),
  );

  assert.deepEqual(result, {
    user: {
      id: "usr_123",
      email: "jane@example.com",
      name: "Jane Doe",
      emailVerification: false,
      mfa: false,
    },
  });
});

test("signUp includes optional credentialKind and credential parameters", async () => {
  let calledInit: RequestInit | undefined;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calledInit = init;
    return new Response(
      JSON.stringify({ user: { id: "usr_456" } }),
      { status: 200 },
    );
  }) as typeof fetch;

  await signUp({
    name: "Bob",
    email: "bob@example.com",
    password: "Password123!",
    credentialKind: "invite",
    credential: "invite-code-789",
  });

  assert.equal(
    calledInit?.body,
    JSON.stringify({
      name: "Bob",
      email: "bob@example.com",
      password: "Password123!",
      credentialKind: "invite",
      credential: "invite-code-789",
    }),
  );
});

test("signUp includes x-csrf-token header when csrf cookie exists in document", async () => {
  let calledInit: RequestInit | undefined;

  (globalThis as unknown as { document: { cookie: string } }).document = {
    cookie: "other_cookie=abc; knowhow_csrf=csrf-secret-123; foo=bar",
  };

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calledInit = init;
    return new Response(
      JSON.stringify({ user: { id: "usr_789" } }),
      { status: 200 },
    );
  }) as typeof fetch;

  await signUp({
    name: "Alice",
    email: "alice@example.com",
    password: "Password123!",
  });

  const headers = calledInit?.headers as Record<string, string>;
  assert.equal(headers["x-csrf-token"], "csrf-secret-123");
});

test("signUp throws error message returned from API on failure", async () => {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ error: "Email address is already registered." }),
      { status: 400 },
    );
  }) as typeof fetch;

  await assert.rejects(
    signUp({
      name: "Jane Doe",
      email: "jane@example.com",
      password: "Password123!",
    }),
    {
      name: "Error",
      message: "Email address is already registered.",
    },
  );
});

test("signUp throws fallback error message when API returns non-OK response without explicit error message", async () => {
  globalThis.fetch = (async () => {
    return new Response("Internal Server Error", { status: 500 });
  }) as typeof fetch;

  await assert.rejects(
    signUp({
      name: "Jane Doe",
      email: "jane@example.com",
      password: "Password123!",
    }),
    {
      name: "Error",
      message: "Authentication failed (500).",
    },
  );
});
