import { ArrowRight, Check, ShieldCheck, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { InfoHero, MarketingPage } from "./marketing-shell";
import styles from "../marketing.module.css";

export type UseCasePhase = {
  icon: LucideIcon;
  title: string;
  copy: string;
};

type UseCasePageProps = {
  eyebrow: string;
  title: string;
  intro: string;
  sectionId: string;
  framing: {
    label: string;
    title: string;
    copy: string;
  };
  phases: readonly UseCasePhase[];
  outcomesTitle: string;
  outcomesIntro: string;
  outcomes: readonly string[];
  boundary: {
    title: string;
    copy: string;
  };
  relatedHref?: string;
  relatedLabel?: string;
};

export function UseCasePage({
  eyebrow,
  title,
  intro,
  sectionId,
  framing,
  phases,
  outcomesTitle,
  outcomesIntro,
  outcomes,
  boundary,
  relatedHref = "/product",
  relatedLabel = "Explore the product",
}: UseCasePageProps) {
  const workflowHeadingId = `${sectionId}-workflow-heading`;
  const outcomesHeadingId = `${sectionId}-outcomes-heading`;
  const ctaHeadingId = `${sectionId}-cta-heading`;

  return (
    <MarketingPage>
      <InfoHero eyebrow={eyebrow} title={title} intro={intro} />

      <section
        className={styles.solutionSection}
        aria-labelledby={workflowHeadingId}
      >
        <div className={styles.solutionIntro}>
          <p className={styles.eyebrow}>{framing.label}</p>
          <h2 id={workflowHeadingId}>{framing.title}</h2>
          <p>{framing.copy}</p>
        </div>
        <div className={styles.solutionFlow}>
          {phases.map(({ icon: Icon, title: phaseTitle, copy }, index) => (
            <article key={phaseTitle}>
              <div className={styles.solutionCardTop}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <Icon aria-hidden="true" />
              </div>
              <h3>{phaseTitle}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section
        className={styles.outcomeBand}
        aria-labelledby={outcomesHeadingId}
      >
        <div className={styles.outcomeCopy}>
          <p className={styles.eyebrow}>What gets better</p>
          <h2 id={outcomesHeadingId}>{outcomesTitle}</h2>
          <p>{outcomesIntro}</p>
          <ul className={styles.outcomeList}>
            {outcomes.map((outcome) => (
              <li key={outcome}>
                <Check aria-hidden="true" />
                <span>{outcome}</span>
              </li>
            ))}
          </ul>
        </div>
        <aside className={styles.boundaryCard} aria-label="Use-case boundary">
          <span className={styles.boundaryIcon}>
            <ShieldCheck aria-hidden="true" />
          </span>
          <p className={styles.eyebrow}>Built-in boundary</p>
          <h3>{boundary.title}</h3>
          <p>{boundary.copy}</p>
        </aside>
      </section>

      <section className={styles.pageCta} aria-labelledby={ctaHeadingId}>
        <p className={styles.eyebrow}>Make the next run repeatable</p>
        <h2 id={ctaHeadingId}>Start with one workflow your team uses today.</h2>
        <p>
          Create an account and start a 14-day trial, or talk to us about a
          plan, custom setup, or on-prem.
        </p>
        <div className={styles.actions}>
          <Link href="/start-trial" className={styles.primary}>
            Start free trial <ArrowRight aria-hidden="true" />
          </Link>
          <Link href={relatedHref} className={styles.secondary}>
            {relatedLabel}
          </Link>
        </div>
      </section>
    </MarketingPage>
  );
}
