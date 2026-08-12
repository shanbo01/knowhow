import type { Metadata } from "next";
import { CheckCircle2, FileCheck2, MousePointer2 } from "lucide-react";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "How KnowHow works" };

export default function HowItWorksPage() {
  return <MarketingPage><InfoHero eyebrow="Capture → Standardize → Prove" title="A controlled path from real work to trusted guidance." intro="KnowHow gives each guide an owner, revision history, review state, audience, and proof of adoption." /><section className={styles.infoGrid}><article><MousePointer2 /><h2>Capture</h2><p>Record a browser workflow with excluded hosts, password-field blocking, deliberate screenshot controls, and irreversible local masking.</p></article><article><FileCheck2 /><h2>Standardize</h2><p>Edit one working revision, assign reviewers, complete privacy review, scope its audience, and publish the approved result.</p></article><article><CheckCircle2 /><h2>Prove</h2><p>Measure first publication, teammate views, and completion using content-free events and tamper-evident audit sequencing.</p></article></section></MarketingPage>;
}
