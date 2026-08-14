import type { Metadata } from "next";
import {
  ArrowRight,
  CheckCircle2,
  FileCheck2,
  LockKeyhole,
  MousePointer2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import { ProductPreview } from "../components/product-preview";
import styles from "../marketing.module.css";

export const metadata: Metadata = {
  title: "Product overview | KnowHow",
  description:
    "Capture real browser workflows, turn them into governed guides, and see whether the right people received the current procedure.",
};

const capabilities = [
  {
    icon: MousePointer2,
    label: "Capture",
    title: "Begin where the work happens.",
    copy: "The Chrome or Edge extension records the clicks and screenshots. Passwords, clipboard contents, and raw keystrokes stay behind. Mask selected regions before upload.",
    detail: "Redaction happens in the browser",
  },
  {
    icon: FileCheck2,
    label: "Standardize",
    title: "Turn a draft into one trusted guide.",
    copy: "Edit the working revision, add the decisions a recording misses, assign an owner, choose the audience, and publish the approved result.",
    detail: "Ownership, review, and audience together",
  },
  {
    icon: CheckCircle2,
    label: "Prove",
    title: "See whether guidance reached the team.",
    copy: "Track publication, views, and completion without sending guide text into analytics.",
    detail: "Adoption signals, not content telemetry",
  },
];

export default function ProductPage() {
  return (
    <MarketingPage>
      <InfoHero
        eyebrow="KnowHow product"
        title="Capture the work once. Give the team one trusted guide."
        intro="Record the real clicks, publish the approved version, and see whether people finished it—with access that stays explicit."
      />

      <section className={styles.previewBand} aria-hidden="false">
        <ProductPreview />
      </section>

      <section
        className={styles.productJourney}
        aria-labelledby="product-journey-heading"
      >
        <div className={styles.solutionIntro}>
          <p className={styles.eyebrow}>Capture → Standardize → Prove</p>
          <h2 id="product-journey-heading">
            Move quickly without losing the controls that make guidance trusted.
          </h2>
          <p>
            Every stage stays in the same workspace, with the same membership
            model and private files.
          </p>
        </div>
        <div className={styles.capabilityStack}>
          {capabilities.map(
            ({ icon: Icon, label, title, copy, detail }, index) => (
              <article key={label}>
                <div className={styles.capabilityIndex}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <Icon aria-hidden="true" />
                </div>
                <div>
                  <p className={styles.eyebrow}>{label}</p>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </div>
                <p className={styles.capabilityDetail}>
                  <CheckCircle2 aria-hidden="true" /> {detail}
                </p>
              </article>
            ),
          )}
        </div>
      </section>

      <section
        className={styles.productRoles}
        aria-labelledby="product-roles-heading"
      >
        <div className={styles.productRolesCopy}>
          <p className={styles.eyebrow}>One product, explicit authority</p>
          <h2 id="product-roles-heading">
            Give each person the tools their job requires.
          </h2>
          <p>
            Organization administration does not silently become guide access.
          </p>
          <Link href="/trust" className={styles.inlineLink}>
            Review the trust model <ArrowRight aria-hidden="true" />
          </Link>
        </div>
        <div className={styles.roleRows}>
          <article>
            <MousePointer2 aria-hidden="true" />
            <div>
              <h3>Creators capture and refine</h3>
              <p>
                Start from the real task. Spend editing time on context and
                decisions.
              </p>
            </div>
          </article>
          <article>
            <Users aria-hidden="true" />
            <div>
              <h3>Members find and complete</h3>
              <p>
                Search the workspace, follow the current guide, and mark it
                done.
              </p>
            </div>
          </article>
          <article>
            <LockKeyhole aria-hidden="true" />
            <div>
              <h3>Administrators govern access</h3>
              <p>
                Manage membership, roles, and settings without automatic guide
                visibility.
              </p>
            </div>
          </article>
        </div>
      </section>

      <section className={styles.pageCta} aria-labelledby="product-cta-heading">
        <p className={styles.eyebrow}>Ready when you are</p>
        <h2 id="product-cta-heading">
          Build the first guide with a real team workflow.
        </h2>
        <p>
          Create an organization, start a 14-day no-card trial, and invite
          teammates.
        </p>
        <div className={styles.actions}>
          <Link href="/start-trial" className={styles.primary}>
            Start free trial <ArrowRight aria-hidden="true" />
          </Link>
          <Link href="/contact" className={styles.secondary}>
            Talk to us
          </Link>
        </div>
      </section>
    </MarketingPage>
  );
}
