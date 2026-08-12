import type { Metadata } from "next";
import { LeadForm } from "../components/lead-form";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "Request a demo | KnowHow" };

export default function RequestDemoPage() {
  return <MarketingPage><InfoHero eyebrow="Product walkthrough" title="See the complete governed-guide workflow." intro="We will demonstrate capture, privacy review, publishing, audience controls, completion, and administration using synthetic data." /><section className={styles.formSection}><LeadForm kind="demo" /></section></MarketingPage>;
}
