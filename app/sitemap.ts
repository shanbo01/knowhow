import type { MetadataRoute } from "next";
import { getPublicSiteOrigin, PUBLIC_MARKETING_PATHS } from "@/lib/public-site";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = getPublicSiteOrigin();

  return PUBLIC_MARKETING_PATHS.map((path) => ({
    url: `${origin}${path === "/" ? "" : path}`,
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : 0.7,
  }));
}
