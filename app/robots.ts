import type { MetadataRoute } from "next";
import { getPublicSiteOrigin } from "@/lib/public-site";

export default function robots(): MetadataRoute.Robots {
  const origin = getPublicSiteOrigin();

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/app",
        "/w/",
        "/api/",
        "/login",
        "/register",
        "/start-trial",
        "/forgot-password",
        "/reset-password",
        "/verify",
      ],
    },
    sitemap: `${origin}/sitemap.xml`,
  };
}
