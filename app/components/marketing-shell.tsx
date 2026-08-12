import Link from "next/link";
import type { ReactNode } from "react";
import { ProductBrand } from "./product-brand";
import styles from "../marketing.module.css";

export function MarketingHeader() {
  return (
    <header className={styles.header}>
      <Link href="/" aria-label="KnowHow home"><ProductBrand compact /></Link>
      <nav aria-label="Primary navigation">
        <Link href="/how-it-works">How it works</Link>
        <Link href="/security">Security</Link>
        <Link href="/pricing">Pricing</Link>
        <Link href="/app" className={styles.signIn}>Sign in</Link>
      </nav>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className={styles.footer}>
      <ProductBrand compact />
      <span>Controlled external-pilot software. Not approved for credentials, payment, health, national-ID, or other sensitive data.</span>
      <nav><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/contact">Contact</Link></nav>
    </footer>
  );
}

export function MarketingPage({ children }: { children: ReactNode }) {
  return <main className={styles.page}><MarketingHeader />{children}<MarketingFooter /></main>;
}

export function InfoHero({ eyebrow, title, intro }: { eyebrow: string; title: string; intro: string }) {
  return (
    <section className={styles.infoHero}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1>{title}</h1>
      <p>{intro}</p>
    </section>
  );
}
