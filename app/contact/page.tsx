import type { Metadata } from "next";
import { resolveSiteOrigin } from "@/lib/server/site-origin";
import { marketingPageGraph, serializeJsonLd } from "@/lib/structured-data";
import { LeadForm } from "../components/lead-form";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

const description =
  "Ask for a walkthrough of KnowHow, a quote for Pro or Enterprise, or an on-premises setup. Most teams start a free trial themselves.";

export async function generateMetadata(): Promise<Metadata> {
  const origin = await resolveSiteOrigin();

  return {
    title: "Contact",
    description,
    alternates: { canonical: `${origin}/contact` },
    openGraph: {
      title: "Contact | KnowHow",
      description,
      url: `${origin}/contact`,
      type: "website",
    },
  };
}

export default async function ContactPage() {
  const origin = await resolveSiteOrigin();

  return (
    <MarketingPage>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(
            marketingPageGraph(origin, {
              path: "/contact",
              name: "Contact",
              description,
            }),
          ),
        }}
      />
      <InfoHero
        eyebrow="Contact"
        title="Tell us what your team needs to standardize."
        intro="Most teams start a free trial themselves. Use this form for a walkthrough, custom or on-prem setup, or a provisioned workspace."
      />
      <section className={styles.formSection}>
        <LeadForm kind="demo" />
      </section>
    </MarketingPage>
  );
}
