import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { signInWithPassword } from "./auth-client";

describe("signInWithPassword", () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      // @ts-expect-error cleaning up document mock
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  });

  it("sends sign-in credentials to /api/auth/sign-in and returns user data", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const mockUser = {
      id: "usr_123",
      email: "user@example.com",
      name: "Test User",
      emailVerification: true,
      mfa: false,
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ user: mockUser }),
      } as unknown as Response;
    }) as typeof fetch;

    const result = await signInWithPassword("user@example.com", "password123");

    assert.equal(capturedUrl, "/api/auth/sign-in");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.credentials, "same-origin");

    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["accept"], "application/json");
    assert.equal(headers["content-type"], "application/json");

    assert.equal(
      capturedInit?.body,
      JSON.stringify({ email: "user@example.com", password: "password123" }),
    );

    assert.deepEqual(result, { user: mockUser });
  });

  it("handles MFA required response during sign in", async () => {
    const mfaResponseBody = {
      mfaRequired: true,
      factors: ["totp"],
      challengeId: "ch_98765",
    };

    globalThis.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => mfaResponseBody,
      } as unknown as Response;
    }) as typeof fetch;

    const result = await signInWithPassword("mfa-user@example.com", "password123");

    assert.deepEqual(result, mfaResponseBody);
  });

  it("includes x-csrf-token header when csrf cookie is present", async () => {
    let capturedInit: RequestInit | undefined;

    // Mock document.cookie
    // @ts-expect-error mocking document for node test
    globalThis.document = {
      cookie: "foo=bar; knowhow_csrf=csrf-secret-token-123; baz=qux",
    };

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ user: { id: "usr_123" } }),
      } as unknown as Response;
    }) as typeof fetch;

    await signInWithPassword("user@example.com", "password123");

    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["x-csrf-token"], "csrf-secret-token-123");
  });

  it("throws error with server error message when response is not ok", async () => {
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: "Invalid email or password." }),
      } as unknown as Response;
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await signInWithPassword("user@example.com", "wrong-password");
      },
      (err: Error) => {
        assert.equal(err.message, "Invalid email or password.");
        return true;
      },
    );
  });

  it("throws fallback error message when response is not ok and json body is non-json or missing error", async () => {
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("Invalid JSON");
        },
      } as unknown as Response;
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await signInWithPassword("user@example.com", "password123");
      },
      (err: Error) => {
        assert.equal(err.message, "Authentication failed (500).");
        return true;
      },
    );
  });
});
