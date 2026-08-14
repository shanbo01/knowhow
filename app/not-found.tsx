import Link from "next/link";
import { InfoHero, MarketingPage } from "./components/marketing-shell";
import styles from "./marketing.module.css";

export default function NotFound() {
  return (
    <MarketingPage>
      <InfoHero
        eyebrow="Page not found"
        title="That page is not in KnowHow."
        intro="The link may be out of date, or the page may have moved. Head home or start a free trial."
      />
      <section className={styles.pageCta} aria-labelledby="not-found-cta">
        <h2 id="not-found-cta">Where to go next</h2>
        <div className={styles.actions}>
          <Link href="/" className={styles.primary}>
            Back to home
          </Link>
          <Link href="/contact" className={styles.secondary}>
            Contact us
          </Link>
        </div>
      </section>
    </MarketingPage>
  );
}
