import assert from "node:assert/strict";
import test from "node:test";
import { buildKnowHowCapturePackage } from "../extension/scripts/build.mjs";
import {
  EXTENSION_PACKAGE_PATH,
  extensionPackageDownloadAllowed,
} from "../lib/extension-package-path";

test("extension package downloads stay off controlled environments", () => {
  assert.equal(EXTENSION_PACKAGE_PATH, "/api/extension-package");
  assert.equal(extensionPackageDownloadAllowed("development"), true);
  assert.equal(extensionPackageDownloadAllowed("test"), true);
  assert.equal(extensionPackageDownloadAllowed("staging"), false);
  assert.equal(extensionPackageDownloadAllowed("production"), false);
});

test("development extension zip is loadable without a repo build command", async () => {
  const artifact = await buildKnowHowCapturePackage({
    origin: "http://localhost:3001",
    persist: false,
  });
  const zip = Buffer.from(artifact.zip);
  const manifestName = Buffer.from("manifest.json");
  const configPath = Buffer.from("src/core/config.js");
  assert.equal(artifact.origin, "http://localhost:3001");
  assert.match(artifact.filename, /^knowhow-capture-0\.1\.0-development\.zip$/);
  assert.ok(zip.byteLength > 1000);
  assert.ok(zip.includes(manifestName));
  assert.ok(zip.includes(configPath));
});
