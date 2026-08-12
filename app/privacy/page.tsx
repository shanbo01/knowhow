import type { Metadata } from "next";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "Privacy notice | KnowHow" };

export default function PrivacyPage() {
  return <MarketingPage><InfoHero eyebrow="Privacy notice" title="Privacy boundaries for the controlled KnowHow pilot." intro="This public summary describes the pilot’s product boundaries. Accepted organizations receive the reviewed contractual notice and data-processing terms before customer data is accepted." /><section className={styles.legal}><h2>What the service processes</h2><p>Account and membership details, workspace configuration, redacted guide content, private media, support messages, content-free usage events, security logs, and audit receipts necessary to operate the service.</p><h2>What must not be submitted</h2><p>Credentials, secrets, payment information, health information, national IDs, or other sensitive or special-category data are prohibited during the pilot.</p><h2>Purpose and access</h2><p>Data is used to provide, secure, support, and measure the service. Product content is workspace-scoped. Exceptional support access is customer-approved, short-lived, and audited.</p><h2>Hosting and retention</h2><p>The SaaS pilot is hosted in Appwrite Cloud’s Frankfurt region. Lifecycle rules provide grace, suspension, retention notices, approval-gated deletion, and content-free deletion receipts. Independent media disaster recovery is deferred.</p><h2>Questions and rights</h2><p>Use the contact form to reach the pilot operator about access, correction, deletion, or privacy questions. Applicable contractual terms and legal contacts control for an accepted pilot.</p></section></MarketingPage>;
}
