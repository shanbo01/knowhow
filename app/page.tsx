import {
  ArrowRight,
  CheckCircle2,
  PanelsTopLeft,
  FileCheck2,
  LockKeyhole,
  MousePointer2,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { ProductBrand } from "./components/product-brand";
import styles from "./marketing.module.css";

const outcomes = [
  "Capture a real browser workflow without recording credentials or form values.",
  "Turn each capture into an owned, reviewed, audience-scoped standard.",
  "See publication, views, and teammate completion without exposing guide content to operators.",
];

export default function MarketingHome() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" aria-label="KnowHow home"><ProductBrand compact /></Link>
        <nav aria-label="Primary navigation">
          <Link href="#workflow">How it works</Link>
          <Link href="#security">Security</Link>
          <Link href="#pricing">Pricing</Link>
          <Link href="/app" className={styles.signIn}>Sign in</Link>
        </nav>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Governed process knowledge for internal IT</p>
          <h1>Turn the way work gets done into a standard your team can trust.</h1>
          <p className={styles.lede}>
            KnowHow captures browser workflows, gives owners a focused review path, and proves that the right people received the published procedure.
          </p>
          <div className={styles.actions}>
            <Link href="/request-pilot" className={styles.primary}>Request a pilot <ArrowRight /></Link>
            <Link href="/request-demo" className={styles.secondary}>Request a demo</Link>
          </div>
          <p className={styles.pilotNote}>Invitation-only design-partner pilots · Frankfurt-hosted · ordinary business-process data only</p>
        </div>
        <div className={styles.heroPanel} aria-label="KnowHow workflow preview">
          <div className={styles.previewHeader}><span /><span /><span /><strong>Employee onboarding</strong></div>
          <div className={styles.previewBody}>
            <aside><small>GUIDE</small><b>Prepare a new starter</b><span className={styles.live}>Published</span></aside>
            <ol>
              <li><span>1</span><div><b>Open the identity console</b><small>Use the approved administrator profile.</small></div></li>
              <li><span>2</span><div><b>Create the employee record</b><small>Required fields are highlighted.</small></div></li>
              <li><span>3</span><div><b>Confirm access groups</b><small>Review the standard assignment set.</small></div></li>
            </ol>
          </div>
          <footer><ShieldCheck /> Privacy reviewed <span>·</span> 12 teammates completed</footer>
        </div>
      </section>

      <section className={styles.trustStrip} aria-label="Pilot principles">
        <span><LockKeyhole /> Server-only customer content</span>
        <span><Users /> Workspace-scoped access</span>
        <span><FileCheck2 /> Review and audit receipts</span>
      </section>

      <section className={styles.section} id="workflow">
        <div className={styles.sectionIntro}>
          <p className={styles.eyebrow}>Capture → Standardize → Prove</p>
          <h2>Documentation that follows the work, then earns trust.</h2>
        </div>
        <div className={styles.threeColumn}>
          <article><MousePointer2 /><span>01</span><h3>Capture</h3><p>Record the steps in Chrome or Edge. Selected masks are applied irreversibly before screenshots leave the browser.</p></article>
          <article><FileCheck2 /><span>02</span><h3>Standardize</h3><p>Edit the draft, choose its audience, assign review, and publish one controlled revision.</p></article>
          <article><CheckCircle2 /><span>03</span><h3>Prove</h3><p>Track adoption and completion with content-free analytics and tamper-evident audit history.</p></article>
        </div>
      </section>

      <section className={`${styles.section} ${styles.useCase}`}>
        <div>
          <p className={styles.eyebrow}>Built for internal IT</p>
          <h2>Keep operational knowledge useful without turning it into a new risk.</h2>
          <p>Give service desk, application, and operations teams a shared publishing workflow while each workspace retains control of its members, screenshots, and restricted audiences.</p>
        </div>
        <ul>{outcomes.map((outcome) => <li key={outcome}><CheckCircle2 />{outcome}</li>)}</ul>
      </section>

      <section className={styles.section} id="security">
        <div className={styles.securityCard}>
          <div><ShieldCheck /><p className={styles.eyebrow}>Security fundamentals are included</p><h2>Private by architecture, not by a sharing toggle.</h2></div>
          <p>Verified identities, administrator MFA, tenant-scoped authorization, private Appwrite Storage, short-lived extension access, customer-approved support, and append-only audit sequencing form the pilot baseline.</p>
          <Link href="/security">Read the security overview <ArrowRight /></Link>
        </div>
        <div className={styles.extensionCard}>
          <PanelsTopLeft />
          <h3>KnowHow Capture</h3>
          <p>An unlisted Chrome and Edge extension with narrow permissions, device revocation, automatic updates, and no clipboard or raw-keystroke capture.</p>
          <Link href="/extension">Explore the extension</Link>
        </div>
      </section>

      <section className={`${styles.section} ${styles.pricing}`} id="pricing">
        <div><p className={styles.eyebrow}>Pricing principles</p><h2>One base workspace, then usage that follows adoption.</h2></div>
        <p>Plans will combine a workspace subscription with included active users, creators, storage, and service entitlements. Security fundamentals stay included. Design-partner terms are agreed directly; public numeric pricing and self-service payment are not live during the pilot.</p>
        <Link href="/contact" className={styles.secondary}>Contact for pricing</Link>
      </section>

      <section className={styles.finalCta}>
        <p className={styles.eyebrow}>Design-partner pilot</p>
        <h2>Bring one department and one workflow worth improving.</h2>
        <p>We will configure the workspace with you, invite the first team, and rehearse capture through completion before real pilot use.</p>
        <div className={styles.actions}>
          <Link href="/request-pilot" className={styles.primary}>Request a pilot <ArrowRight /></Link>
          <Link href="/request-demo" className={styles.secondary}>Request a demo</Link>
        </div>
      </section>

      <footer className={styles.footer}>
        <ProductBrand compact />
        <span>Controlled external-pilot software. Not approved for credentials, payment, health, national-ID, or other sensitive data.</span>
        <nav><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/contact">Contact</Link></nav>
      </footer>
    </main>
  );
}
