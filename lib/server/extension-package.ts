import "server-only";

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EXTENSION_PACKAGE_PATH,
  extensionPackageDownloadAllowed,
} from "../extension-package-path";
import { HttpError, requestPublicOrigin } from "./http-security";

export { EXTENSION_PACKAGE_PATH, extensionPackageDownloadAllowed };

type ExtensionPackageArtifact = {
  zip: Buffer;
  filename: string;
  origin: string;
  version: string;
};

type CapturePackageBuilder = (options: {
  store?: boolean;
  origin?: string;
  persist?: boolean;
  extensionRoot?: string;
}) => Promise<ExtensionPackageArtifact>;

function importFromDisk<T>(href: string): Promise<T> {
  // Next/Turbopack rewrites import(variable); load the on-disk builder instead.
  const importer = new Function("href", "return import(href)") as (
    href: string,
  ) => Promise<T>;
  return importer(href);
}

async function loadCapturePackageBuilder(): Promise<CapturePackageBuilder> {
  const scriptPath = resolve(process.cwd(), "extension/scripts/build.mjs");
  if (!existsSync(scriptPath)) {
    throw new HttpError(
      500,
      "EXTENSION_PACKAGE_UNAVAILABLE",
      "The capture extension package is not available in this checkout.",
    );
  }
  const loadedModule = await importFromDisk<{
    buildKnowHowCapturePackage: CapturePackageBuilder;
  }>(
    `${pathToFileURL(scriptPath).href}?mtime=${statSync(scriptPath).mtimeMs}`,
  );
  return loadedModule.buildKnowHowCapturePackage;
}

export async function buildDevelopmentExtensionPackage(
  request: Request,
): Promise<ExtensionPackageArtifact> {
  if (!extensionPackageDownloadAllowed()) {
    throw new HttpError(
      404,
      "EXTENSION_PACKAGE_UNAVAILABLE",
      "Download the capture extension from the Chrome or Edge store.",
    );
  }
  const origin = requestPublicOrigin(request);
  const extensionRoot = resolve(process.cwd(), "extension");
  const buildKnowHowCapturePackage = await loadCapturePackageBuilder();
  return buildKnowHowCapturePackage({
    origin,
    persist: false,
    extensionRoot,
  });
}
