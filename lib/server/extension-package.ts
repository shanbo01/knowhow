import "server-only";

import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EXTENSION_PACKAGE_PATH } from "../extension-package-path";
import { HttpError, requestPublicOrigin } from "./http-security";

export { EXTENSION_PACKAGE_PATH };

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

/**
 * A deployment serves the extension one of two ways. A controlled environment
 * points at an archive built during the release, because the deployed image
 * carries a traced Next.js runtime and not the extension source tree. Local
 * development has the source and builds on demand, so an edit is one reload
 * away from being installable.
 */
function prebuiltPackageDirectory() {
  return process.env.KNOWHOW_EXTENSION_PACKAGE_DIR?.trim() || "";
}

function controlledEnvironment() {
  const environment = process.env.KNOWHOW_ENVIRONMENT?.trim().toLowerCase();
  return environment === "production" || environment === "staging";
}

export function extensionPackageDownloadAllowed() {
  return prebuiltPackageDirectory() ? true : !controlledEnvironment();
}

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

/**
 * The release drops exactly one archive here, under the versioned name the
 * extension build produces. Reading the directory rather than a pinned filename
 * keeps an extension version bump from needing a matching deployment edit.
 */
async function readPrebuiltPackage(
  directory: string,
): Promise<ExtensionPackageArtifact> {
  let archives: string[];
  try {
    archives = (await readdir(directory)).filter((name) =>
      name.toLowerCase().endsWith(".zip"),
    );
  } catch (error) {
    throw new HttpError(
      500,
      "EXTENSION_PACKAGE_UNAVAILABLE",
      "The capture extension package is not available.",
      { expose: false, cause: error },
    );
  }
  if (archives.length !== 1) {
    throw new HttpError(
      500,
      "EXTENSION_PACKAGE_UNAVAILABLE",
      "The capture extension package is not available.",
      { expose: false },
    );
  }
  const filename = basename(archives[0]);
  const zip = await readFile(resolve(directory, filename));
  return {
    zip,
    filename,
    origin: process.env.KNOWHOW_SITE_ORIGIN?.trim() || "",
    // Release archives are named knowhow-capture-<version>-<channel>.zip.
    version: /-(\d+\.\d+\.\d+)-/.exec(filename)?.[1] ?? "0.0.0",
  };
}

export async function buildDevelopmentExtensionPackage(
  request: Request,
): Promise<ExtensionPackageArtifact> {
  const prebuilt = prebuiltPackageDirectory();
  if (prebuilt) return readPrebuiltPackage(prebuilt);

  if (!extensionPackageDownloadAllowed()) {
    throw new HttpError(
      404,
      "EXTENSION_PACKAGE_UNAVAILABLE",
      "The capture extension download is not configured for this deployment.",
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
