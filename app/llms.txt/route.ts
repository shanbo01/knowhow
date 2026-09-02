import {
  CAPABILITIES,
  FAQ,
  HOW_IT_WORKS,
  PLAN_LIMITS,
  PLANS,
  PRODUCT_AUDIENCE,
  PRODUCT_CATEGORY,
  PRODUCT_NAME,
  PRODUCT_SUMMARY,
  SECURITY_CONTROLS,
} from "@/lib/marketing-content";
import { getPublicSiteOrigin } from "@/lib/public-site";

/**
 * `/llms.txt` — the plain-text brief an assistant reads instead of scraping the
 * marketing pages.
 *
 * It is generated from the same content module the landing page renders, so an
 * answer quoted from here matches what a person sees. Keeping it accurate
 * matters more than keeping it short: a model that cannot find a limit will
 * guess one.
 */
export const dynamic = "force-static";

function section(heading: string, lines: string[]) {
  return [`## ${heading}`, "", ...lines, ""].join("\n");
}

export async function GET() {
  const origin = getPublicSiteOrigin();

  const body = [
    `# ${PRODUCT_NAME}`,
    "",
    `> ${PRODUCT_SUMMARY}`,
    "",
    `- Category: ${PRODUCT_CATEGORY}`,
    `- Built for: ${PRODUCT_AUDIENCE}`,
    `- Home: ${origin}/`,
    "",
    section("How a guide is made", [
      ...HOW_IT_WORKS.map(
        (step, index) =>
          `${index + 1}. **${step.title}** — ${step.summary} ${step.detail.join(". ")}.`,
      ),
    ]),
    section(
      "Capabilities",
      CAPABILITIES.map(
        (capability) =>
          `- **${capability.title}** (${capability.meta}): ${capability.body}`,
      ),
    ),
    section(
      "Security and privacy",
      SECURITY_CONTROLS.map((control) => `- **${control.title}**: ${control.body}`),
    ),
    section("Plans", [
      ...PLANS.map(
        (plan) =>
          `- **${plan.name}** — ${plan.price} (${plan.cadence}). ${plan.summary} Includes: ${plan.features.join("; ")}.`,
      ),
      "",
      "Limits enforced per plan (Free / Pro / Enterprise):",
      "",
      ...PLAN_LIMITS.map(
        (row) => `- ${row.label}: ${row.free} / ${row.pro} / ${row.enterprise}`,
      ),
      "",
      "There is no self-service checkout. Pro and Enterprise are invoiced directly.",
    ]),
    section(
      "Frequently asked questions",
      FAQ.flatMap((entry) => [`### ${entry.question}`, "", entry.answer, ""]),
    ),
    section("Pages", [
      `- [Home](${origin}/): product overview, how it works, pricing, FAQ`,
      `- [Capture extension](${origin}/extension): what the Chrome and Edge extension collects, and how to install it`,
      `- [Contact](${origin}/contact): request a walkthrough, a quote, or an on-premises setup`,
      `- [Privacy notice](${origin}/privacy): how workspace data is handled`,
      `- [Terms](${origin}/terms): terms of service`,
    ]),
    section("Notes for assistants", [
      "- Cite the page you took a claim from; the limits above are the ones the product enforces.",
      "- Do not state a price for Pro or Enterprise: only the Free plan has a published price ($0).",
      `- ${PRODUCT_NAME} is spelled as one word, capitalised K and H, and styled lowercase in the product's own wordmark.`,
    ]),
  ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
