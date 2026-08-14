import "server-only";

import { APPWRITE_RESOURCES } from "./appwrite-resources";

export type AppwriteServerConfig = {
  endpoint: string;
  internalEndpoint: string;
  projectId: string;
  apiKey: string;
  databaseId: string;
  privateMediaBucketId: string;
  exportsBucketId: string;
  environment: "development" | "test" | "staging" | "production";
};

const LOCAL_ENDPOINT_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "host.docker.internal",
]);
const LOCAL_INTERNAL_HOSTS = new Set([
  ...LOCAL_ENDPOINT_HOSTS,
  "appwrite",
  "appwrite-internal",
]);

function normalizedExactUrl(raw: string, url: URL) {
  const normalized = url.toString().replace(/\/$/, "");
  return raw === normalized || raw === `${normalized}/`;
}

function localAppwriteEndpoint(
  value: string,
  name: string,
  allowedHosts: ReadonlySet<string>,
) {
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain surrounding whitespace.`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !allowedHosts.has(endpoint.hostname) ||
    endpoint.pathname.replace(/\/$/, "") !== "/v1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !normalizedExactUrl(value, endpoint)
  ) {
    throw new Error(`${name} must be an exact local Appwrite /v1 endpoint.`);
  }
  return endpoint.toString().replace(/\/$/, "");
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required at runtime.`);
  return value;
}

function deploymentEnvironment(): AppwriteServerConfig["environment"] {
  const value = process.env.KNOWHOW_ENVIRONMENT?.trim().toLowerCase();
  if (value === "production" || value === "staging" || value === "test") {
    return value;
  }
  return "development";
}

function exactLocalOrigin(value: string) {
  if (value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      LOCAL_ENDPOINT_HOSTS.has(url.hostname) &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      normalizedExactUrl(value, url)
    );
  } catch {
    return false;
  }
}

export function getAppwriteServerConfig(): AppwriteServerConfig {
  const endpoint = localAppwriteEndpoint(
    required("APPWRITE_ENDPOINT"),
    "APPWRITE_ENDPOINT",
    LOCAL_ENDPOINT_HOSTS,
  );
  const internalValue = process.env.APPWRITE_INTERNAL_ENDPOINT?.trim();
  const config: AppwriteServerConfig = {
    endpoint,
    internalEndpoint: internalValue
      ? localAppwriteEndpoint(
          internalValue,
          "APPWRITE_INTERNAL_ENDPOINT",
          LOCAL_INTERNAL_HOSTS,
        )
      : endpoint,
    projectId: required("APPWRITE_PROJECT_ID"),
    apiKey: required("APPWRITE_API_KEY"),
    databaseId:
      process.env.APPWRITE_DATABASE_ID?.trim() || APPWRITE_RESOURCES.database,
    privateMediaBucketId:
      process.env.APPWRITE_PRIVATE_MEDIA_BUCKET_ID?.trim() ||
      APPWRITE_RESOURCES.privateMediaBucket,
    exportsBucketId:
      process.env.APPWRITE_EXPORTS_BUCKET_ID?.trim() ||
      APPWRITE_RESOURCES.exportsBucket,
    environment: deploymentEnvironment(),
  };
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.projectId)) {
    throw new Error("APPWRITE_PROJECT_ID is invalid.");
  }
  if (config.apiKey.length < 20) {
    throw new Error("APPWRITE_API_KEY is invalid.");
  }
  return config;
}

export function deploymentConfigurationIssues(
  config = getAppwriteServerConfig(),
) {
  const issues: string[] = [];
  const allowedOrigins = (process.env.KNOWHOW_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !allowedOrigins.length ||
    allowedOrigins.some((value) => !exactLocalOrigin(value))
  ) {
    issues.push("allowed_origins");
  }

  const siteOrigin = process.env.KNOWHOW_SITE_ORIGIN?.trim() ?? "";
  if (
    !exactLocalOrigin(siteOrigin) ||
    !allowedOrigins.includes(siteOrigin.replace(/\/$/, ""))
  ) {
    issues.push("site_origin");
  }

  const extensionOrigins = (process.env.KNOWHOW_EXTENSION_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    extensionOrigins.some(
      (value) => !/^chrome-extension:\/\/[a-p]{32}$/.test(value),
    )
  ) {
    issues.push("extension_origins");
  }

  if ((process.env.KNOWHOW_RATE_LIMIT_PEPPER?.trim().length ?? 0) < 32) {
    issues.push("rate_limit_pepper");
  }
  const tokenKeyring = process.env.KNOWHOW_TOKEN_KEYS_JSON?.trim();
  const legacyTokenKey = process.env.KNOWHOW_TOKEN_SIGNING_KEY?.trim();
  if (!tokenKeyring && (legacyTokenKey?.length ?? 0) < 32) {
    issues.push("token_keyring");
  }
  if ((process.env.KNOWHOW_EXPORT_WORKER_SECRET?.trim().length ?? 0) < 32) {
    issues.push("export_worker_secret");
  }
  if (
    config.databaseId !== APPWRITE_RESOURCES.database ||
    config.privateMediaBucketId !== APPWRITE_RESOURCES.privateMediaBucket ||
    config.exportsBucketId !== APPWRITE_RESOURCES.exportsBucket
  ) {
    issues.push("resource_ids");
  }

  const publicEnvironment =
    process.env.NEXT_PUBLIC_KNOWHOW_ENVIRONMENT?.trim();
  if (publicEnvironment && publicEnvironment !== config.environment) {
    issues.push("public_deployment_identity");
  }
  const release = process.env.KNOWHOW_RELEASE?.trim();
  const publicRelease = process.env.NEXT_PUBLIC_KNOWHOW_RELEASE?.trim();
  if (release && publicRelease && release !== publicRelease) {
    issues.push("public_deployment_identity");
  }
  return [...new Set(issues)];
}

export function appwriteSessionCookieName(projectId: string) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(projectId)) {
    throw new Error(
      "APPWRITE_PROJECT_ID cannot be used in a session cookie name.",
    );
  }
  return `a_session_${projectId}`;
}
