import type { Metadata } from "next";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = {
  title: "Terms summary | KnowHow",
};

export default function TermsPage() {
  return (
    <MarketingPage>
      <InfoHero
        eyebrow="Terms summary"
        title="Use KnowHow for internal business-process guidance."
        intro="This page is an operational summary, not the signed agreement. Organizations that need a contract, DPA, or on-prem terms should contact us before putting production data in the product."
      />
      <section className={styles.legal}>
        <h2>Accounts and workspaces</h2>
        <p>
          Anyone can create an account, verify their email, and set up an
          organization on a 14-day trial. Invitations to an existing workspace
          remain exact-email, scoped, and single-use. Some companies are
          provisioned by KnowHow after a conversation.
        </p>
        <h2>Permitted use</h2>
        <p>
          KnowHow is for internal business-process workflows and ordinary
          business-process data. Credentials, regulated data, and other
          prohibited categories must not be captured.
        </p>
        <h2>Service targets</h2>
        <p>
          Internal targets are database RPO up to 24 hours and best-effort RTO
          within one business day. These are not contractual SLAs or recovery
          guarantees unless a signed agreement says otherwise.
        </p>
        <h2>Support and changes</h2>
        <p>
          In-app support carries a one-business-day response target. The
          extension and service may be updated as the product evolves.
        </p>
        <h2>Controlling documents</h2>
        <p>
          A signed agreement, DPA, acceptable-use policy, privacy notice, and
          retention schedule govern contracted organizations and supersede this
          summary.
        </p>
      </section>
    </MarketingPage>
  );
}
