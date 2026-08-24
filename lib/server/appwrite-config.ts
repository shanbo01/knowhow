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
const CONTROLLED_ENVIRONMENTS = new Set(["staging", "production"]);

function normalizedExactUrl(raw: string, url: URL) {
  const normalized = url.toString().replace(/\/$/, "");
  return raw === normalized || raw === `${normalized}/`;
}

function controlledEnvironment(
  environment: AppwriteServerConfig["environment"],
) {
  return CONTROLLED_ENVIRONMENTS.has(environment);
}

function configuredAppwriteHosts(
  environment: AppwriteServerConfig["environment"],
) {
  if (!controlledEnvironment(environment)) return new Set<string>();
  const entries = required("KNOWHOW_APPWRITE_HOSTS")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    !entries.length ||
    entries.some(
      (value) =>
        !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(value) ||
        LOCAL_ENDPOINT_HOSTS.has(value.split(":")[0]),
    )
  ) {
    throw new Error(
      "KNOWHOW_APPWRITE_HOSTS must contain exact non-local Appwrite hosts.",
    );
  }
  return new Set(entries);
}

function appwriteEndpoint(
  value: string,
  name: string,
  environment: AppwriteServerConfig["environment"],
  localHosts: ReadonlySet<string>,
  remoteHosts: ReadonlySet<string>,
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
  const controlled = controlledEnvironment(environment);
  const hostAllowed = controlled
    ? remoteHosts.has(endpoint.host.toLowerCase()) &&
      !LOCAL_ENDPOINT_HOSTS.has(endpoint.hostname)
    : localHosts.has(endpoint.hostname);
  if (
    (controlled
      ? endpoint.protocol !== "https:"
      : !["http:", "https:"].includes(endpoint.protocol)) ||
    !hostAllowed ||
    endpoint.pathname.replace(/\/$/, "") !== "/v1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !normalizedExactUrl(value, endpoint)
  ) {
    throw new Error(
      controlled
        ? `${name} must be an exact HTTPS Appwrite /v1 endpoint on an allowlisted host.`
        : `${name} must be an exact local Appwrite /v1 endpoint.`,
    );
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
  if (!value) return "development";
  if (value === "production" || value === "staging" || value === "test") {
    return value;
  }
  if (value === "development") return value;
  throw new Error("KNOWHOW_ENVIRONMENT is invalid.");
}

function exactApplicationOrigin(
  value: string,
  environment: AppwriteServerConfig["environment"],
) {
  if (value !== value.trim()) return false;
  try {
    const url = new URL(value);
    const controlled = controlledEnvironment(environment);
    return (
      (controlled
        ? url.protocol === "https:" && !LOCAL_ENDPOINT_HOSTS.has(url.hostname)
        : ["http:", "https:"].includes(url.protocol) &&
          LOCAL_ENDPOINT_HOSTS.has(url.hostname)) &&
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
  const environment = deploymentEnvironment();
  const remoteHosts = configuredAppwriteHosts(environment);
  const endpoint = appwriteEndpoint(
    required("APPWRITE_ENDPOINT"),
    "APPWRITE_ENDPOINT",
    environment,
    LOCAL_ENDPOINT_HOSTS,
    remoteHosts,
  );
  const internalValue = process.env.APPWRITE_INTERNAL_ENDPOINT?.trim();
  const config: AppwriteServerConfig = {
    endpoint,
    internalEndpoint: internalValue
      ? appwriteEndpoint(
          internalValue,
          "APPWRITE_INTERNAL_ENDPOINT",
          environment,
          LOCAL_INTERNAL_HOSTS,
          remoteHosts,
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
    environment,
  };
  for (const [name, value] of [
    ["APPWRITE_PROJECT_ID", config.projectId],
    ["APPWRITE_DATABASE_ID", config.databaseId],
    ["APPWRITE_PRIVATE_MEDIA_BUCKET_ID", config.privateMediaBucketId],
    ["APPWRITE_EXPORTS_BUCKET_ID", config.exportsBucketId],
  ] as const) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
      throw new Error(`${name} is invalid.`);
    }
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
  const normalizedAllowedOrigins = allowedOrigins.flatMap((value) => {
    if (!exactApplicationOrigin(value, config.environment)) return [];
    return [new URL(value).origin];
  });
  if (
    !allowedOrigins.length ||
    normalizedAllowedOrigins.length !== allowedOrigins.length
  ) {
    issues.push("allowed_origins");
  }

  const siteOrigin = process.env.KNOWHOW_SITE_ORIGIN?.trim() ?? "";
  if (
    !exactApplicationOrigin(siteOrigin, config.environment) ||
    !normalizedAllowedOrigins.includes(
      siteOrigin ? new URL(siteOrigin).origin : "",
    )
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
  if (controlledEnvironment(config.environment)) {
    if (config.projectId === "knowhow-local" || config.apiKey.length < 32) {
      issues.push("appwrite_credentials");
    }
    if (
      !process.env.APPWRITE_DATABASE_ID?.trim() ||
      !process.env.APPWRITE_PRIVATE_MEDIA_BUCKET_ID?.trim() ||
      !process.env.APPWRITE_EXPORTS_BUCKET_ID?.trim()
    ) {
      issues.push("resource_ids");
    }
    const release = process.env.KNOWHOW_RELEASE?.trim();
    if (!release || release === "local" || release === "unversioned") {
      issues.push("release_identity");
    }
    if (!process.env.RESEND_API_KEY?.trim()) issues.push("email_provider");
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
