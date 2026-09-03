import type { MetadataRoute } from "next";
import { getPublicSiteOrigin, PUBLIC_MARKETING_PATHS } from "@/lib/public-site";

/**
 * Priorities are relative within this site: the home page carries the product
 * story, the extension and contact pages convert, and the legal pages exist to
 * be findable rather than ranked.
 */
const PRIORITY: Record<string, number> = {
  "/": 1,
  "/extension": 0.8,
  "/contact": 0.7,
  // Answers the question an invited teammate arrives with, so it is
  // findable rather than buried under the legal pages.
  "/help": 0.7,
  "/privacy": 0.4,
  "/terms": 0.4,
};

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = getPublicSiteOrigin();
  const lastModified = new Date();

  return PUBLIC_MARKETING_PATHS.map((path) => ({
    url: `${origin}${path === "/" ? "" : path}`,
    lastModified,
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: PRIORITY[path] ?? 0.5,
  }));
}
