import "server-only";

import { headers } from "next/headers";
import { configuredPublicSiteOrigin } from "../public-site";

/**
 * The origin to build canonical URLs, Open Graph images and JSON-LD identifiers
 * from.
 *
 * `KNOWHOW_SITE_ORIGIN` wins when it is set, so every surface — pages, the
 * sitemap and robots.txt, which read the same variable — names one host. Where
 * it is not configured we fall back to the incoming request rather than
 * emitting `localhost` links into somebody's search index.
 */
export async function resolveSiteOrigin(): Promise<string> {
  const configured = configuredPublicSiteOrigin();
  if (configured) return configured;

  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3001";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}
