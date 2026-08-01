import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { build } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const ONE_PIXEL_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
let outputDirectory;
let media;

before(async () => {
  outputDirectory = await mkdtemp(path.join(tmpdir(), "rivet-media-boundary-"));
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: {
      emptyOutDir: false,
      outDir: outputDirectory,
      target: "es2022",
      minify: false,
      lib: {
        entry: path.join(root, "lib", "server", "media.ts"),
        formats: ["es"],
        fileName: () => "media-boundary.mjs",
      },
    },
  });
  media = await import(
    `${pathToFileURL(path.join(outputDirectory, "media-boundary.mjs")).href}?test=${Date.now()}`
  );
});

after(async () => {
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
});

function bucket() {
  const objects = new Map();
  const writes = [];
  return {
    writes,
    async put(key, value, options) {
      const bytes = value instanceof ReadableStream
        ? new Uint8Array(await new Response(value).arrayBuffer())
        : value instanceof Uint8Array
          ? value.slice()
          : new Uint8Array(value);
      writes.push({ key, bytes, options });
      objects.set(key, {
        body: new Blob([bytes]).stream(),
        size: bytes.byteLength,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      });
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function screenshotInput(overrides = {}) {
  return {
    workspaceId: "workspace-acme",
    revisionId: "revision-1",
    captureId: "capture-1",
    uploadedBy: "user-1",
    contentType: "image/png",
    bytes: ONE_PIXEL_PNG,
    width: 1,
    height: 1,
    redactionAttested: true,
    sourceRasterized: true,
    ...overrides,
  };
}

test("private screenshot storage accepts only attested raster bytes", async () => {
  const storage = bucket();
  const stored = await media.storeRedactedScreenshot(storage, screenshotInput());

  assert.match(stored.objectKey, /^workspaces\/workspace-acme\/revisions\/revision-1\//);
  assert.equal(stored.contentType, "image/png");
  assert.equal(stored.width, 1);
  assert.equal(stored.height, 1);
  assert.match(stored.sha256, /^[0-9a-f]{64}$/);
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.writes[0].options.customMetadata.redactionState, "redacted");
  assert.equal(storage.writes[0].options.customMetadata.sourceRasterized, "true");
});

test("claimed screenshot dimensions must match the raster header", async () => {
  const storage = bucket();
  await assert.rejects(
    media.storeRedactedScreenshot(storage, screenshotInput({ width: 2 })),
    (error) => error.code === "MEDIA_DIMENSIONS_INVALID",
  );
  assert.equal(storage.writes.length, 0);
});

test("unattested and WebP screenshot uploads fail before storage", async () => {
  const storage = bucket();
  await assert.rejects(
    media.storeRedactedScreenshot(
      storage,
      screenshotInput({ redactionAttested: false }),
    ),
    (error) => error.code === "REDACTION_REQUIRED",
  );
  await assert.rejects(
    media.storeRedactedScreenshot(
      storage,
      screenshotInput({
        contentType: "image/webp",
        bytes: new TextEncoder().encode("RIFF0000WEBP"),
      }),
    ),
    (error) => error.code === "MEDIA_TYPE_INVALID",
  );
  assert.equal(storage.writes.length, 0);
});

test("private media reads enforce workspace and privacy metadata", async () => {
  const storage = bucket();
  const stored = await media.storeRedactedScreenshot(storage, screenshotInput());
  const object = await media.readPrivateMedia(
    storage,
    stored.objectKey,
    "workspace-acme",
  );
  assert.equal(object.size, ONE_PIXEL_PNG.byteLength);
  await assert.rejects(
    media.readPrivateMedia(storage, stored.objectKey, "workspace-other"),
    (error) => error.code === "MEDIA_NOT_FOUND",
  );
});

test("restoration clones only the redacted object into the new revision boundary", async () => {
  const storage = bucket();
  const source = await media.storeRedactedScreenshot(storage, screenshotInput());
  const clonedKey = await media.clonePrivateMedia(storage, {
    sourceObjectKey: source.objectKey,
    workspaceId: "workspace-acme",
    revisionId: "revision-2",
    uploadedBy: "user-2",
  });
  assert.match(clonedKey, /^workspaces\/workspace-acme\/revisions\/revision-2\//);
  assert.notEqual(clonedKey, source.objectKey);
  const cloned = await storage.get(clonedKey);
  assert.equal(cloned.customMetadata.revisionId, "revision-2");
  assert.equal(cloned.customMetadata.redactionState, "redacted");
  assert.equal(cloned.customMetadata.sourceRasterized, "true");
  assert.deepEqual(
    new Uint8Array(await new Response(cloned.body).arrayBuffer()),
    ONE_PIXEL_PNG,
  );
});

test("workspace logos are magic-checked, dimension-bounded private objects", async () => {
  const storage = bucket();
  const stored = await media.storeWorkspaceLogo(storage, {
    workspaceId: "workspace-acme",
    uploadedBy: "admin-1",
    contentType: "image/png",
    bytes: ONE_PIXEL_PNG,
  });
  assert.match(stored.objectKey, /^workspaces\/workspace-acme\/branding\//);
  assert.equal(storage.writes[0].options.customMetadata.mediaKind, "workspace-logo");

  await assert.rejects(
    media.storeWorkspaceLogo(bucket(), {
      workspaceId: "workspace-acme",
      uploadedBy: "admin-1",
      contentType: "image/png",
      bytes: new TextEncoder().encode("not-an-image"),
    }),
    (error) => error.code === "LOGO_TYPE_INVALID",
  );
});
