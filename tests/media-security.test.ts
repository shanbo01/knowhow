import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../lib/server/http-security";
import {
  sha256Bytes,
  validateLogo,
  validateScreenshot,
} from "../lib/server/media-validation";
import { InMemoryPrivateObjectStore } from "../lib/server/private-object-store";

const ONE_PIXEL_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

test("screenshot validation magic-checks raster bytes and claimed dimensions", async () => {
  const valid = await validateScreenshot(ONE_PIXEL_PNG, "image/png", 1, 1);
  assert.deepEqual(
    {
      contentType: valid.contentType,
      byteSize: valid.byteSize,
      width: valid.width,
      height: valid.height,
    },
    {
      contentType: "image/png",
      byteSize: ONE_PIXEL_PNG.byteLength,
      width: 1,
      height: 1,
    },
  );
  assert.equal(valid.sha256, await sha256Bytes(ONE_PIXEL_PNG));
  assert.match(valid.sha256, /^[a-f0-9]{64}$/);

  await assert.rejects(
    validateScreenshot(ONE_PIXEL_PNG, "image/jpeg", 1, 1),
    (error: unknown) =>
      error instanceof HttpError && error.code === "MEDIA_TYPE_INVALID",
  );
  await assert.rejects(
    validateScreenshot(ONE_PIXEL_PNG, "image/png", 2, 1),
    (error: unknown) =>
      error instanceof HttpError && error.code === "MEDIA_DIMENSIONS_INVALID",
  );
  await assert.rejects(
    validateScreenshot(
      new TextEncoder().encode("RIFF0000WEBP"),
      "image/webp",
      1,
      1,
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "MEDIA_TYPE_INVALID",
  );
});

test("media byte and dimension limits fail before private storage", async () => {
  const oversizedScreenshot = new Uint8Array(5 * 1024 * 1024 + 1);
  oversizedScreenshot.set(ONE_PIXEL_PNG.slice(0, 24));
  await assert.rejects(
    validateScreenshot(oversizedScreenshot, "image/png", 1, 1),
    (error: unknown) =>
      error instanceof HttpError && error.code === "MEDIA_SIZE_INVALID",
  );
  const oversizedLogo = new Uint8Array(1024 * 1024 + 1);
  oversizedLogo.set(ONE_PIXEL_PNG.slice(0, 24));
  await assert.rejects(
    validateLogo(oversizedLogo, "image/png"),
    (error: unknown) =>
      error instanceof HttpError && error.code === "LOGO_SIZE_INVALID",
  );
  await assert.rejects(
    validateLogo(new TextEncoder().encode("not-an-image"), "image/png"),
    (error: unknown) =>
      error instanceof HttpError && error.code === "LOGO_TYPE_INVALID",
  );
});

test("private object clones are byte-isolated and preserve privacy metadata", async () => {
  const store = new InMemoryPrivateObjectStore();
  await store.put({
    id: "media_source",
    bytes: ONE_PIXEL_PNG,
    filename: "redacted.png",
    contentType: "image/png",
  });
  const clone = await store.clone(
    "media_source",
    "media_revision_two",
    "revision-two.png",
  );
  assert.equal(clone.filename, "revision-two.png");
  assert.equal(clone.contentType, "image/png");
  assert.deepEqual(clone.bytes, ONE_PIXEL_PNG);
  clone.bytes[0] = 0;
  assert.equal((await store.get("media_source"))?.bytes[0], 0x89);
  assert.equal((await store.get("media_revision_two"))?.bytes[0], 0x89);
  await store.delete("media_source");
  assert.equal(await store.get("media_source"), null);
  assert.ok(await store.get("media_revision_two"));
});
