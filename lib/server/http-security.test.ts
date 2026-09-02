import assert from "node:assert/strict";
import test, { afterEach, describe, it } from "node:test";
import {
  HttpError,
  assertCsrfToken,
  assertTrustedOrigin,
  publicAppOrigin,
  readJsonObject,
  requireBearerToken,
  resolveExtensionOrigin,
} from "./http-security";

test("readJsonObject throws 415 JSON_REQUIRED when Content-Type is missing or not application/json", async () => {
  const req = new Request("https://example.com/api", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ hello: "world" }),
  });

  await assert.rejects(
    async () => {
      await readJsonObject(req);
    },
    (err: unknown) => {
      assert(err instanceof HttpError);
      assert.equal(err.status, 415);
      assert.equal(err.code, "JSON_REQUIRED");
      assert.equal(err.message, "Use an application/json request body.");
      return true;
    },
  );
});

test("readJsonObject throws 413 REQUEST_TOO_LARGE when Content-Length exceeds maxBytes", async () => {
  const req = new Request("https://example.com/api", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "100",
    },
    body: JSON.stringify({ a: 1 }),
  });

  await assert.rejects(
    async () => {
      await readJsonObject(req, 50);
    },
    (err: unknown) => {
      assert(err instanceof HttpError);
      assert.equal(err.status, 413);
      assert.equal(err.code, "REQUEST_TOO_LARGE");
      assert.equal(err.message, "The request body is too large.");
      return true;
    },
  );
});

test("readJsonObject throws 413 REQUEST_TOO_LARGE when raw body byteLength exceeds maxBytes", async () => {
  const req = new Request("https://example.com/api", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ large: "x".repeat(100) }),
  });

  await assert.rejects(
    async () => {
      await readJsonObject(req, 50);
    },
    (err: unknown) => {
      assert(err instanceof HttpError);
      assert.equal(err.status, 413);
      assert.equal(err.code, "REQUEST_TOO_LARGE");
      assert.equal(err.message, "The request body is too large.");
      return true;
    },
  );
});

test("readJsonObject throws 400 INVALID_JSON with cause when body is invalid JSON", async () => {
  const req = new Request("https://example.com/api", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: "{ malformed json: ",
  });

  await assert.rejects(
    async () => {
      await readJsonObject(req);
    },
    (err: unknown) => {
      assert(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "INVALID_JSON");
      assert.equal(err.message, "The request body is not valid JSON.");
      assert(err.cause instanceof SyntaxError);
      return true;
    },
  );
});

test("readJsonObject throws 400 JSON_OBJECT_REQUIRED when parsed JSON is not an object", async () => {
  for (const invalidBody of ["123", '"string"', "true", "null", "[1, 2, 3]"]) {
    const req = new Request("https://example.com/api", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: invalidBody,
    });

    await assert.rejects(
      async () => {
        await readJsonObject(req);
      },
      (err: unknown) => {
        assert(err instanceof HttpError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "JSON_OBJECT_REQUIRED");
        assert.equal(err.message, "The request body must be an object.");
        return true;
      },
    );
  }
});

test("readJsonObject successfully parses a valid JSON object", async () => {
  const req = new Request("https://example.com/api", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ key: "value", num: 42 }),
  });

  const result = await readJsonObject(req);
  assert.deepEqual(result, { key: "value", num: 42 });
});

// ---------------------------------------------------------------------------
// Request authentication
//
// These cover the guards the deployment actually leans on. The suite above
// tests readJsonObject; without what follows, neutering the CSRF comparison or
// dropping its length floor leaves every test passing.
// ---------------------------------------------------------------------------

function requestWith(
  headers: Record<string, string>,
  url = "https://knowhow.example.com/api/knowhow",
  method = "POST",
) {
  return new Request(url, { method, headers });
}

const VALID_CSRF = "a".repeat(48);

describe("assertCsrfToken", () => {
  it("accepts a cookie and header that match", () => {
    assert.doesNotThrow(() =>
      assertCsrfToken(
        requestWith({
          cookie: `knowhow_csrf=${VALID_CSRF}`,
          "x-csrf-token": VALID_CSRF,
        }),
      ),
    );
  });

  it("rejects a header that does not match the cookie", () => {
    // Same length, different value: this is the case a broken comparison
    // would wave through, and the only one that exercises it.
    assert.throws(
      () =>
        assertCsrfToken(
          requestWith({
            cookie: `knowhow_csrf=${VALID_CSRF}`,
            "x-csrf-token": "b".repeat(48),
          }),
        ),
      /could not be verified/,
    );
  });

  it("rejects a single flipped character", () => {
    assert.throws(
      () =>
        assertCsrfToken(
          requestWith({
            cookie: `knowhow_csrf=${VALID_CSRF}`,
            "x-csrf-token": `${"a".repeat(47)}b`,
          }),
        ),
      /could not be verified/,
    );
  });

  it("rejects a header carrying the right token plus extra", () => {
    // The comparison loop runs to the cookie's length, so without the length
    // equality check a header of token+suffix matches on every compared
    // character and is accepted. Only this shape exercises that.
    assert.throws(
      () =>
        assertCsrfToken(
          requestWith({
            cookie: `knowhow_csrf=${VALID_CSRF}`,
            "x-csrf-token": `${VALID_CSRF}extra`,
          }),
        ),
      /could not be verified/,
    );
  });

  it("rejects a header that is a prefix of the cookie", () => {
    assert.throws(
      () =>
        assertCsrfToken(
          requestWith({
            cookie: `knowhow_csrf=${VALID_CSRF}`,
            "x-csrf-token": VALID_CSRF.slice(0, 40),
          }),
        ),
      /could not be verified/,
    );
  });

  it("rejects a missing cookie", () => {
    assert.throws(
      () => assertCsrfToken(requestWith({ "x-csrf-token": VALID_CSRF })),
      /could not be verified/,
    );
  });

  it("rejects a missing header", () => {
    assert.throws(
      () => assertCsrfToken(requestWith({ cookie: `knowhow_csrf=${VALID_CSRF}` })),
      /could not be verified/,
    );
  });

  it("rejects a token below the length floor", () => {
    // A short token is guessable, so the floor is a real control rather than
    // input tidying.
    const short = "a".repeat(31);
    assert.throws(
      () =>
        assertCsrfToken(
          requestWith({ cookie: `knowhow_csrf=${short}`, "x-csrf-token": short }),
        ),
      /could not be verified/,
    );
  });

  it("rejects a token above the length ceiling", () => {
    const long = "a".repeat(257);
    assert.throws(
      () =>
        assertCsrfToken(
          requestWith({ cookie: `knowhow_csrf=${long}`, "x-csrf-token": long }),
        ),
      /could not be verified/,
    );
  });

  it("reads its cookie from among others", () => {
    assert.doesNotThrow(() =>
      assertCsrfToken(
        requestWith({
          cookie: `other=1; knowhow_csrf=${VALID_CSRF}; a_session_x=zzz`,
          "x-csrf-token": VALID_CSRF,
        }),
      ),
    );
  });
});

describe("assertTrustedOrigin", () => {
  it("accepts an origin matching the request's own", () => {
    assert.doesNotThrow(() =>
      assertTrustedOrigin(
        requestWith({ origin: "https://knowhow.example.com" }),
      ),
    );
  });

  it("accepts an explicitly allowlisted origin", () => {
    assert.doesNotThrow(() =>
      assertTrustedOrigin(requestWith({ origin: "https://other.example.com" }), [
        "https://other.example.com",
      ]),
    );
  });

  it("rejects an origin that is neither", () => {
    assert.throws(
      () => assertTrustedOrigin(requestWith({ origin: "https://evil.example" })),
      /origin is not allowed/,
    );
  });

  it("requires an origin at all", () => {
    assert.throws(
      () => assertTrustedOrigin(requestWith({})),
      /origin is required/,
    );
  });

  it("rejects a cross-site request even from an allowed origin", () => {
    assert.throws(
      () =>
        assertTrustedOrigin(
          requestWith({
            origin: "https://knowhow.example.com",
            "sec-fetch-site": "cross-site",
          }),
        ),
      /Cross-site/,
    );
  });

  it("allows same-site navigation", () => {
    assert.doesNotThrow(() =>
      assertTrustedOrigin(
        requestWith({
          origin: "https://knowhow.example.com",
          "sec-fetch-site": "same-origin",
        }),
      ),
    );
  });
});

describe("requireBearerToken", () => {
  it("returns the token from a well-formed header", () => {
    assert.equal(
      requireBearerToken(requestWith({ authorization: "Bearer abc.def-ghi~jkl" })),
      "abc.def-ghi~jkl",
    );
  });

  it("rejects a missing header", () => {
    assert.throws(() => requireBearerToken(requestWith({})), /Sign in/);
  });

  it("rejects a non-bearer scheme", () => {
    assert.throws(
      () => requireBearerToken(requestWith({ authorization: "Basic abc" })),
      /Sign in/,
    );
  });

  it("rejects an implausibly long token rather than hashing it", () => {
    assert.throws(
      () =>
        requireBearerToken(
          requestWith({ authorization: `Bearer ${"a".repeat(16385)}` }),
        ),
      /Sign in/,
    );
  });
});

describe("resolveExtensionOrigin", () => {
  const ALLOWED = "chrome-extension://phbofjenfnnnnndghhinoldlfbpaedpo";
  const OTHER = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

  const requestWith = (headers: Record<string, string>) =>
    new Request("https://knowhow.example.com/api/extension/pair", {
      method: "POST",
      headers,
    });

  it("allows a request the browser sent without an Origin", () => {
    // Chrome omits Origin for a service-worker fetch covered by
    // host_permissions, and the extension cannot add one. Rejecting this
    // rejects every real capture request.
    assert.equal(resolveExtensionOrigin(requestWith({}), [ALLOWED]), null);
  });

  it("still allows a missing Origin when no allowlist is configured", () => {
    assert.equal(resolveExtensionOrigin(requestWith({}), []), null);
  });

  it("accepts an allowlisted extension origin", () => {
    assert.equal(
      resolveExtensionOrigin(requestWith({ origin: ALLOWED }), [ALLOWED]),
      ALLOWED,
    );
  });

  it("rejects an extension origin that is not allowlisted", () => {
    assert.throws(
      () => resolveExtensionOrigin(requestWith({ origin: OTHER }), [ALLOWED]),
      (error: unknown) => {
        assert(error instanceof HttpError);
        assert.equal(error.status, 403);
        assert.equal(error.code, "EXTENSION_ORIGIN_DENIED");
        return true;
      },
    );
  });

  it("rejects a web page origin even when it is the deployment itself", () => {
    assert.throws(
      () =>
        resolveExtensionOrigin(
          requestWith({ origin: "https://knowhow.example.com" }),
          [ALLOWED],
        ),
      /not allowed/,
    );
  });

  it("accepts any well-formed extension origin in development only", () => {
    assert.equal(
      resolveExtensionOrigin(requestWith({ origin: OTHER }), [], {
        allowUnlistedInDevelopment: true,
      }),
      OTHER,
    );
  });

  it("does not let the development allowance override a configured allowlist", () => {
    assert.throws(
      () =>
        resolveExtensionOrigin(requestWith({ origin: OTHER }), [ALLOWED], {
          allowUnlistedInDevelopment: true,
        }),
      /not allowed/,
    );
  });

  it("rejects a malformed origin in development rather than trusting the shape", () => {
    assert.throws(
      () =>
        resolveExtensionOrigin(requestWith({ origin: "chrome-extension://x" }), [], {
          allowUnlistedInDevelopment: true,
        }),
      /not allowed/,
    );
  });
});

describe("publicAppOrigin", () => {
  const CONFIGURED = process.env.KNOWHOW_PUBLIC_APP_ORIGIN;
  afterEach(() => {
    if (CONFIGURED === undefined) delete process.env.KNOWHOW_PUBLIC_APP_ORIGIN;
    else process.env.KNOWHOW_PUBLIC_APP_ORIGIN = CONFIGURED;
  });

  // A standalone Next server behind a proxy reports its own bind address in
  // request.url, so this is what the request actually looks like in production.
  const internalRequest = (headers: Record<string, string> = {}) =>
    new Request("https://0.0.0.0:3000/api/extension/capture/finish", {
      method: "POST",
      headers,
    });

  it("prefers the configured origin over the address the server is bound to", () => {
    process.env.KNOWHOW_PUBLIC_APP_ORIGIN = "https://app.example.com";
    assert.equal(publicAppOrigin(internalRequest()), "https://app.example.com");
  });

  it("never returns the bind address when a proxy declared the public host", () => {
    delete process.env.KNOWHOW_PUBLIC_APP_ORIGIN;
    assert.equal(
      publicAppOrigin(
        internalRequest({
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
        }),
      ),
      "https://app.example.com",
    );
  });

  it("ignores a trailing path on the configured origin", () => {
    process.env.KNOWHOW_PUBLIC_APP_ORIGIN = "https://app.example.com/w/team";
    assert.equal(publicAppOrigin(internalRequest()), "https://app.example.com");
  });

  it("falls back to the request when the configured origin is unusable", () => {
    process.env.KNOWHOW_PUBLIC_APP_ORIGIN = "not-a-url";
    assert.equal(
      publicAppOrigin(
        internalRequest({
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
        }),
      ),
      "https://app.example.com",
    );
  });

  it("refuses a configured origin with a scheme a browser cannot open", () => {
    process.env.KNOWHOW_PUBLIC_APP_ORIGIN = "javascript:alert(1)";
    assert.equal(
      publicAppOrigin(
        internalRequest({
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
        }),
      ),
      "https://app.example.com",
    );
  });
});
