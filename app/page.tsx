import {
  ArrowRight,
  CheckCircle2,
  FileCheck2,
  LockKeyhole,
  MousePointer2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { MarketingFooter, MarketingHeader } from "./components/marketing-shell";
import { ProductPreview } from "./components/product-preview";
import styles from "./marketing.module.css";

const workflowSteps = [
  {
    number: "01",
    icon: MousePointer2,
    title: "Capture the real workflow",
    copy: "Record the browser steps. Mask anything that should never leave the machine.",
  },
  {
    number: "02",
    icon: FileCheck2,
    title: "Shape one trusted guide",
    copy: "Edit the draft, assign an owner and audience, then send it through review.",
  },
  {
    number: "03",
    icon: CheckCircle2,
    title: "Publish and keep it current",
    copy: "Give the team the right version, and see whether they found and finished it.",
  },
];

export default function MarketingHome() {
  return (
    <main className={styles.page}>
      <MarketingHeader />

      <section className={styles.hero} aria-labelledby="home-heading">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Process knowledge that stays useful</p>
          <h1 id="home-heading">
            Make every process <em>clear, current,</em> and easy to follow.
          </h1>
          <p className={styles.lede}>
            KnowHow turns real browser work into guides your team can find,
            trust, and complete.
          </p>
          <div className={styles.actions}>
            <Link href="/start-trial" className={styles.primary}>
              Start free trial <ArrowRight aria-hidden="true" />
            </Link>
            <Link href="#workflow" className={styles.secondary}>
              See how it works
            </Link>
          </div>
          <p className={styles.pilotNote}>
            Create an account, verify your email, and open a workspace. No card
            required.
          </p>
        </div>

        <ProductPreview />
      </section>

      <section
        className={styles.trustStrip}
        aria-label="KnowHow product principles"
      >
        <span>
          <MousePointer2 aria-hidden="true" /> Browser-first capture
        </span>
        <span>
          <FileCheck2 aria-hidden="true" /> Reviewable versions
        </span>
        <span>
          <Users aria-hidden="true" /> Workspace-scoped access
        </span>
        <span>
          <LockKeyhole aria-hidden="true" /> Private media by default
        </span>
      </section>

      <section
        className={styles.section}
        id="workflow"
        aria-labelledby="workflow-heading"
      >
        <div className={styles.sectionIntro}>
          <p className={styles.eyebrow}>Capture → Standardize → Prove</p>
          <h2 id="workflow-heading">Three steps from a messy process to a shared standard.</h2>
          <p>
            Keep the speed of a walkthrough, the clarity of a good guide, and
            the access control operations teams actually need.
          </p>
        </div>
        <div className={styles.workflowGrid}>
          {workflowSteps.map(({ number, icon: Icon, title, copy }) => (
            <article key={number}>
              <div className={styles.workflowCardTop}>
                <span>{number}</span>
                <Icon aria-hidden="true" />
              </div>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.finalCta} aria-labelledby="final-cta-heading">
        <div className={styles.ctaGlow} aria-hidden="true" />
        <p className={styles.eyebrow}>Start with one process</p>
        <h2 id="final-cta-heading">Your next trusted guide can start today.</h2>
        <p>
          A 14-day trial includes an organization, a workspace, and teammate
          invitations. Prefer us to set it up? Talk to us.
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

      <MarketingFooter />
    </main>
  );
}
