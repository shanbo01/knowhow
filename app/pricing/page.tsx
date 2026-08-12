import type { Metadata } from "next";
import Link from "next/link";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "Pricing principles | KnowHow" };

export default function PricingPage() {
  return <MarketingPage><InfoHero eyebrow="Pricing principles" title="A base workspace plus usage that follows adoption." intro="Plans will include active users, creators, storage, and service entitlements. Security fundamentals remain included and separate from authorization." /><section className={styles.policyCallout}><h2>Design-partner terms are agreed directly</h2><p>Account registration is available, but there are no numeric public prices, automatic workspace creation, self-service checkout, or live payments during the pilot. A signed 30-day pilot can be extended or converted manually.</p><Link className={styles.primary} href="/contact">Contact for pricing</Link></section></MarketingPage>;
}
