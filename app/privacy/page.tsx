import type { Metadata } from "next";
import { resolveSiteOrigin } from "@/lib/server/site-origin";
import { marketingPageGraph, serializeJsonLd } from "@/lib/structured-data";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

const description =
  "What a KnowHow workspace processes, what must never be submitted to it, and how capture, storage, and deletion are handled.";

export async function generateMetadata(): Promise<Metadata> {
  const origin = await resolveSiteOrigin();

  return {
    title: "Privacy notice",
    description,
    alternates: { canonical: `${origin}/privacy` },
    openGraph: {
      title: "Privacy notice | KnowHow",
      description,
      url: `${origin}/privacy`,
      type: "website",
    },
  };
}

export default async function PrivacyPage() {
  const origin = await resolveSiteOrigin();

  return (
    <MarketingPage>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(
            marketingPageGraph(origin, {
              path: "/privacy",
              name: "Privacy notice",
              description,
            }),
          ),
        }}
      />
      <InfoHero
        eyebrow="Privacy notice"
        title="Clear data boundaries for KnowHow workspaces."
        intro="This public summary describes product boundaries. Contracted organizations receive the reviewed notice and data-processing terms before customer data is accepted under that agreement."
      />
      <section className={styles.legal}>
        <h2>What the service processes</h2>
        <p>
          Account and membership details, workspace configuration, redacted
          guide content, private media, support messages, content-free usage
          events, security logs, and audit receipts necessary to operate the
          service.
        </p>
        <h2>What must not be submitted</h2>
        <p>
          Credentials, secrets, payment information, health information,
          national IDs, or other sensitive or special-category data must not be
          captured or uploaded.
        </p>
        <h2>Browser capture privacy</h2>
        <p>
          Auto Blur covers enabled sensitive categories and elements you
          choose on the page. KnowHow permanently rasterizes those regions on
          your device before a screenshot is stored or uploaded, then destroys
          the unredacted capture. Hover may reveal the live page while you work,
          but it never reveals pixels in a captured screenshot. You can add
          more blur during review; blur already applied during capture cannot
          be removed.
        </p>
        <h2>Purpose and access</h2>
        <p>
          Data is used to provide, secure, support, and measure the service.
          Product content is workspace-scoped. Exceptional support access is
          customer-approved, short-lived, and audited.
        </p>
        <h2>Hosting and retention</h2>
        <p>
          KnowHow is designed for dedicated environments, including self-hosted
          and SaaS deployments. Lifecycle rules provide grace, suspension,
          retention notices, approval-gated deletion, and content-free deletion
          receipts.
        </p>
        <h2>Questions and rights</h2>
        <p>
          Use the contact form to reach KnowHow about access, correction,
          deletion, or privacy questions. Applicable contractual terms and
          legal contacts control for a contracted organization.
        </p>
      </section>
    </MarketingPage>
  );
}
