/**
 * Marketing copy that more than one surface has to agree on.
 *
 * The landing page renders it, the JSON-LD graph describes it to search
 * engines, and `/llms.txt` restates it for assistants. Keeping the three in one
 * file is what stops a plan limit from being right in the pricing table and
 * wrong in the answer a model gives about us. Every number here is the one the
 * product actually enforces — see `lib/server/commercial-plan.ts`.
 */

export const PRODUCT_NAME = "KnowHow";

export const PRODUCT_CATEGORY = "Process documentation software";

export const PRODUCT_TAGLINE =
  "Step-by-step process documentation, captured from real work.";

/**
 * The one-paragraph answer to "what is this?". Written to be quotable on its
 * own, because that is how an assistant will use it.
 */
export const PRODUCT_SUMMARY =
  "KnowHow is a private workspace where teams document how work is actually done. A capture extension for Chrome and Edge, or the Windows desktop app, records a task while someone performs it and turns those clicks and screenshots into a draft guide. The draft is edited, reviewed, and published to a chosen audience, so the next person follows a written procedure instead of asking the one colleague who remembers.";

export const PRODUCT_AUDIENCE =
  "IT, service desk, and operations teams that repeat the same procedures across a workspace.";

export type SiteLink = { readonly label: string; readonly href: string };

export const PRIMARY_CTA: SiteLink = {
  label: "Start free trial",
  href: "/start-trial",
};

export const SECONDARY_CTA: SiteLink = {
  label: "Create a free workspace",
  href: "/register",
};

export const NAV_LINKS: readonly SiteLink[] = [
  { label: "Platform", href: "/#platform" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Security", href: "/#security" },
  { label: "Pricing", href: "/#pricing" },
  { label: "FAQ", href: "/#faq" },
];

/** Verifiable product facts. No customer counts, no invented metrics. */
export const PRODUCT_FACTS: readonly { term: string; detail: string }[] = [
  {
    term: "Capture surfaces",
    detail: "Chrome and Edge extension, plus a Windows desktop app",
  },
  {
    term: "Guide lifecycle",
    detail: "Draft, in review, published, archived — every revision retained",
  },
  {
    term: "Workspace roles",
    detail: "Administrator, creator, reviewer, publisher, viewer",
  },
  {
    term: "Export formats",
    detail: "Live link and Markdown, plus PDF, HTML and PowerPoint on Pro",
  },
];

export type HowItWorksStep = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly detail: readonly string[];
};

export const HOW_IT_WORKS: readonly HowItWorksStep[] = [
  {
    id: "capture",
    title: "Do the task once, with capture running",
    summary:
      "Start KnowHow Capture and work normally. It records the clicks you make and the screens you land on, and orders them into a draft.",
    detail: [
      "Chrome and Edge through the KnowHow Capture extension",
      "Windows applications through the desktop app on Pro",
      "No clipboard contents, no raw keystrokes, and no credentials; what you type into an ordinary field is kept so the step can quote it",
    ],
  },
  {
    id: "refine",
    title: "Say the part the screenshot cannot",
    summary:
      "Steps arrive titled and illustrated. Rewrite them in your own words, add the reasoning, annotate the screenshot, and mask anything private.",
    detail: [
      "Reorder, merge, or delete captured steps",
      "Blur and redaction tools on Pro flatten masked regions into the image before upload",
      "Write a guide from scratch when there is nothing to record",
    ],
  },
  {
    id: "review",
    title: "Have someone accountable sign it off",
    summary:
      "A guide moves from draft to review to published. Reviewers request changes, publishers release it, and the workspace keeps the revision history.",
    detail: [
      "Separate creator, reviewer, and publisher roles",
      "Superseded revisions are retained, not overwritten",
      "An audit trail records who changed what, and when",
    ],
  },
  {
    id: "publish",
    title: "Put it where the next person will look",
    summary:
      "Publish to the whole workspace, a group, named people, or an unlisted link that opens without a sign-in. Readers mark a guide complete when they finish.",
    detail: [
      "Search the library by title, audience, and status",
      "Export to Markdown on every plan; PDF, HTML, and PowerPoint on Pro",
      "Optional watermarks carry the viewer, workspace, and export date",
    ],
  },
];

export type Capability = {
  readonly title: string;
  readonly body: string;
  readonly meta: string;
};

export const CAPABILITIES: readonly Capability[] = [
  {
    title: "Browser capture",
    body: "The KnowHow Capture extension pairs to Chrome or Edge with a one-use code and records a real session into a draft guide. Pairing creates a device record you can revoke.",
    meta: "Every plan",
  },
  {
    title: "Windows desktop capture",
    body: "Procedures that never touch a browser — line-of-business software, control panels, installers — are captured by the signed Windows app and land in the same library.",
    meta: "Pro and Enterprise",
  },
  {
    title: "Redaction before upload",
    body: "Mask a region in the editor and the pixels are flattened into the image in the browser. What leaves the machine is already redacted, not covered by an overlay.",
    meta: "Pro and Enterprise",
  },
  {
    title: "A library people can search",
    body: "Guides live in one workspace with groups, people, and audience filters, so a technician can find the procedure without finding the person who wrote it.",
    meta: "Every plan",
  },
  {
    title: "Publishing you control",
    body: "Each guide has an audience — workspace, group, named users, or an unlisted link — and an export policy that can require a watermark or switch file exports off entirely.",
    meta: "Every plan",
  },
  {
    title: "Exports that survive the tool",
    body: "Take a published guide out as Markdown, PDF, HTML, or PowerPoint. Documentation your team can keep is documentation nobody is locked out of.",
    meta: "Markdown free · files on Pro",
  },
];

export const SECURITY_CONTROLS: readonly {
  title: string;
  body: string;
}[] = [
  {
    title: "Capture collects less than you would expect",
    body: "Clicks, screenshots, and the text typed into ordinary fields, so a step can say what to enter. Clipboard contents and raw keystrokes are never collected, and passwords, usernames, one-time codes, card and account numbers are excluded before anything is recorded. A workspace can switch typed-text capture off for everyone.",
  },
  {
    title: "Redaction happens on the device",
    body: "Selected mask regions are filled into the screenshot in the browser before anything is uploaded.",
  },
  {
    title: "Every capture device is revocable",
    body: "Pairing uses a one-use code and creates a device record. Revoke it and that browser or machine stops capturing.",
  },
  {
    title: "The server decides what may connect",
    body: "Exact extension origins, minimum versions, and secure capture contexts are enforced server-side, not by the client.",
  },
  {
    title: "Access is role-scoped and recorded",
    body: "Administrator, creator, reviewer, publisher, and viewer roles gate what a member can do, and an audit trail records the actions that matter.",
  },
  {
    title: "Hardened by default in transit",
    body: "A strict content security policy, HSTS, nosniff, and a same-origin frame policy ship with the application itself.",
  },
];

export const USE_CASES: readonly { title: string; body: string }[] = [
  {
    title: "Employee onboarding",
    body: "Account creation, licence assignment, and device setup, written down once instead of shoulder-surfed every intake.",
  },
  {
    title: "Service desk procedures",
    body: "The fixes your first line repeats daily, captured from a real ticket so the next agent resolves it without escalating.",
  },
  {
    title: "Change and release steps",
    body: "The exact order that makes a change safe, with the screens that prove each step was performed.",
  },
  {
    title: "Software rollout and training",
    body: "Show a team the new tool with the screens they will actually see, and update the guide when the interface moves.",
  },
  {
    title: "Client and vendor handover",
    body: "Hand a customer or a successor a procedure they can follow, exported as a PDF or shared on an unlisted link.",
  },
  {
    title: "Operational evidence",
    body: "Published revisions, review history, and an audit trail give an assessor something better than a screenshot in a chat thread.",
  },
];

export type Plan = {
  readonly id: string;
  readonly name: string;
  readonly price: string;
  readonly cadence: string;
  readonly summary: string;
  readonly cta: SiteLink;
  readonly featured?: boolean;
  readonly features: readonly string[];
};

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    cadence: "forever, no card",
    summary:
      "Enough to standardize your first procedures and prove the format works.",
    cta: { label: "Create a free workspace", href: "/register" },
    features: [
      "Browser capture in Chrome and Edge",
      "Draft, review, and publish",
      "Groups, people, and unlisted share links",
      "Markdown export",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "14-day trial",
    cadence: "no payment method",
    summary:
      "The full workflow: desktop capture, privacy tooling, file exports, your branding.",
    cta: { label: "Start free trial", href: "/start-trial" },
    featured: true,
    features: [
      "Everything in Free",
      "Windows desktop capture",
      "Blur and redaction tools",
      "PDF, HTML, and PowerPoint export",
      "Your branding, KnowHow marks removed",
      "In-app support",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Talk to us",
    cadence: "invoiced offline",
    summary:
      "The same product as Pro with room for more departments, and help landing it.",
    cta: { label: "Contact us", href: "/contact" },
    features: [
      "Everything in Pro",
      "Higher member, guide, and storage limits",
      "More workspaces per organization",
      "Provisioning and rollout support",
      "On-premises deployment on request",
    ],
  },
];

/** Mirrors the enforced entitlements in `lib/server/commercial-plan.ts`. */
export const PLAN_LIMITS: readonly {
  label: string;
  free: string;
  pro: string;
  enterprise: string;
}[] = [
  { label: "Members", free: "3", pro: "100", enterprise: "1,000" },
  { label: "Guide creators", free: "1", pro: "25", enterprise: "250" },
  { label: "Guides", free: "15", pro: "1,000", enterprise: "10,000" },
  { label: "Storage", free: "1 GB", pro: "50 GB", enterprise: "500 GB" },
  { label: "Workspaces", free: "1", pro: "10", enterprise: "50" },
  {
    label: "Browser capture",
    free: "Included",
    pro: "Included",
    enterprise: "Included",
  },
  {
    label: "Windows desktop capture",
    free: "—",
    pro: "Included",
    enterprise: "Included",
  },
  {
    label: "Blur and redaction tools",
    free: "—",
    pro: "Included",
    enterprise: "Included",
  },
  {
    label: "File exports (PDF, HTML, PPTX)",
    free: "—",
    pro: "Included",
    enterprise: "Included",
  },
  {
    label: "Markdown export",
    free: "Included",
    pro: "Included",
    enterprise: "Included",
  },
  {
    label: "Remove KnowHow branding",
    free: "—",
    pro: "Included",
    enterprise: "Included",
  },
  { label: "In-app support", free: "—", pro: "Included", enterprise: "Included" },
];

export type FaqEntry = { readonly question: string; readonly answer: string };

/**
 * Also emitted as FAQPage structured data, so answers are written to stand
 * alone when a search result or an assistant quotes one without the page.
 */
export const FAQ: readonly FaqEntry[] = [
  {
    question: "What is KnowHow?",
    answer:
      "KnowHow is process documentation software. It records a task while someone performs it — in Chrome, Edge, or a Windows application — and turns the captured clicks and screenshots into a step-by-step guide that a team edits, reviews, publishes, and searches from one private workspace.",
  },
  {
    question: "How does KnowHow create a guide?",
    answer:
      "You start capture and complete the task the way you normally would. KnowHow records each meaningful action with the screen it happened on and assembles them into a draft guide with numbered steps. You then rename steps, add explanation, mask anything private, and send the draft for review before publishing.",
  },
  {
    question: "Does the capture extension record passwords or keystrokes?",
    answer:
      "No to both. Passwords, usernames, one-time codes, card and account numbers are identified and excluded before anything is recorded, and clipboard contents are never read. A keyboard shortcut is stored as the chord you pressed, such as Ctrl+S, never as the characters you typed. What the extension does keep is the text you enter into ordinary fields, so a step can say what to type; a workspace can switch that off for everyone. Regions you mask in the editor are flattened into the screenshot in the browser before the image is uploaded.",
  },
  {
    question: "Which browsers and operating systems does KnowHow support?",
    answer:
      "The KnowHow Capture extension supports Chrome and Edge on any desktop operating system. Capturing applications outside the browser requires the Windows desktop app, which is included on the Pro and Enterprise plans. Reading and editing guides only needs a modern browser.",
  },
  {
    question: "Can I capture desktop applications, not just websites?",
    answer:
      "Yes, on Pro and Enterprise. The Windows desktop app captures work in native applications and files the result in the same guide library as browser captures.",
  },
  {
    question: "What formats can a guide be exported to?",
    answer:
      "Every plan can publish a live link and export Markdown. Pro and Enterprise add PDF, HTML, and PowerPoint exports. Each guide carries an export policy, so an owner can require a watermark carrying the viewer, workspace, and export date, or disable file exports for a restricted guide.",
  },
  {
    question: "Who can see a published guide?",
    answer:
      "Whoever the guide's audience names: the whole workspace, a specific group, named individuals, or anyone holding an unlisted share link. A share link opens without a sign-in, so it suits customers and contractors; everything else stays behind workspace membership.",
  },
  {
    question: "What does KnowHow cost?",
    answer:
      "The Free plan is $0 forever and covers 3 members, 1 guide creator, 15 guides, and 1 GB of storage. Pro starts as a 14-day trial that needs no payment method and raises those limits to 100 members, 25 creators, 1,000 guides, and 50 GB while adding desktop capture, redaction tools, and file exports. Enterprise is quoted and invoiced directly.",
  },
  {
    question: "Do I need a credit card to try it?",
    answer:
      "No. Creating a Free workspace and starting the 14-day Pro trial both work without a payment method. When the trial ends, the workspace continues on the Free plan unless you arrange to keep Pro.",
  },
  {
    question: "Can KnowHow run on our own infrastructure?",
    answer:
      "KnowHow is delivered as a managed workspace by default. On-premises deployment is available to Enterprise customers on request, provisioned with your team.",
  },
];

export const DATA_POLICY_NOTE =
  "KnowHow workspaces are for ordinary business-process data. Do not capture credentials, payment details, health records, or national identity numbers.";
