import type { Metadata } from "next";
import { Camera, KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "KnowHow Capture extension" };

export default function ExtensionPage() {
  return <MarketingPage><InfoHero eyebrow="KnowHow Capture" title="Capture browser work without collecting the inputs." intro="The unlisted Chrome and Edge extension records interaction structure and privacy-reviewed, rasterized screenshots. It does not collect clipboard contents, raw keystrokes, passwords, or captured form values." /><section className={styles.infoGrid}><article><Camera /><h2>Redacted before upload</h2><p>Selected mask regions are irreversibly filled in the browser before compression and private upload.</p></article><article><KeyRound /><h2>Paired per device</h2><p>One-use pairing codes create a device record with five-minute access tokens and rotating refresh credentials that can be revoked.</p></article><article><ShieldCheck /><h2>Narrow production access</h2><p>Exact extension origins, minimum versions, limited host permissions, and secure capture contexts are enforced server-side.</p></article></section><section className={styles.policyCallout}><h2>Controlled distribution</h2><p>The pilot extension is delivered only to accepted organizations through unlisted Chrome and Edge listings or managed-browser deployment. Automatic updates and a documented rollback policy are required.</p><Link className={styles.secondary} href="/request-pilot">Request pilot access</Link></section></MarketingPage>;
}
