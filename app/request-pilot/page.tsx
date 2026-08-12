import type { Metadata } from "next";
import { LeadForm } from "../components/lead-form";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "Request a design-partner pilot | KnowHow" };

export default function RequestPilotPage() {
  return <MarketingPage><InfoHero eyebrow="Invitation-only design partner" title="Request a controlled KnowHow pilot." intro="Start with one department, up to 100 users, and ordinary business-process data. Selected partners sign pilot and privacy terms before any customer data is accepted." /><section className={styles.formSection}><LeadForm kind="pilot" /></section></MarketingPage>;
}
