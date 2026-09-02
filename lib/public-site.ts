const DEFAULT_PUBLIC_ORIGIN = "http://localhost:3001";

export const PUBLIC_MARKETING_PATHS = [
  "/",
  "/extension",
  "/contact",
  "/privacy",
  "/terms",
] as const;

/**
 * The configured public origin, or null when it is absent or unusable. Callers
 * that can fall back to the incoming request — pages resolving a canonical URL,
 * for instance — need to tell "not configured" apart from "configured to the
 * local default", which is why this is separate from the getter below.
 */
export function configuredPublicSiteOrigin(): string | null {
  const configured = process.env.KNOWHOW_SITE_ORIGIN?.trim();
  if (!configured) return null;

  try {
    const url = new URL(configured);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function getPublicSiteOrigin(): string {
  return configuredPublicSiteOrigin() ?? DEFAULT_PUBLIC_ORIGIN;
}
