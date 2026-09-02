import type { MetadataRoute } from "next";
import { getPublicSiteOrigin } from "@/lib/public-site";

/**
 * Private surfaces stay out of every index. The marketing pages are open to
 * everything, answer engines included: being quotable is the point of writing
 * the plan limits down.
 */
const privatePaths = [
  "/app",
  "/w/",
  "/api/",
  "/share/",
  "/desktop/",
  "/login",
  "/register",
  "/start-trial",
  "/forgot-password",
  "/reset-password",
  "/verify",
];

export default function robots(): MetadataRoute.Robots {
  const origin = getPublicSiteOrigin();

  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: privatePaths },
      // Named explicitly so a crawler that reads only its own group still sees
      // the marketing pages allowed and the workspace disallowed.
      {
        userAgent: [
          "GPTBot",
          "OAI-SearchBot",
          "ChatGPT-User",
          "ClaudeBot",
          "Claude-User",
          "Claude-SearchBot",
          "PerplexityBot",
          "Google-Extended",
          "Applebot-Extended",
          "CCBot",
          "Bingbot",
        ],
        allow: "/",
        disallow: privatePaths,
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
