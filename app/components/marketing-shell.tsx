import Link from "next/link";
import type { ReactNode } from "react";
import { MarketingNav } from "./marketing-nav";
import { ProductBrand } from "./product-brand";
import styles from "../marketing.module.css";

export function MarketingHeader() {
  return (
    <header className={styles.header}>
      <Link className={styles.brandLink} href="/" aria-label="KnowHow home">
        <ProductBrand compact />
      </Link>
      <MarketingNav />
      <div className={styles.navActions}>
        <Link href="/login" className={styles.signIn}>
          Sign in
        </Link>
        <Link href="/start-trial" className={styles.createAccount}>
          Start free trial
        </Link>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerBrand}>
        <ProductBrand compact />
        <p>Clear, governed process knowledge for teams that run the work.</p>
      </div>
      <nav className={styles.footerLinks} aria-label="Footer navigation">
        <div>
          <strong>Product</strong>
          <Link href="/#product">Product</Link>
          <Link href="/#how">How it works</Link>
          <Link href="/extension">Capture extension</Link>
          <Link href="/#pricing">Pricing</Link>
        </div>
        <div>
          <strong>Company</strong>
          <Link href="/trust">Trust</Link>
          <Link href="/security">Security</Link>
          <Link href="/contact">Contact</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </div>
      </nav>
      <p className={styles.footerNote}>
        Private workspaces for ordinary business-process data. Do not submit
        credentials, payment, health, national-ID, or other sensitive data.
      </p>
    </footer>
  );
}

export function MarketingPage({ children }: { children: ReactNode }) {
  return (
    <main className={styles.page}>
      <MarketingHeader />
      {children}
      <MarketingFooter />
    </main>
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
