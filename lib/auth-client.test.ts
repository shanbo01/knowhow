import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import {
  authHealth,
  getAuthSession,
  signInWithPassword,
  signUp,
  signOutSession,
  sendEmailVerification,
  completeEmailVerification,
  requestPasswordRecovery,
  completePasswordRecovery,
  updateAccountPassword,
  updateAccountName,
  revokeOtherSessions,
  beginMfaChallenge,
  completeMfaChallenge,
  beginMfaEnrollment,
  completeMfaEnrollment,
  disableMfa,
} from "./auth-client";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  if (typeof globalThis.document !== "undefined") {
    delete (globalThis as unknown as { document?: unknown }).document;
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (typeof globalThis.document !== "undefined") {
    delete (globalThis as unknown as { document?: unknown }).document;
  }
});

test("authHealth succeeds when response is ok", async () => {
  let calledUrl = "";
  globalThis.fetch = async (input) => {
    calledUrl = String(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await authHealth();
  assert.equal(calledUrl, "/api/auth/health");
});

test("authRequest handles non-ok response with JSON error body", async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({ error: "Invalid credentials provided." }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  };

  await assert.rejects(
    async () => {
      await signInWithPassword("user@example.com", "wrongpassword");
    },
    {
      name: "Error",
      message: "Invalid credentials provided.",
    },
  );
});

test("authRequest handles non-ok response where response.json() throws/rejects (catch block fallback)", async () => {
  globalThis.fetch = async () => {
    // 500 status returning HTML / invalid JSON
    return new Response("500 Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/html" },
    });
  };

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

test("authRequest handles ok response where response.json() throws/rejects", async () => {
  globalThis.fetch = async () => {
    // 200 status with invalid JSON body
    return new Response("Not valid JSON", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };

  const result = await authHealth();
  // catch block converts rejection to {}, returning empty AuthResponse
  assert.deepEqual(result, undefined);
});

test("authRequest includes CSRF token and content-type headers", async () => {
  let capturedHeaders: Headers | undefined;
  let capturedBody: string | undefined;

  (globalThis as unknown as { document: unknown }).document = {
    cookie: "other_cookie=1; knowhow_csrf=csrf-token-12345; bar=baz",
  };

  globalThis.fetch = async (input, init) => {
    capturedHeaders = new Headers(init?.headers);
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ user: { id: "usr_123" } }), {
      status: 200,
    });
  };

  await signUp({
    name: "Alice",
    email: "alice@example.com",
    password: "Password123!",
  });

  assert.equal(capturedHeaders?.get("x-csrf-token"), "csrf-token-12345");
  assert.equal(capturedHeaders?.get("content-type"), "application/json");
  assert.equal(capturedHeaders?.get("accept"), "application/json");
  assert.equal(
    capturedBody,
    JSON.stringify({
      name: "Alice",
      email: "alice@example.com",
      password: "Password123!",
    }),
  );
});

test("getAuthSession returns null when response status is 401", async () => {
  globalThis.fetch = async () => {
    return new Response(null, { status: 401 });
  };

  const session = await getAuthSession();
  assert.equal(session, null);
});

test("getAuthSession returns user on successful response", async () => {
  const mockUser = {
    id: "usr_99",
    email: "test@example.com",
    name: "Test User",
    emailVerification: true,
    mfa: false,
  };

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ user: mockUser }), { status: 200 });
  };

  const user = await getAuthSession();
  assert.deepEqual(user, mockUser);
});

test("getAuthSession handles non-ok response with JSON error body", async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({ error: "Session validation failed." }),
      { status: 500 },
    );
  };

  await assert.rejects(
    async () => {
      await getAuthSession();
    },
    {
      name: "Error",
      message: "Session validation failed.",
    },
  );
});

test("getAuthSession handles non-ok response where response.json() throws/rejects", async () => {
  globalThis.fetch = async () => {
    return new Response("Bad Gateway", { status: 502 });
  };

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

test("auth-client helper functions format endpoints and bodies correctly", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body as string,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  await signOutSession();
  await sendEmailVerification("https://example.com/verify");
  await completeEmailVerification("usr_1", "secret_1");
  await requestPasswordRecovery("test@example.com", "https://example.com/reset");
  await completePasswordRecovery("usr_1", "secret_1", "newpass123");
  await updateAccountPassword("oldpass123", "newpass123");
  await updateAccountName("New Name");
  await revokeOtherSessions();
  await beginMfaChallenge("totp");
  await completeMfaChallenge("chal_123", "123456");
  await beginMfaEnrollment();
  await completeMfaEnrollment("654321");
  await disableMfa();

  assert.deepEqual(calls, [
    { url: "/api/auth/sign-out", method: "POST", body: "{}" },
    {
      url: "/api/auth/verification",
      method: "POST",
      body: JSON.stringify({ url: "https://example.com/verify" }),
    },
    {
      url: "/api/auth/verification/complete",
      method: "POST",
      body: JSON.stringify({ userId: "usr_1", secret: "secret_1" }),
    },
    {
      url: "/api/auth/recovery",
      method: "POST",
      body: JSON.stringify({
        email: "test@example.com",
        url: "https://example.com/reset",
      }),
    },
    {
      url: "/api/auth/recovery/complete",
      method: "POST",
      body: JSON.stringify({
        userId: "usr_1",
        secret: "secret_1",
        password: "newpass123",
      }),
    },
    {
      url: "/api/auth/password",
      method: "POST",
      body: JSON.stringify({
        currentPassword: "oldpass123",
        password: "newpass123",
      }),
    },
    {
      url: "/api/auth/profile",
      method: "POST",
      body: JSON.stringify({ name: "New Name" }),
    },
    {
      url: "/api/auth/sessions/revoke-others",
      method: "POST",
      body: "{}",
    },
    {
      url: "/api/auth/mfa/challenge",
      method: "POST",
      body: JSON.stringify({ factor: "totp" }),
    },
    {
      url: "/api/auth/mfa/complete",
      method: "POST",
      body: JSON.stringify({ challengeId: "chal_123", otp: "123456" }),
    },
    {
      url: "/api/auth/mfa/enroll/start",
      method: "POST",
      body: "{}",
    },
    {
      url: "/api/auth/mfa/enroll/complete",
      method: "POST",
      body: JSON.stringify({ otp: "654321" }),
    },
    {
      url: "/api/auth/mfa/disable",
      method: "POST",
      body: "{}",
    },
  ]);
});
