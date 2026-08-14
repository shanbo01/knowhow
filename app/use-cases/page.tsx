import type { Metadata } from "next";
import {
  ArrowRight,
  BadgeCheck,
  BookOpenCheck,
  Headset,
  MonitorSmartphone,
  Scale,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = {
  title: "Use cases | KnowHow",
  description:
    "Capture, publish, and prove completion for IT, onboarding, service desk, operations, compliance, and software training.",
};

const useCases = [
  {
    href: "/internal-it",
    icon: Wrench,
    title: "Internal IT",
    copy: "Turn specialist browser work into owned, reviewable procedures.",
  },
  {
    href: "/employee-onboarding",
    icon: BadgeCheck,
    title: "Employee onboarding",
    copy: "Give every new starter the same current path across teams.",
  },
  {
    href: "/customer-service-desk-procedures",
    icon: Headset,
    title: "Service desk",
    copy: "Keep the approved answer in front of agents while they work tickets.",
  },
  {
    href: "/operational-procedures",
    icon: BookOpenCheck,
    title: "Operational procedures",
    copy: "Replace tribal knowledge with one trusted, completable guide.",
  },
  {
    href: "/compliance-evidence",
    icon: Scale,
    title: "Compliance evidence",
    copy: "Show that the right people received and finished the current procedure.",
  },
  {
    href: "/software-training",
    icon: MonitorSmartphone,
    title: "Software training",
    copy: "Capture the live product path instead of a slide deck that goes stale.",
  },
];

export default function UseCasesPage() {
  return (
    <MarketingPage>
      <InfoHero
        eyebrow="Use cases"
        title="One workspace for the processes your team actually runs."
        intro="Start with a single workflow. KnowHow captures the clicks, turns them into a governed guide, and shows whether people finished it."
      />
      <section className={styles.useCaseGrid} aria-label="KnowHow use cases">
        {useCases.map(({ href, icon: Icon, title, copy }) => (
          <Link className={styles.useCaseCard} href={href} key={href}>
            <Icon aria-hidden="true" />
            <div>
              <h2>{title}</h2>
              <p>{copy}</p>
            </div>
            <span>
              Read more <ArrowRight aria-hidden="true" />
            </span>
          </Link>
        ))}
      </section>
    </MarketingPage>
  );
}
