import type { Metadata } from "next";
import { LeadForm } from "../components/lead-form";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "Contact | KnowHow" };

export default function ContactPage() {
  return (
    <MarketingPage>
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
