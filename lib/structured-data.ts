/**
 * Schema.org descriptions of the marketing surfaces.
 *
 * Search engines and assistants read this before they read the page, so it only
 * states things the product actually does. Ratings, review counts, and customer
 * numbers are deliberately absent: there is no honest value to put in them.
 */

import {
  FAQ,
  PRODUCT_AUDIENCE,
  PRODUCT_CATEGORY,
  PRODUCT_NAME,
  PRODUCT_SUMMARY,
  PRODUCT_TAGLINE,
} from "./marketing-content";

type JsonLdNode = Record<string, unknown>;

/**
 * `JSON.stringify` does not escape `<`, so a stray closing tag inside any of
 * the strings above would end the script element early. Everything here is
 * authored in-repo, but the escape costs nothing and outlives the assumption.
 */
export function serializeJsonLd(graph: unknown) {
  return JSON.stringify(graph).replace(/</g, "\\u003c");
}

export function organizationNode(origin: string): JsonLdNode {
  return {
    "@type": "Organization",
    "@id": `${origin}/#organization`,
    name: PRODUCT_NAME,
    url: `${origin}/`,
    logo: `${origin}/favicon.svg`,
    description: PRODUCT_SUMMARY,
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "sales",
        url: `${origin}/contact`,
        availableLanguage: ["en"],
      },
    ],
  };
}

export function websiteNode(origin: string): JsonLdNode {
  return {
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    name: PRODUCT_NAME,
    url: `${origin}/`,
    description: PRODUCT_SUMMARY,
    inLanguage: "en",
    publisher: { "@id": `${origin}/#organization` },
  };
}

export function softwareApplicationNode(origin: string): JsonLdNode {
  return {
    "@type": "SoftwareApplication",
    "@id": `${origin}/#software`,
    name: PRODUCT_NAME,
    url: `${origin}/`,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: PRODUCT_CATEGORY,
    operatingSystem: "Web browser (Chrome, Edge), Windows",
    description: PRODUCT_SUMMARY,
    audience: { "@type": "Audience", audienceType: PRODUCT_AUDIENCE },
    publisher: { "@id": `${origin}/#organization` },
    featureList: [
      "Browser capture of a task in Chrome and Edge",
      "Windows desktop capture of native applications",
      "Automatic step-by-step draft guides from captured work",
      "Screenshot annotation with blur and redaction applied before upload",
      "Draft, review, and publish lifecycle with retained revisions",
      "Audience control by workspace, group, named user, or unlisted link",
      "Export to Markdown, PDF, HTML, and PowerPoint",
    ],
    // Only the plan with a published price is expressed as an offer. Pro and
    // Enterprise are quoted, and inventing a number here would be a lie a
    // search engine repeats.
    offers: {
      "@type": "Offer",
      name: "Free plan",
      price: "0",
      priceCurrency: "USD",
      url: `${origin}/register`,
      description:
        "3 members, 1 guide creator, 15 guides, and 1 GB of storage, with browser capture included. Pro is available as a 14-day trial that needs no payment method.",
    },
  };
}

export function faqNode(origin: string): JsonLdNode {
  return {
    "@type": "FAQPage",
    "@id": `${origin}/#faq`,
    mainEntity: FAQ.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  };
}

export function homePageGraph(origin: string) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      organizationNode(origin),
      websiteNode(origin),
      softwareApplicationNode(origin),
      faqNode(origin),
      {
        "@type": "WebPage",
        "@id": `${origin}/#webpage`,
        url: `${origin}/`,
        name: `${PRODUCT_NAME} — ${PRODUCT_TAGLINE}`,
        description: PRODUCT_SUMMARY,
        isPartOf: { "@id": `${origin}/#website` },
        about: { "@id": `${origin}/#software` },
        inLanguage: "en",
      },
    ],
  };
}

export function marketingPageGraph(
  origin: string,
  page: { path: string; name: string; description: string },
) {
  const url = `${origin}${page.path}`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${url}#webpage`,
        url,
        name: page.name,
        description: page.description,
        isPartOf: { "@id": `${origin}/#website` },
        inLanguage: "en",
        breadcrumb: { "@id": `${url}#breadcrumb` },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: PRODUCT_NAME,
            item: `${origin}/`,
          },
          { "@type": "ListItem", position: 2, name: page.name, item: url },
        ],
      },
    ],
  };
}
