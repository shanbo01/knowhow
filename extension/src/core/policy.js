import { detectSensitiveRanges } from "./redaction.js";

const DEFAULT_EXCLUDED_HOSTS = Object.freeze([
  "passwords.google.com",
  "my.1password.com",
  "vault.bitwarden.com",
  "vault.lastpass.com",
  "app.dashlane.com",
]);

// Bumped whenever the meaning of a persisted policy flag's default changes.
// mergePolicy() uses this to migrate policies saved under an older schema so
// stale stored values (like the previous "Smart Blur on by default") don't
// silently keep overriding a new, safer default forever.
export const CAPTURE_POLICY_SCHEMA_VERSION = 2;

// Keys whose *default* changed at CAPTURE_POLICY_SCHEMA_VERSION 2 (Smart Blur
// flipped from opt-out to opt-in). A policy persisted under an older schema
// version has these values discarded in favor of the current defaults below,
// instead of being merged over them.
const MIGRATED_DEFAULT_KEYS = Object.freeze([
  "redactEmails",
  "redactPhoneNumbers",
  "redactFinancialNumbers",
  "redactIds",
  "redactAllNumbers",
  "redactFormFields",
  "redactImages",
  "redactTableRows",
  "redactLongText",
  "redactCommonNames",
]);

export const DEFAULT_CAPTURE_POLICY = Object.freeze({
  version: "local-v1",
  schemaVersion: CAPTURE_POLICY_SCHEMA_VERSION,
  excludedSites: DEFAULT_EXCLUDED_HOSTS,
  allowedSites: [],
  blockInsecureHttp: false,
  // Smart Blur is opt-in: the author reviews and adds blur in the app editor
  // instead of the extension guessing and baking it in automatically.
  redactEmails: false,
  redactPhoneNumbers: false,
  redactFinancialNumbers: false,
  redactIds: false,
  redactAllNumbers: false,
  redactFormFields: false,
  redactImages: false,
  redactTableRows: false,
  redactLongText: false,
  redactCommonNames: false,
  clickTargetColor: "#ff5d2e",
  // Shown briefly on-page when a capture starts or resumes; never present
  // while a screenshot is actually taken. Toggled from the side panel.
  showRecordingIndicator: true,
});

export function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

export function normalizeSitePattern(pattern) {
  const normalized = String(pattern || "").trim().toLowerCase();
  if (!normalized) return "";
  const wildcard = normalized.startsWith("*.");
  try {
    const url = new URL(
      normalized.includes("://")
        ? normalized
        : "https://" + normalized.replace(/^\*\./, ""),
    );
    const hostname = normalizeHostname(url.hostname);
    return wildcard ? "*." + hostname : hostname;
  } catch {
    const hostname = normalizeHostname(normalized.replace(/^\*\./, ""));
    return wildcard ? "*." + hostname : hostname;
  }
}

export function hostnameMatchesPattern(hostname, pattern) {
  const host = normalizeHostname(hostname);
  const rawPattern = String(pattern || "").trim().toLowerCase();
  const normalizedPattern = normalizeSitePattern(rawPattern).replace(/^\*\./, "");
  if (!host || !normalizedPattern) return false;
  if (rawPattern.startsWith("*.")) {
    return host === normalizedPattern || host.endsWith("." + normalizedPattern);
  }
  return host === normalizedPattern;
}

function redactPathSegment(segment, policy) {
  const decoded = safeDecode(segment);
  if (detectSensitiveRanges(decoded, policy).length) {
    return "[redacted]";
  }
  return decoded.slice(0, 100);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function sanitizeCaptureUrl(value, policy = DEFAULT_CAPTURE_POLICY) {
  const url = new URL(value);
  const cleanSegments = url.pathname
    .split("/")
    .map((segment) => redactPathSegment(segment, policy))
    .map((segment) =>
      segment === "[redacted]" ? segment : encodeURIComponent(segment),
    );
  return url.origin + cleanSegments.join("/");
}

export function evaluateCaptureUrl(value, policy = DEFAULT_CAPTURE_POLICY) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { allowed: false, reason: "This page has an invalid URL." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      allowed: false,
      reason: "KnowHow captures only regular HTTP and HTTPS pages.",
    };
  }
  if (url.username || url.password) {
    return {
      allowed: false,
      reason: "URLs containing credentials cannot be captured.",
    };
  }
  if (policy.blockInsecureHttp && url.protocol !== "https:") {
    return {
      allowed: false,
      reason: "This workspace permits capture only on HTTPS pages.",
    };
  }

  const excludedSites = [
    ...DEFAULT_EXCLUDED_HOSTS,
    ...(Array.isArray(policy.excludedSites) ? policy.excludedSites : []),
  ];
  if (
    excludedSites.some((pattern) =>
      hostnameMatchesPattern(url.hostname, pattern),
    )
  ) {
    return {
      allowed: false,
      reason: "This site is excluded by KnowHow capture policy.",
      origin: url.origin,
    };
  }

  const allowedSites = Array.isArray(policy.allowedSites)
    ? policy.allowedSites.filter(Boolean)
    : [];
  if (
    allowedSites.length &&
    !allowedSites.some((pattern) =>
      hostnameMatchesPattern(url.hostname, pattern),
    )
  ) {
    return {
      allowed: false,
      reason: "This site is outside the workspace capture allowlist.",
      origin: url.origin,
    };
  }

  return {
    allowed: true,
    origin: url.origin,
    hostname: normalizeHostname(url.hostname),
    sanitizedUrl: sanitizeCaptureUrl(url.href, policy),
  };
}

export function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function mergePolicy(stored = {}) {
  const isLegacySchema =
    !Number.isInteger(stored.schemaVersion) ||
    stored.schemaVersion < CAPTURE_POLICY_SCHEMA_VERSION;
  const carryForward = isLegacySchema
    ? Object.fromEntries(
        Object.entries(stored).filter(
          ([key]) => !MIGRATED_DEFAULT_KEYS.includes(key),
        ),
      )
    : stored;
  return {
    ...DEFAULT_CAPTURE_POLICY,
    ...carryForward,
    schemaVersion: CAPTURE_POLICY_SCHEMA_VERSION,
    excludedSites: Array.from(
      new Set([
        ...DEFAULT_EXCLUDED_HOSTS,
        ...(Array.isArray(stored.excludedSites)
          ? stored.excludedSites.map(normalizeSitePattern).filter(Boolean)
          : []),
      ]),
    ),
  };
}

function categorySet(value) {
  return new Set(
    Array.isArray(value)
      ? value.filter((item) => typeof item === "string")
      : [],
  );
}

export function applyWorkspaceContext(storedPolicy = {}, context = {}) {
  const local = mergePolicy(storedPolicy);
  const automatic = categorySet(context?.privacy?.automatic);
  const workspaceExcluded = Array.isArray(context?.excludedOrigins)
    ? context.excludedOrigins
    : Array.isArray(context?.excludedSites)
      ? context.excludedSites
      : [];
  const clickTargetColor = /^#[0-9a-f]{6}$/i.test(
    String(context?.clickTargetColor || ""),
  )
    ? context.clickTargetColor
    : local.clickTargetColor;

  return mergePolicy({
    ...local,
    version:
      typeof context?.policyVersion === "string" && context.policyVersion
        ? context.policyVersion.slice(0, 100)
        : local.version,
    excludedSites: [...local.excludedSites, ...workspaceExcluded],
    clickTargetColor,
    redactEmails: automatic.has("email") || local.redactEmails,
    redactPhoneNumbers:
      automatic.has("phone-number") || local.redactPhoneNumbers,
    redactFinancialNumbers:
      automatic.has("financial-number") || local.redactFinancialNumbers,
    redactIds: automatic.has("identifier") || local.redactIds,
    redactFormFields:
      automatic.has("form-field") || local.redactFormFields,
  });
}
