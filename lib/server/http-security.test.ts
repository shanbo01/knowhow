import assert from "node:assert/strict";
import test from "node:test";
import { HttpError, readJsonObject } from "./http-security";

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
