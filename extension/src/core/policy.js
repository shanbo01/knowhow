import { detectSensitiveRanges } from "./redaction.js";

const DEFAULT_EXCLUDED_HOSTS = Object.freeze([
  "passwords.google.com",
  "my.1password.com",
  "vault.bitwarden.com",
  "vault.lastpass.com",
  "app.dashlane.com",
]);

export const DEFAULT_CAPTURE_POLICY = Object.freeze({
  version: "local-v1",
  excludedSites: DEFAULT_EXCLUDED_HOSTS,
  allowedSites: [],
  blockInsecureHttp: false,
  redactEmails: true,
  redactPhoneNumbers: true,
  redactFinancialNumbers: true,
  redactIds: true,
  redactAllNumbers: false,
  redactFormFields: true,
  redactImages: false,
  redactTableRows: false,
  redactLongText: false,
  redactCommonNames: false,
  clickTargetColor: "#ff5d2e",
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
      reason: "Rivet captures only regular HTTP and HTTPS pages.",
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
      reason: "This site is excluded by Rivet capture policy.",
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
  return {
    ...DEFAULT_CAPTURE_POLICY,
    ...stored,
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
