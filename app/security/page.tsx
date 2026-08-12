import type { Metadata } from "next";
import { LockKeyhole, ShieldCheck, Users } from "lucide-react";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "Security | KnowHow" };

export default function SecurityPage() {
  return <MarketingPage><InfoHero eyebrow="Security overview" title="Customer content stays private and workspace-scoped." intro="KnowHow’s pilot architecture combines verified identities, administrator MFA, server-side authorization, private storage, short-lived extension credentials, and auditable exceptional access." /><section className={styles.infoGrid}><article><LockKeyhole /><h2>Server-only data</h2><p>Browsers use Appwrite directly only for authentication. Product records and private files are accessed through KnowHow’s default-deny policy layer.</p></article><article><Users /><h2>Separate authority</h2><p>Organization administration does not confer guide access. Workspace membership and audiences determine who can view content.</p></article><article><ShieldCheck /><h2>Controlled support</h2><p>Exceptional support access requires customer approval, a stated reason, a short expiry, reauthentication, notifications, and a complete audit trail.</p></article></section><section className={styles.policyCallout}><h2>Pilot data classification</h2><p>Do not capture or upload credentials, secrets, payment information, health information, national IDs, or other sensitive or special-category data. Independent media disaster recovery and contractual recovery guarantees are not part of the pilot.</p></section></MarketingPage>;
}
