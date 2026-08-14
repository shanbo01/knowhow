import type { Metadata } from "next";
import {
  ArrowRight,
  CheckCircle2,
  FileCheck2,
  MousePointer2,
} from "lucide-react";
import Link from "next/link";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import { ProductPreview } from "../components/product-preview";
import styles from "../marketing.module.css";

export const metadata: Metadata = {
  title: "How KnowHow works",
  description:
    "Capture a real workflow, publish a trusted guide, and see whether the team finished it.",
};

const journey = [
  {
    icon: MousePointer2,
    label: "Capture",
    title: "Record the work in Chrome or Edge.",
    copy: "Install the extension, walk through the real clicks, and blur anything that should never leave the browser.",
    detail: "Redaction happens before upload",
  },
  {
    icon: FileCheck2,
    label: "Standardize",
    title: "Turn the draft into the current guide.",
    copy: "Add the judgment a recording misses, assign an owner and audience, then publish.",
    detail: "One owned, reviewable standard",
  },
  {
    icon: CheckCircle2,
    label: "Prove",
    title: "See whether the team used it.",
    copy: "Teammates find the current procedure and complete it. You get views and completions—not a copy of the guide in analytics.",
    detail: "Adoption without content telemetry",
  },
];

export default function HowItWorksPage() {
  return (
    <MarketingPage>
      <InfoHero
        eyebrow="Capture → Standardize → Prove"
        title="From a live workflow to a guide your team can actually follow."
        intro="Record the work once, turn it into an owned guide, then see whether people found and finished it."
      />

      <section className={styles.previewBand}>
        <ProductPreview />
      </section>

      <section
        className={styles.productJourney}
        aria-labelledby="how-journey-heading"
      >
        <div className={styles.solutionIntro}>
          <p className={styles.eyebrow}>What you do</p>
          <h2 id="how-journey-heading">
            Three steps from a messy process to a shared standard.
          </h2>
          <p>
            Create an account, capture one ordinary workflow, and invite a
            teammate when you are ready.
          </p>
        </div>
        <div className={styles.capabilityStack}>
          {journey.map(({ icon: Icon, label, title, copy, detail }, index) => (
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
          ))}
        </div>
      </section>

      <section className={styles.pageCta} aria-labelledby="how-cta-heading">
        <p className={styles.eyebrow}>Try it with one process</p>
        <h2 id="how-cta-heading">
          Create a workspace and capture the first flow today.
        </h2>
        <p>
          A 14-day trial includes organization setup, a workspace, and teammate
          invitations. No card required.
        </p>
        <div className={styles.actions}>
          <Link href="/start-trial" className={styles.primary}>
            Start free trial <ArrowRight aria-hidden="true" />
          </Link>
          <Link href="/product" className={styles.secondary}>
            Explore the product
          </Link>
        </div>
      </section>
    </MarketingPage>
  );
}
