import type { Metadata } from "next";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "Pilot terms summary | KnowHow" };

export default function TermsPage() {
  return <MarketingPage><InfoHero eyebrow="Pilot terms summary" title="KnowHow is available only through a signed, invitation-only pilot." intro="This page is an operational summary, not the pilot agreement. Accepted organizations must execute the legally reviewed agreement, privacy terms, and acceptable-use policy before real customer data is accepted." /><section className={styles.legal}><h2>Controlled access</h2><p>No public self-service account creation, payments, SSO/SCIM, regulated-data use, or customer-ready on-prem service is offered in this pilot.</p><h2>Permitted use</h2><p>The pilot is limited to agreed internal business-process workflows, initially one department and no more than 100 users per organization, using ordinary business-process data only.</p><h2>Service targets</h2><p>Internal targets are database RPO up to 24 hours and best-effort RTO within one business day. These are not contractual SLAs or recovery guarantees.</p><h2>Support and changes</h2><p>In-app support carries a one-business-day response target. The extension and service may be updated or rolled back under the pilot change policy.</p><h2>Controlling documents</h2><p>The signed pilot agreement, DPA, acceptable-use policy, privacy notice, and retention schedule govern an accepted organization and supersede this summary.</p></section></MarketingPage>;
}
