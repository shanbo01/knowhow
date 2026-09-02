import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  authHealth,
  beginMfaChallenge,
  beginMfaEnrollment,
  completeEmailVerification,
  completeMfaChallenge,
  completeMfaEnrollment,
  completePasswordRecovery,
  disableMfa,
  getAuthSession,
  regenerateMfaRecoveryCodes,
  requestPasswordRecovery,
  revokeOtherSessions,
  sendEmailVerification,
  signInWithPassword,
  signOutSession,
  signUp,
  updateAccountName,
  updateAccountPassword,
} from "./auth-client";

let originalFetch: typeof globalThis.fetch;
let originalDocument: typeof globalThis.document;

type FetchCall = {
  url: string | URL | Request;
  init?: RequestInit;
};

let fetchCalls: FetchCall[] = [];
let mockResponse: {
  ok: boolean;
  status: number;
  body: unknown;
};
// Set when a test needs response.json() itself to reject, which is the path
// auth-client guards with `.catch(() => ({}))`.
let jsonThrows = false;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalDocument = globalThis.document;
  fetchCalls = [];
  jsonThrows = false;
  mockResponse = {
    ok: true,
    status: 200,
    body: {
      user: {
        id: "user_1",
        email: "test@example.com",
        name: "Test User",
        emailVerification: true,
        mfa: false,
      },
    },
  };

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    return {
      ok: mockResponse.ok,
      status: mockResponse.status,
      json: async () => {
        if (jsonThrows) throw new SyntaxError("Unexpected end of JSON input");
        return mockResponse.body;
      },
    } as Response;
  }) as typeof globalThis.fetch;

  (globalThis as unknown as { document?: unknown }).document = {
    cookie: "knowhow_csrf=mock-csrf-token-123",
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as unknown as { document?: unknown }).document = originalDocument;
});

test("sendEmailVerification sends POST request with verification URL and headers", async () => {
  mockResponse = {
    ok: true,
    status: 200,
    body: { resumed: true },
  };

  const verificationUrl = "https://example.com/verify?token=abc";
  const result = await sendEmailVerification(verificationUrl);

  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url, "/api/auth/verification");
  assert.equal(call.init?.method, "POST");
  assert.equal(call.init?.credentials, "same-origin");

  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers["accept"], "application/json");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-csrf-token"], "mock-csrf-token-123");

  assert.deepEqual(JSON.parse(call.init?.body as string), {
    url: verificationUrl,
  });

  assert.deepEqual(result, { resumed: true });
});

test("sendEmailVerification handles error responses", async () => {
  mockResponse = {
    ok: false,
    status: 400,
    body: { error: "Invalid verification link" },
  };

  await assert.rejects(
    async () => {
      await sendEmailVerification("https://example.com/verify?token=invalid");
    },
    (err: Error) => {
      assert.equal(err.message, "Invalid verification link");
      return true;
    },
  );
});

test("sendEmailVerification uses default error message if error field is missing", async () => {
  mockResponse = {
    ok: false,
    status: 500,
    body: {},
  };

  await assert.rejects(
    async () => {
      await sendEmailVerification("https://example.com/verify");
    },
    (err: Error) => {
      assert.equal(err.message, "Authentication failed (500).");
      return true;
    },
  );
});

test("sendEmailVerification works without CSRF token cookie", async () => {
  (globalThis as unknown as { document?: unknown }).document = {
    cookie: "some_other_cookie=value",
  };
  mockResponse = { ok: true, status: 200, body: {} };

  await sendEmailVerification("https://example.com/verify");

  const headers = fetchCalls[0].init?.headers as Record<string, string>;
  assert.equal(headers["x-csrf-token"], undefined);
});

test("completeEmailVerification posts userId and secret", async () => {
  mockResponse = {
    ok: true,
    status: 200,
    body: { user: { id: "u123", email: "user@example.com" } },
  };

  const res = await completeEmailVerification("u123", "secret-key");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/api/auth/verification/complete");
  assert.deepEqual(JSON.parse(fetchCalls[0].init?.body as string), {
    userId: "u123",
    secret: "secret-key",
  });
  assert.equal(res.user?.id, "u123");
});

test("signInWithPassword and signUp invoke correct auth endpoints", async () => {
  await signInWithPassword("alice@example.com", "pass123");
  assert.equal(fetchCalls[0].url, "/api/auth/sign-in");
  assert.deepEqual(JSON.parse(fetchCalls[0].init?.body as string), {
    email: "alice@example.com",
    password: "pass123",
  });

  await signUp({ name: "Bob", email: "bob@example.com", password: "pass", acceptedTerms: true });
  assert.equal(fetchCalls[1].url, "/api/auth/sign-up");
  assert.deepEqual(JSON.parse(fetchCalls[1].init?.body as string), {
    name: "Bob",
    email: "bob@example.com",
    password: "pass",
    acceptedTerms: true,
  });
});

test("signOutSession sends POST to sign-out", async () => {
  await signOutSession();
  assert.equal(fetchCalls[0].url, "/api/auth/sign-out");
  assert.equal(fetchCalls[0].init?.method, "POST");
  assert.equal(fetchCalls[0].init?.body, "{}");
});

test("getAuthSession handles success and 401 unauthorized", async () => {
  const user = {
    id: "u1",
    email: "a@b.com",
    name: "A B",
    emailVerification: true,
    mfa: false,
  };
  mockResponse = { ok: true, status: 200, body: { user } };
  const res1 = await getAuthSession();
  assert.deepEqual(res1, user);

  mockResponse = { ok: false, status: 401, body: {} };
  const res2 = await getAuthSession();
  assert.equal(res2, null);
});

test("authHealth requests health endpoint", async () => {
  mockResponse = { ok: true, status: 200, body: {} };
  await authHealth();
  assert.equal(fetchCalls[0].url, "/api/auth/health");
});

test("password recovery and account update functions", async () => {
  mockResponse = { ok: true, status: 200, body: {} };

  await requestPasswordRecovery("test@ex.com", "https://ex.com/reset");
  assert.equal(fetchCalls[0].url, "/api/auth/recovery");
  assert.deepEqual(JSON.parse(fetchCalls[0].init?.body as string), {
    email: "test@ex.com",
    url: "https://ex.com/reset",
  });

  await completePasswordRecovery("uid1", "secret1", "newpass");
  assert.equal(fetchCalls[1].url, "/api/auth/recovery/complete");
  assert.deepEqual(JSON.parse(fetchCalls[1].init?.body as string), {
    userId: "uid1",
    secret: "secret1",
    password: "newpass",
  });

  await updateAccountPassword("oldpass", "newpass");
  assert.equal(fetchCalls[2].url, "/api/auth/password");

  await updateAccountName("New Name");
  assert.equal(fetchCalls[3].url, "/api/auth/profile");
  assert.deepEqual(JSON.parse(fetchCalls[3].init?.body as string), {
    name: "New Name",
  });

  await revokeOtherSessions();
  assert.equal(fetchCalls[4].url, "/api/auth/sessions/revoke-others");
});

test("MFA challenge, enrollment, and disable functions", async () => {
  mockResponse = { ok: true, status: 200, body: {} };

  await beginMfaChallenge("totp");
  assert.equal(fetchCalls[0].url, "/api/auth/mfa/challenge");

  await completeMfaChallenge("cid123", "123456");
  assert.equal(fetchCalls[1].url, "/api/auth/mfa/complete");

  await beginMfaEnrollment();
  assert.equal(fetchCalls[2].url, "/api/auth/mfa/enroll/start");

  await completeMfaEnrollment("654321");
  assert.equal(fetchCalls[3].url, "/api/auth/mfa/enroll/complete");

  await regenerateMfaRecoveryCodes();
  assert.equal(fetchCalls[4].url, "/api/auth/mfa/recovery/regenerate");

  await disableMfa();
  assert.equal(fetchCalls[5].url, "/api/auth/mfa/disable");
});

// --- authRequest error paths (from the auth-client-error-handling work) ---

test("authRequest falls back to the status message when json() rejects on a failure", async () => {
  mockResponse = { ok: false, status: 500, body: {} };
  jsonThrows = true;

  await assert.rejects(
    async () => await signOutSession(),
    (err: Error) => {
      assert.equal(err.message, "Authentication failed (500).");
      return true;
    },
  );
});

test("authRequest resolves to an empty body when json() rejects on success", async () => {
  mockResponse = { ok: true, status: 200, body: {} };
  jsonThrows = true;

  const result = await signOutSession();
  assert.deepEqual(result, {});
});

test("authRequest surfaces the server error message verbatim", async () => {
  mockResponse = { ok: false, status: 403, body: { error: "Session expired." } };

  await assert.rejects(
    async () => await signOutSession(),
    (err: Error) => {
      assert.equal(err.message, "Session expired.");
      return true;
    },
  );
});

test("authRequest omits the csrf header when document is undefined", async () => {
  delete (globalThis as unknown as { document?: unknown }).document;
  mockResponse = { ok: true, status: 200, body: {} };

  await authHealth();

  const headers = fetchCalls[0].init?.headers as Record<string, string>;
  assert.equal(headers["x-csrf-token"], undefined);
  assert.equal(headers["accept"], "application/json");
});

test("authRequest omits the content-type header when there is no body", async () => {
  mockResponse = { ok: true, status: 200, body: {} };

  await authHealth();

  const headers = fetchCalls[0].init?.headers as Record<string, string>;
  assert.equal(headers["content-type"], undefined);
});

// --- signUp specifics (from the signup coverage work) ---

test("signUp forwards the optional credentialKind and credential fields", async () => {
  mockResponse = { ok: true, status: 200, body: { user: { id: "u_9" } } };

  await signUp({
    name: "Carol",
    email: "carol@example.com",
    password: "pw",
    credentialKind: "invite",
    credential: "invite-token-1",
    acceptedTerms: true,
  });

  assert.deepEqual(JSON.parse(fetchCalls[0].init?.body as string), {
    name: "Carol",
    email: "carol@example.com",
    password: "pw",
    credentialKind: "invite",
    credential: "invite-token-1",
    acceptedTerms: true,
  });
});

test("signUp sends the csrf header when the cookie is present", async () => {
  mockResponse = { ok: true, status: 200, body: {} };

  await signUp({ name: "D", email: "d@example.com", password: "pw", acceptedTerms: true });

  const headers = fetchCalls[0].init?.headers as Record<string, string>;
  assert.equal(headers["x-csrf-token"], "mock-csrf-token-123");
});

// --- signOutSession specifics (from the signout coverage work) ---

test("signOutSession sends the csrf header when the cookie is present", async () => {
  mockResponse = { ok: true, status: 200, body: {} };

  await signOutSession();

  const headers = fetchCalls[0].init?.headers as Record<string, string>;
  assert.equal(headers["x-csrf-token"], "mock-csrf-token-123");
});

// --- authHealth specifics (from the auth-health work) ---

test("authHealth throws the server error message when the probe fails", async () => {
  mockResponse = { ok: false, status: 503, body: { error: "Auth backend down." } };

  await assert.rejects(
    async () => await authHealth(),
    (err: Error) => {
      assert.equal(err.message, "Auth backend down.");
      return true;
    },
  );
});

test("authHealth falls back to the status message when the body has no error", async () => {
  mockResponse = { ok: false, status: 503, body: {} };

  await assert.rejects(
    async () => await authHealth(),
    (err: Error) => {
      assert.equal(err.message, "Authentication failed (503).");
      return true;
    },
  );
});

// --- getAuthSession specifics (from the session coverage work) ---

test("getAuthSession requests the session endpoint without a csrf header", async () => {
  mockResponse = { ok: true, status: 200, body: { user: null } };

  await getAuthSession();

  assert.equal(fetchCalls[0].url, "/api/auth/session");
  const headers = fetchCalls[0].init?.headers as Record<string, string>;
  assert.equal(headers["accept"], "application/json");
  assert.equal(headers["x-csrf-token"], undefined);
});

test("getAuthSession returns null when an ok body carries no user", async () => {
  mockResponse = { ok: true, status: 200, body: {} };

  assert.equal(await getAuthSession(), null);
});

test("getAuthSession throws the server error message on a non-401 failure", async () => {
  mockResponse = { ok: false, status: 500, body: { error: "Directory offline." } };

  await assert.rejects(
    async () => await getAuthSession(),
    (err: Error) => {
      assert.equal(err.message, "Directory offline.");
      return true;
    },
  );
});

test("getAuthSession falls back to its own message when json() rejects", async () => {
  mockResponse = { ok: false, status: 500, body: {} };
  jsonThrows = true;

  await assert.rejects(
    async () => await getAuthSession(),
    (err: Error) => {
      assert.equal(err.message, "Identity verification failed.");
      return true;
    },
  );
});

test("getAuthSession returns null on 401 without reading the body", async () => {
  mockResponse = { ok: false, status: 401, body: {} };
  jsonThrows = true;

  assert.equal(await getAuthSession(), null);
});

// ---------------------------------------------------------------------------
// Terms acceptance
//
// The sign-up form had a Terms checkbox that only ever guarded the browser.
// Anything calling the endpoint directly created an account having agreed to
// nothing, and no record was kept of who agreed to what. These pin the client
// half: the flag has to reach the server for the server to be able to refuse.
// ---------------------------------------------------------------------------

test("signUp transmits terms acceptance", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ created: true, verificationSent: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await signUp({
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse",
      acceptedTerms: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/auth/sign-up");
    assert.equal(
      (calls[0].body as { acceptedTerms?: unknown }).acceptedTerms,
      true,
      "acceptance must reach the server, not stop at the checkbox",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signUp surfaces whether the verification email was sent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ created: true, verificationSent: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const result = await signUp({
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse",
      acceptedTerms: true,
    });
    // The caller needs this to decide between "check your inbox" and offering
    // a resend; sign-up no longer asks for the email in a second request.
    assert.equal(result.verificationSent, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
