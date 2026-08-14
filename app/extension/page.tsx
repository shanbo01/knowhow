import type { Metadata } from "next";
import { Camera, KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { ExtensionInstallInstructions } from "../components/extension-install-instructions";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = { title: "KnowHow Capture extension" };

export default function ExtensionPage() {
  return (
    <MarketingPage>
      <InfoHero
        eyebrow="KnowHow Capture"
        title="Capture browser work without collecting the inputs."
        intro="The Chrome and Edge extension records clicks and screenshots. It does not collect clipboard contents, raw keystrokes, passwords, or form values."
      />
      <section className={styles.infoGrid}>
        <article>
          <Camera />
          <h2>Redacted before upload</h2>
          <p>
            Selected mask regions are filled in the browser before anything is
            uploaded.
          </p>
        </article>
        <article>
          <KeyRound />
          <h2>Paired per device</h2>
          <p>
            One-use pairing codes create a device record you can revoke at any
            time.
          </p>
        </article>
        <article>
          <ShieldCheck />
          <h2>Narrow access</h2>
          <p>
            Exact extension origins, minimum versions, and secure capture
            contexts are enforced server-side.
          </p>
        </article>
      </section>
      <section className={styles.policyCallout}>
        <h2>Install KnowHow Capture</h2>
        <p>
          Pair Chrome or Edge from Capture after you create a workspace. Store
          listings stay unlisted for controlled distribution. When a listing is
          not configured, download the extension and load it unpacked.
        </p>
        <ExtensionInstallInstructions actionClassName={styles.primary} />
        <p>
          After it is installed, open Capture in your workspace and choose
          Install and pair.
        </p>
        <Link className={styles.secondary} href="/login">
          Sign in to pair
        </Link>
      </section>
    </MarketingPage>
  );
}
