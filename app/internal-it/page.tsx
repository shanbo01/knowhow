import type { Metadata } from "next";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "KnowHow for internal IT" };

export default function InternalItPage() {
  return <MarketingPage><InfoHero eyebrow="Internal IT operations" title="Keep procedures current, controlled, and useful at the moment of work." intro="Service desk, application, identity, and operations teams can share one publishing discipline while workspace boundaries keep customer content out of platform and organization administration." /><section className={styles.policyCallout}><h2>A focused first pilot</h2><p>Choose one department and one repeatable workflow, invite the people who perform and review it, then rehearse capture through teammate completion before using ordinary customer business-process data.</p></section></MarketingPage>;
}
