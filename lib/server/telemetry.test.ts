import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { recordHttpFailure, redactSecrets } from "./telemetry";

type Entry = {
  level: string;
  status: number;
  errorType: string;
  requestId?: string;
  error?: Array<{ type: string; message: string; stack?: string }>;
};

let errors: Entry[] = [];
let warnings: Entry[] = [];
const realError = console.error;
const realWarn = console.warn;

beforeEach(() => {
  errors = [];
  warnings = [];
  console.error = (line: string) => errors.push(JSON.parse(line) as Entry);
  console.warn = (line: string) => warnings.push(JSON.parse(line) as Entry);
});

afterEach(() => {
  console.error = realError;
  console.warn = realWarn;
});

describe("recordHttpFailure", () => {
  it("logs a stack for a server fault", () => {
    recordHttpFailure(new Error("database unreachable"), {
      status: 500,
      errorCode: "INTERNAL_ERROR",
      requestId: "req-1",
    });
    assert.equal(errors.length, 1);
    const [first] = errors[0].error ?? [];
    assert.equal(first.type, "Error");
    assert.equal(first.message, "database unreachable");
    assert.ok(first.stack?.includes("telemetry.test"), "stack should be present");
    assert.equal(errors[0].requestId, "req-1");
  });

  it("follows the cause chain, because the wrapper is never the reason", () => {
    const root = new Error("ECONNREFUSED 10.0.0.5:443");
    const wrapper = new Error("The request could not be completed.", {
      cause: root,
    });
    recordHttpFailure(wrapper, { status: 500, errorCode: "INTERNAL_ERROR" });
    const chain = errors[0].error ?? [];
    assert.equal(chain.length, 2);
    assert.equal(chain[1].message, "ECONNREFUSED 10.0.0.5:443");
  });

  it("stops at a cause cycle instead of repeating itself", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    recordHttpFailure(b, { status: 500, errorCode: "INTERNAL_ERROR" });
    // Each error appears once. The depth ceiling alone would still let this
    // log b, a, b, a — so this asserts the cycle guard, not the ceiling.
    assert.deepEqual(
      (errors[0].error ?? []).map((entry) => entry.message),
      ["b", "a"],
    );
  });

  it("handles a thrown non-Error", () => {
    recordHttpFailure("just a string", {
      status: 500,
      errorCode: "INTERNAL_ERROR",
    });
    assert.equal(errors[0].error?.[0].message, "just a string");
  });

  it("does not attach a stack to a client error", () => {
    recordHttpFailure(new Error("nope"), {
      status: 403,
      errorCode: "FORBIDDEN",
    });
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].error, undefined);
  });

  it("stays silent for an ordinary rejection", () => {
    recordHttpFailure(new Error("nope"), { status: 404, errorCode: "NOT_FOUND" });
    assert.equal(errors.length + warnings.length, 0);
  });
});

describe("redactSecrets", () => {
  it("masks a hex secret shorter than the opaque-token threshold", () => {
    // Exactly 32 hex chars: caught by the hex rule alone, since the broader
    // 40-character rule does not reach it. A 64-character key would pass this
    // test with the hex rule deleted.
    const key = "0123456789abcdef0123456789abcdef";
    assert.equal(key.length, 32);
    assert.equal(redactSecrets(`signing key ${key} rejected`).includes(key), false);
  });

  it("masks a long opaque token", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz0123456789";
    assert.equal(redactSecrets(token).includes(token), false);
  });

  it("masks a labelled value even when it is short", () => {
    assert.match(redactSecrets("api_key=hunter2&x=1"), /api_key=\[redacted\]/);
    assert.match(redactSecrets('{"secret": "abc"}'), /\[redacted\]/);
  });

  it("leaves ordinary diagnostic text intact", () => {
    const message = "ECONNREFUSED 10.0.0.5:443 while reading knowhow_core";
    assert.equal(redactSecrets(message), message);
  });

  it("redacts a secret carried inside a logged stack", () => {
    const key = "b".repeat(48);
    recordHttpFailure(new Error(`token ${key} is invalid`), {
      status: 500,
      errorCode: "INTERNAL_ERROR",
    });
    assert.equal(JSON.stringify(errors[0]).includes(key), false);
  });
});
