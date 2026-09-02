import type { Metadata } from "next";
import { LandingPage } from "./components/landing/landing-page";
import { SiteFooter } from "./components/site-footer";
import { SiteHeader } from "./components/site-header";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../lib/marketing-content";
import { resolveSiteOrigin } from "../lib/server/site-origin";
import { homePageGraph, serializeJsonLd } from "../lib/structured-data";

const title = `${PRODUCT_NAME} — ${PRODUCT_TAGLINE}`;

const description =
  "KnowHow records a task while you do it in Chrome, Edge or a Windows app, turns it into a step-by-step guide, and gives your team one governed place to review, publish and find it. Free plan available; 14-day Pro trial without a payment method.";

export async function generateMetadata(): Promise<Metadata> {
  const origin = await resolveSiteOrigin();

  return {
    title: {
      absolute: title,
    },
    description,
    alternates: { canonical: `${origin}/` },
    keywords: [
      "process documentation",
      "standard operating procedures",
      "SOP software",
      "step-by-step guides",
      "screen capture documentation",
      "IT runbooks",
      "service desk procedures",
      "employee onboarding documentation",
    ],
    openGraph: {
      type: "website",
      url: `${origin}/`,
      siteName: PRODUCT_NAME,
      title,
      description,
    },
    twitter: { card: "summary", title, description },
  };
}

export default async function MarketingHome() {
  const origin = await resolveSiteOrigin();

  return (
    <>
      {/* Structured data first: it describes the page that follows to search
          engines and assistants, and is generated from the same content module
          the page renders, so the two cannot drift. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(homePageGraph(origin)),
        }}
      />
      <SiteHeader />
      <main className="kh-landing" id="main">
        <LandingPage />
      </main>
      <SiteFooter />
    </>
  );
}
