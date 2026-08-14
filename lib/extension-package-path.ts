export const EXTENSION_PACKAGE_PATH = "/api/extension-package";

export function extensionPackageDownloadAllowed(
  environment = process.env.KNOWHOW_ENVIRONMENT?.trim().toLowerCase() ||
    "development",
) {
  return environment !== "production" && environment !== "staging";
}
