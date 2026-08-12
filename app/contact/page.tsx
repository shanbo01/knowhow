import type { Metadata } from "next";
import { LeadForm } from "../components/lead-form";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "Contact and pilot pricing | KnowHow" };

export default function ContactPage() {
  return <MarketingPage><InfoHero eyebrow="Contact and pricing" title="Tell us what your team needs to standardize." intro="Pilot pricing is agreed directly. Public prices, self-service checkout, and live payments are intentionally unavailable during the design-partner phase." /><section className={styles.formSection}><LeadForm kind="pricing" /></section></MarketingPage>;
}
