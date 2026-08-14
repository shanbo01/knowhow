import type { Metadata } from "next";
import {
  ArrowRight,
  EyeOff,
  History,
  KeyRound,
  LockKeyhole,
  Users,
} from "lucide-react";
import Link from "next/link";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = {
  title: "Trust center | KnowHow",
  description:
    "How KnowHow handles identity, authorization, private media, audit, and data boundaries.",
};

const trustControls = [
  {
    icon: KeyRound,
    title: "Verified identity",
    copy: "Email verification precedes product access. Authenticator apps are optional from Account security.",
  },
  {
    icon: Users,
    title: "Explicit authorization",
    copy: "Organization administration, workspace membership, and guide audiences are separate decisions. Default deny.",
  },
  {
    icon: EyeOff,
    title: "Private media",
    copy: "Screenshots, logos, and exports stay behind server-side authorization and short-lived access.",
  },
  {
    icon: History,
    title: "Auditable action",
    copy: "Publication, membership, support access, and deletion leave a traceable history.",
  },
];

export default function TrustPage() {
  return (
    <MarketingPage>
      <InfoHero
        eyebrow="Security and trust"
        title="Private by architecture. Explicit about the boundaries."
        intro="Identity, authority, and customer content stay distinct. Security fundamentals are part of the product, not a paid add-on."
      />

      <section
        className={styles.trustControlGrid}
        aria-labelledby="trust-controls-heading"
      >
        <div className={styles.trustControlIntro}>
          <p className={styles.eyebrow}>Control model</p>
          <h2 id="trust-controls-heading">
            Access is earned by role—not implied by a job title.
          </h2>
          <p>
            Organization administrators do not receive guide or screenshot
            access automatically.
          </p>
        </div>
        <div className={styles.trustControls}>
          {trustControls.map(({ icon: Icon, title, copy }) => (
            <article key={title}>
              <Icon aria-hidden="true" />
              <div>
                <h3>{title}</h3>
                <p>{copy}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section
        className={styles.trustBoundaries}
        aria-labelledby="trust-boundaries-heading"
      >
        <div>
          <LockKeyhole aria-hidden="true" />
          <p className={styles.eyebrow}>Data boundary</p>
          <h2 id="trust-boundaries-heading">
            Ordinary business-process data only.
          </h2>
          <p>
            Credentials, secrets, payment information, health information,
            national IDs, and other sensitive data are not permitted.
          </p>
        </div>
        <div className={styles.boundaryFacts}>
          <article>
            <strong>Support access</strong>
            <p>
              Customer-approved, short-lived, notified, and audited.
            </p>
          </article>
          <article>
            <strong>Product analytics</strong>
            <p>
              Event-only milestones. Never guide text, screenshots, or secrets.
            </p>
          </article>
          <article>
            <strong>Hosting</strong>
            <p>
              Dedicated environments. Workspace content stays workspace-scoped.
            </p>
          </article>
        </div>
      </section>

      <section className={styles.pageCta} aria-labelledby="trust-cta-heading">
        <p className={styles.eyebrow}>Review before you rely</p>
        <h2 id="trust-cta-heading">Need the technical security detail?</h2>
        <p>Read the security overview and privacy boundary, or contact us.</p>
        <div className={styles.actions}>
          <Link href="/security" className={styles.primary}>
            Security overview <ArrowRight aria-hidden="true" />
          </Link>
          <Link href="/privacy" className={styles.secondary}>
            Privacy notice
          </Link>
        </div>
      </section>
    </MarketingPage>
  );
}
