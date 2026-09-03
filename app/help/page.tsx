import type { Metadata } from "next";
import { resolveSiteOrigin } from "@/lib/server/site-origin";
import { marketingPageGraph, serializeJsonLd } from "@/lib/structured-data";
import {
  ACCESS_TIERS,
  ACCESS_TIER_LABELS,
  ACCESS_TIER_SUMMARIES,
} from "@/lib/workspace-access-tiers";
import { HOW_IT_WORKS, PRODUCT_SUMMARY } from "@/lib/marketing-content";
import { InfoHero, MarketingPage } from "../components/marketing-shell";
import styles from "../marketing.module.css";

const description =
  "What KnowHow does, how a guide moves from capture to published, who can do what, and who can read it.";

export async function generateMetadata(): Promise<Metadata> {
  const origin = await resolveSiteOrigin();

  return {
    title: "How KnowHow works",
    description,
    alternates: { canonical: `${origin}/help` },
    openGraph: {
      title: "How KnowHow works | KnowHow",
      description,
      url: `${origin}/help`,
      type: "website",
    },
  };
}

/**
 * The page to send someone who has been invited into a workspace and does not
 * yet know what they are looking at.
 *
 * The lifecycle and product summary come from `marketing-content`, and the
 * access levels from `workspace-access-tiers`, so this cannot describe a
 * product or a permission model different from the one that ships — which is
 * exactly how the old role descriptions came to claim that administrators had
 * no guide access while the policy engine granted it.
 */
export default async function HelpPage() {
  const origin = await resolveSiteOrigin();

  return (
    <MarketingPage>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(
            marketingPageGraph(origin, {
              path: "/help",
              name: "How KnowHow works",
              description,
            }),
          ),
        }}
      />
      <InfoHero
        eyebrow="Help"
        title="The procedure, written down while someone does it."
        intro={PRODUCT_SUMMARY}
      />
      <section className={styles.legal}>
        <h2>The life of a guide</h2>
        <p>
          Every guide moves through the same stages. You can stop after the
          second if you are working alone — review is optional and off by
          default.
        </p>
        {HOW_IT_WORKS.map((stage, index) => (
          <div key={stage.id}>
            <h3>
              {index + 1}. {stage.title}
            </h3>
            <p>{stage.summary}</p>
            <ul>
              {stage.detail.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ))}

        <h2>Who can do what</h2>
        <p>
          Workspace access has four levels, and they stack: each one can do
          everything the level below it can, plus one more thing. You hold
          exactly one, so there is no combination to work out.
        </p>
        <ul>
          {ACCESS_TIERS.map((tier) => (
            <li key={tier}>
              <strong>{ACCESS_TIER_LABELS[tier]}</strong>{" "}
              {ACCESS_TIER_SUMMARIES[tier]}
            </li>
          ))}
        </ul>
        <p>
          Your level applies across the whole workspace. If you cannot do
          something you expect to, ask a workspace Admin to change your level —
          it takes them one click.
        </p>

        <h2>Who can read a guide</h2>
        <p>
          A level decides what you can <em>do</em>. An audience decides who can
          read a particular guide, and the two are independent: holding Creator
          does not let you read a colleague&apos;s guide unless it was shared
          with you.
        </p>
        <ul>
          <li>
            <strong>Entire workspace.</strong> Every member, including people
            who join later. For procedures anyone might need.
          </li>
          <li>
            <strong>A group.</strong> Members of that group as it changes. For
            team-specific work.
          </li>
          <li>
            <strong>Named people.</strong> Exactly the people listed. For
            something sensitive, or a one-off handover.
          </li>
          <li>
            <strong>An unlisted link.</strong> Anyone holding the link, with no
            sign-in. For contractors, vendors, and people outside the workspace.
          </li>
        </ul>
        <p>
          Until you publish, a guide is visible only to you — not to your
          teammates, and not to an Admin. Capture never shares anything by
          itself.
        </p>

        <h2>What capture records</h2>
        <p>
          Capture records the clicks you make, the screens you land on, and text
          you type into ordinary fields so a step can quote it back. It does not
          record passwords or other credentials, raw keystrokes, or clipboard
          contents.
        </p>
        <p>
          Screenshots still catch whatever happens to be on screen. Redact those
          regions while editing: masked areas are flattened into the image
          before it uploads, so the hidden pixels never reach the server and
          cannot be recovered from the stored file.
        </p>
        <p>
          Pairing the extension to your browser creates a device record. If you
          lose the machine, revoke that device from Account security and its
          capture access ends immediately.
        </p>

        <h2>Common questions</h2>
        <h3>Do I have to record something to make a guide?</h3>
        <p>
          No. Capture is the fast path, not the only one. You can write a guide
          from scratch and add screenshots by hand, which suits procedures that
          are not on a screen at all.
        </p>
        <h3>Someone left. What happens to their guides?</h3>
        <p>
          Published guides stay published — they belong to the workspace, not
          the author. An Admin suspends the person&apos;s access; their content
          and the audit history remain, and a Publisher can take over any guide
          to edit or retire it.
        </p>
        <h3>Can I edit a guide that is already live?</h3>
        <p>
          Yes. Opening it for editing returns it to draft and clears its
          audience, so nobody reads a half-rewritten procedure. Publish again
          when you are done; the previous revision is kept, not overwritten.
        </p>
        <h3>What is the difference between archiving and deleting?</h3>
        <p>
          Archiving retires a guide that is no longer current: it leaves the
          library, keeps its history, and can be brought back. Deleting is for
          something that should not exist, such as a mistaken capture.
        </p>
        <h3>How do I know whether anyone is reading these?</h3>
        <p>
          Each guide records views and completions. Many views with no
          completions usually means the guide is confusing or too long, which is
          a signal to split it.
        </p>
        <h3>Still stuck?</h3>
        <p>
          Open a support request from the sidebar in your workspace. An Admin
          sees it, and it keeps the context of what you were doing.
        </p>
      </section>
    </MarketingPage>
  );
}
