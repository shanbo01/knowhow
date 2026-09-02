import type { Metadata } from "next";
import { resolveSiteOrigin } from "@/lib/server/site-origin";
import { marketingPageGraph, serializeJsonLd } from "@/lib/structured-data";
import { Camera, KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { ExtensionInstallInstructions } from "../components/extension-install-instructions";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

const description =
  "The KnowHow Capture extension for Chrome and Edge records clicks and screenshots to build a guide. It does not collect clipboard contents, raw keystrokes, passwords, or form values.";

export async function generateMetadata(): Promise<Metadata> {
  const origin = await resolveSiteOrigin();

  return {
    title: "KnowHow Capture extension",
    description,
    alternates: { canonical: `${origin}/extension` },
    openGraph: {
      title: "KnowHow Capture extension",
      description,
      url: `${origin}/extension`,
      type: "website",
    },
  };
}

export default async function ExtensionPage() {
  const origin = await resolveSiteOrigin();

  return (
    <MarketingPage>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(
            marketingPageGraph(origin, {
              path: "/extension",
              name: "KnowHow Capture extension",
              description,
            }),
          ),
        }}
      />
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
