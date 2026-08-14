import type { Metadata } from "next";
import Link from "next/link";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "Pricing | KnowHow" };

export default function PricingPage() {
  return (
    <MarketingPage>
      <InfoHero
        eyebrow="Pricing"
        title="Start free, then choose a plan in the product."
        intro="Security fundamentals stay included. Authorization never depends on a pricing tier. After the trial, pick a plan in-app or talk to us about company and on-prem."
      />
      <section className={styles.pricingOffers} aria-label="KnowHow plans">
        <article className={styles.pricingFeatured}>
          <p className={styles.eyebrow}>Self-serve</p>
          <h2>Free trial</h2>
          <p className={styles.pricingAmount}>14 days</p>
          <p>
            Create an organization and first workspace with no card. Invite
            teammates, capture a workflow, and publish a guide. Choose a plan
            in the product when the trial ends.
          </p>
          <Link className={styles.primary} href="/start-trial">
            Start free trial
          </Link>
        </article>
        <article>
          <p className={styles.eyebrow}>Custom</p>
          <h2>Company and on-prem</h2>
          <p className={styles.pricingAmount}>Let&apos;s talk</p>
          <p>
            Need a provisioned tenant, a dedicated deployment, or KnowHow on
            your own infrastructure? We will set it up.
          </p>
          <Link className={styles.secondary} href="/contact">
            Contact us
          </Link>
        </article>
      </section>
    </MarketingPage>
  );
}
