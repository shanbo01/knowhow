import type { ReactNode } from "react";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";
import styles from "../marketing.module.css";

/**
 * Chrome for the secondary marketing pages — contact, extension, privacy,
 * terms. The header and footer are the same components the landing page uses,
 * so the site presents one navigation everywhere; `styles.page` supplies the
 * light palette those pages' own sections are written against.
 */
export function MarketingPage({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page}>
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </div>
  );
}

export function InfoHero({
  eyebrow,
  title,
  intro,
}: {
  eyebrow: string;
  title: string;
  intro: string;
}) {
  return (
    <section className={styles.infoHero}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1>{title}</h1>
      <p>{intro}</p>
    </section>
  );
}
