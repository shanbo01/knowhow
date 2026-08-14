import type { Metadata } from "next";
import { LockKeyhole, ShieldCheck, Users } from "lucide-react";
import Link from "next/link";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = {
  title: "Security | KnowHow",
  description:
    "Technical appendix for KnowHow identity, authorization, private storage, and support access.",
};

export default function SecurityPage() {
  return (
    <MarketingPage>
      <InfoHero
        eyebrow="Technical appendix"
        title="How KnowHow keeps customer content private and workspace-scoped."
        intro="This page is the deeper security detail behind the Trust center. It covers identity, authorization, private storage, extension credentials, and exceptional support access."
      />
      <section className={styles.infoGrid}>
        <article>
          <LockKeyhole />
          <h2>Server-only data</h2>
          <p>
            Browsers talk to identity only for sign-in. Product records and
            private files stay behind KnowHow’s default-deny policy layer.
          </p>
        </article>
        <article>
          <Users />
          <h2>Separate authority</h2>
          <p>
            Organization administration does not confer guide access. Workspace
            membership and audiences determine who can view content.
          </p>
        </article>
        <article>
          <ShieldCheck />
          <h2>Controlled support</h2>
          <p>
            Exceptional support access requires customer approval, a stated
            reason, a short expiry, reauthentication, notifications, and a
            complete audit trail.
          </p>
        </article>
      </section>
      <section className={styles.policyCallout}>
        <h2>Data classification</h2>
        <p>
          Do not capture or upload credentials, secrets, payment information,
          health information, national IDs, or other sensitive or
          special-category data. Operational recovery targets are not
          contractual recovery guarantees.
        </p>
        <Link className={styles.secondary} href="/trust">
          Visit the trust center
        </Link>
      </section>
    </MarketingPage>
  );
}
