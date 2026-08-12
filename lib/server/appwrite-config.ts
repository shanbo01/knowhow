import "server-only";

import { APPWRITE_RESOURCES } from "./appwrite-resources";

export type AppwriteServerConfig = {
  endpoint: string;
  projectId: string;
  apiKey: string;
  databaseId: string;
  privateMediaBucketId: string;
  exportsBucketId: string;
  environment: "development" | "test" | "staging" | "production";
};

export type RestoreApplicationConfiguration = {
  enabled: boolean;
  valid: boolean;
  databaseId: string;
  restorationId: string;
  siteId: string;
  siteOrigin: string;
  sourceSiteOrigin: string;
  issues: string[];
};

const APPWRITE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const APPWRITE_DATABASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const RESTORE_DATABASE_ID = /^knowhow_restore_[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
const RESTORE_SITE_ID = /^knowhow_restore_web_[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;
const RELEASE_SHA = /^[a-f0-9]{40}$/;
const AZURE_QATAR_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.qatarcentral\.cloudapp\.azure\.com$/;

function controlledEndpointIsApproved(endpoint: URL, raw: string) {
  const exactShape =
    endpoint.protocol === "https:" &&
    endpoint.pathname.replace(/\/$/, "") === "/v1" &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.port &&
    !endpoint.search &&
    !endpoint.hash &&
    (raw === `https://${endpoint.hostname}/v1` ||
      raw === `https://${endpoint.hostname}/v1/`);
  if (!exactShape) return false;
  if (endpoint.hostname === "fra.cloud.appwrite.io") {
    const residency = process.env.KNOWHOW_APPWRITE_RESIDENCY?.trim();
    return !residency || residency === "appwrite-cloud-frankfurt";
  }
  return (
    process.env.KNOWHOW_APPWRITE_RESIDENCY?.trim() === "azure-qatar-central" &&
    AZURE_QATAR_HOST.test(endpoint.hostname)
  );
}

function parsedEndpoint(value: string, environment: AppwriteServerConfig["environment"]) {
  const controlled = environment === "staging" || environment === "production";
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("APPWRITE_ENDPOINT must be a valid URL.");
  }
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !(environment === "development" && local)) {
    throw new Error("APPWRITE_ENDPOINT must use HTTPS.");
  }
  if (controlled && !controlledEndpointIsApproved(endpoint, value)) {
    throw new Error(
      "Staging and production require an exact approved Frankfurt Cloud or Azure Qatar Central Appwrite endpoint.",
    );
  }
  return endpoint.toString().replace(/\/$/, "");
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required at runtime.`);
  return value;
}

function exactHttpsOrigin(value: string) {
  try {
    const url = new URL(value);
    const normalized = value.replace(/\/$/, "");
    return (
      url.protocol === "https:" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.origin === normalized
    );
  } catch {
    return false;
  }
}

function exactCanonicalHttpsOrigin(value: string) {
  if (!exactHttpsOrigin(value)) return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function deploymentEnvironment(): AppwriteServerConfig["environment"] {
  const value = process.env.KNOWHOW_ENVIRONMENT?.trim().toLowerCase();
  if (value === "production" || value === "staging" || value === "test") return value;
  return "development";
}

export function getAppwriteServerConfig(): AppwriteServerConfig {
  const environment = deploymentEnvironment();
  const config = {
    endpoint: parsedEndpoint(required("APPWRITE_ENDPOINT"), environment),
    projectId: required("APPWRITE_PROJECT_ID"),
    apiKey: required("APPWRITE_API_KEY"),
    databaseId: process.env.APPWRITE_DATABASE_ID?.trim() || APPWRITE_RESOURCES.database,
    privateMediaBucketId:
      process.env.APPWRITE_PRIVATE_MEDIA_BUCKET_ID?.trim() ||
      APPWRITE_RESOURCES.privateMediaBucket,
    exportsBucketId:
      process.env.APPWRITE_EXPORTS_BUCKET_ID?.trim() || APPWRITE_RESOURCES.exportsBucket,
    environment,
  };
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.projectId)) {
    throw new Error("APPWRITE_PROJECT_ID is invalid.");
  }
  if (config.apiKey.length < 20) throw new Error("APPWRITE_API_KEY is invalid.");
  return config;
}

export function restoreApplicationConfiguration(
  config = getAppwriteServerConfig(),
): RestoreApplicationConfiguration {
  const enabled = process.env.KNOWHOW_RESTORE_APPLICATION_MODE === "1";
  const databaseId =
    process.env.KNOWHOW_RESTORE_APPLICATION_DATABASE_ID?.trim() ?? "";
  const restorationId =
    process.env.KNOWHOW_RESTORE_RESTORATION_ID?.trim() ?? "";
  const siteId =
    process.env.KNOWHOW_RESTORE_APPLICATION_SITE_ID?.trim() ?? "";
  const siteOrigin = process.env.KNOWHOW_SITE_ORIGIN?.trim() ?? "";
  const sourceSiteOrigin =
    process.env.KNOWHOW_RESTORE_APPLICATION_SOURCE_SITE_ORIGIN?.trim() ?? "";
  if (!enabled) {
    return {
      enabled: false,
      valid: false,
      databaseId,
      restorationId,
      siteId,
      siteOrigin,
      sourceSiteOrigin,
      issues: [],
    };
  }

  const issues: string[] = [];
  const sourceProjectId =
    process.env.KNOWHOW_RESTORE_APPLICATION_SOURCE_PROJECT_ID?.trim() ?? "";
  const expectedProjectId =
    process.env.KNOWHOW_RESTORE_APPLICATION_EXPECTED_PROJECT_ID?.trim() ?? "";
  const expectedRelease =
    process.env.KNOWHOW_RESTORE_APPLICATION_EXPECTED_RELEASE?.trim() ?? "";
  const expectedSiteOrigin =
    process.env.KNOWHOW_RESTORE_APPLICATION_SITE_ORIGIN?.trim() ?? "";
  const accessToken =
    process.env.KNOWHOW_RESTORE_APPLICATION_ACCESS_TOKEN?.trim() ?? "";

  if (config.environment !== "production") issues.push("environment");
  if (
    process.env.KNOWHOW_RESTORE_APPLICATION_CONFIRM !==
    "production-isolated-restore-application"
  ) {
    issues.push("confirmation");
  }
  if (
    !APPWRITE_DATABASE_ID.test(databaseId) ||
    !RESTORE_DATABASE_ID.test(databaseId) ||
    databaseId === APPWRITE_RESOURCES.database ||
    config.databaseId !== databaseId
  ) {
    issues.push("database");
  }
  if (!APPWRITE_ID.test(restorationId)) issues.push("restoration");
  if (!RESTORE_SITE_ID.test(siteId) || siteId === APPWRITE_RESOURCES.site) {
    issues.push("site");
  }
  if (
    !APPWRITE_ID.test(sourceProjectId) ||
    sourceProjectId !== config.projectId ||
    expectedProjectId !== config.projectId
  ) {
    issues.push("source_project");
  }
  if (
    !exactCanonicalHttpsOrigin(sourceSiteOrigin) ||
    !exactCanonicalHttpsOrigin(siteOrigin) ||
    expectedSiteOrigin !== siteOrigin ||
    sourceSiteOrigin === siteOrigin
  ) {
    issues.push("site_isolation");
  }
  if (
    accessToken.length < 32 ||
    accessToken.toLowerCase().includes("replace-with-")
  ) {
    issues.push("access_token");
  }
  if (
    !RELEASE_SHA.test(process.env.KNOWHOW_RELEASE?.trim() ?? "") ||
    expectedRelease !== process.env.KNOWHOW_RELEASE?.trim()
  ) {
    issues.push("release");
  }
  for (const [name, value] of [
    ["isolated", process.env.KNOWHOW_RESTORE_APPLICATION_ISOLATED],
    ["non_public", process.env.KNOWHOW_RESTORE_APPLICATION_NON_PUBLIC],
    ["synthetic_only", process.env.KNOWHOW_RESTORE_APPLICATION_SYNTHETIC_ONLY],
    ["email_disabled", process.env.KNOWHOW_RESTORE_APPLICATION_EMAIL_DISABLED],
    ["exclusive", process.env.KNOWHOW_RESTORE_APPLICATION_EXCLUSIVE],
  ] as const) {
    if (value !== "1") issues.push(name);
  }

  return {
    enabled: true,
    valid: issues.length === 0,
    databaseId,
    restorationId,
    siteId,
    siteOrigin,
    sourceSiteOrigin,
    issues,
  };
}

export function deploymentConfigurationIssues(config = getAppwriteServerConfig()) {
  const issues: string[] = [];
  const controlled = config.environment === "staging" || config.environment === "production";
  const restoreApplication = restoreApplicationConfiguration(config);
  const allowedOrigins = (process.env.KNOWHOW_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    controlled &&
    (!allowedOrigins.length ||
      allowedOrigins.some((value) => !exactHttpsOrigin(value)))
  ) {
    issues.push("allowed_origins");
  }
  const extensionOrigins = (process.env.KNOWHOW_EXTENSION_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    controlled &&
    (!extensionOrigins.length ||
      extensionOrigins.some(
        (value) => !/^chrome-extension:\/\/[a-p]{32}$/.test(value),
      ))
  ) {
    issues.push("extension_origins");
  }
  const extensionInstallUrls = [
    process.env.NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL,
    process.env.NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL,
  ];
  if (
    controlled &&
    extensionInstallUrls.some((value) => {
      try {
        const url = new URL(value?.trim() ?? "");
        return url.protocol !== "https:" || Boolean(url.username || url.password);
      } catch {
        return true;
      }
    })
  ) {
    issues.push("extension_install_urls");
  }
  if (controlled && (process.env.KNOWHOW_RATE_LIMIT_PEPPER?.trim().length ?? 0) < 32) {
    issues.push("rate_limit_pepper");
  }
  const tokenKeyring = process.env.KNOWHOW_TOKEN_KEYS_JSON?.trim();
  const legacyTokenKey = process.env.KNOWHOW_TOKEN_SIGNING_KEY?.trim();
  if (controlled && !tokenKeyring && (legacyTokenKey?.length ?? 0) < 32) {
    issues.push("token_keyring");
  }
  if (controlled && !process.env.NEXT_PUBLIC_SENTRY_DSN?.trim()) {
    issues.push("sentry");
  }
  if (controlled && !process.env.KNOWHOW_RELEASE?.trim()) {
    issues.push("release");
  }
  if (
    controlled &&
    (process.env.NEXT_PUBLIC_KNOWHOW_ENVIRONMENT?.trim() !== config.environment ||
      process.env.NEXT_PUBLIC_KNOWHOW_RELEASE?.trim() !==
        process.env.KNOWHOW_RELEASE?.trim())
  ) {
    issues.push("public_deployment_identity");
  }
  const databaseIdValid = restoreApplication.enabled
    ? restoreApplication.valid
    : config.databaseId === APPWRITE_RESOURCES.database;
  if (
    controlled &&
    (!databaseIdValid ||
      config.privateMediaBucketId !== APPWRITE_RESOURCES.privateMediaBucket ||
      config.exportsBucketId !== APPWRITE_RESOURCES.exportsBucket)
  ) {
    issues.push("resource_ids");
  }
  if (restoreApplication.enabled && !restoreApplication.valid) {
    issues.push("restore_application");
  }
  if (
    controlled &&
    (process.env.KNOWHOW_EXPORT_WORKER_SECRET?.trim().length ?? 0) < 32
  ) {
    issues.push("export_worker_secret");
  }
  if (controlled) {
    const siteOrigin = process.env.KNOWHOW_SITE_ORIGIN?.trim() ?? "";
    if (!exactHttpsOrigin(siteOrigin) || !allowedOrigins.includes(siteOrigin)) {
      issues.push("site_origin");
    }
  }
  return issues;
}

export function appwriteSessionCookieName(projectId: string) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(projectId)) {
    throw new Error("APPWRITE_PROJECT_ID cannot be used in a session cookie name.");
  }
  return `a_session_${projectId}`;
}
