import Link from "next/link";
import {
  CAPABILITIES,
  FAQ,
  HOW_IT_WORKS,
  PLAN_LIMITS,
  PLANS,
  PRODUCT_FACTS,
  PRODUCT_SUMMARY,
  SECURITY_CONTROLS,
  USE_CASES,
} from "../../../lib/marketing-content";
import "./landing.css";

/**
 * The public landing page.
 *
 * Rendered entirely on the server: there is no state, no scroll listener and no
 * canvas here, so the HTML a crawler receives is the whole page. Every claim is
 * traceable to behaviour in this repository — the plan figures come from
 * `lib/server/commercial-plan.ts`, the capture guarantees from what the
 * extension actually collects.
 */
export function LandingPage() {
  return (
    <>
      <Hero />
      <Definition />
      <HowItWorks />
      <Platform />
      <Security />
      <UseCases />
      <Pricing />
      <Faq />
      <ClosingCta />
    </>
  );
}

function Hero() {
  return (
    <section className="kh-hero">
      <div className="kh-shell kh-hero-grid">
        <div className="kh-hero-copy">
          <p className="kh-eyebrow">Process documentation for IT and operations</p>
          <h1>
            Step-by-step documentation,
            <span> captured from the work itself.</span>
          </h1>
          <p className="kh-lede">
            Your team already knows how the job is done. KnowHow records one real
            run of it, turns the clicks and screens into a draft guide, and gives
            you somewhere governed to review, publish and find it again.
          </p>
          <div className="kh-hero-actions">
            <Link className="kh-button kh-button-primary" href="/start-trial">
              Start free trial
            </Link>
            <Link className="kh-button kh-button-outline" href="#how-it-works">
              See how it works
            </Link>
          </div>
          <p className="kh-hero-note">
            14-day Pro trial · no payment method · a Free plan that stays free
          </p>
        </div>

        <figure className="kh-hero-figure">
          <GuideMock />
          <figcaption>
            An illustration of a captured procedure moving through review.
          </figcaption>
        </figure>
      </div>

      <div className="kh-shell">
        <dl className="kh-facts">
          {PRODUCT_FACTS.map((fact) => (
            <div key={fact.term}>
              <dt>{fact.term}</dt>
              <dd>{fact.detail}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/** A schematic of the editor. Decorative: the page never depends on reading it. */
function GuideMock() {
  const steps = [
    { title: "Open the network console", note: "Sign in with the admin account" },
    { title: "Select the user's device", note: "Filter by the assigned owner" },
    { title: "Reissue the access profile", note: "Confirm before applying" },
  ];

  return (
    <div className="kh-mock" aria-hidden="true">
      <div className="kh-mock-bar">
        <span className="kh-mock-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="kh-mock-path">Guides / Reset a VPN access profile</span>
        <span className="kh-mock-chip">In review</span>
      </div>

      <div className="kh-mock-body">
        <div className="kh-mock-doc">
          <p className="kh-mock-kicker">Captured · 9 steps</p>
          {/* Not a heading: the mock is decorative, and a real <h3> here would
              put a level in the document outline that nothing owns. */}
          <p className="kh-mock-title">Reset a VPN access profile</p>
          {steps.map((step, index) => (
            <div className="kh-mock-step" key={step.title}>
              <span className="kh-mock-num">{`0${index + 1}`}</span>
              <span className="kh-mock-text">
                <b>{step.title}</b>
                <small>{step.note}</small>
              </span>
              <span
                className={`kh-mock-shot${index === 1 ? " is-masked" : ""}`}
              />
            </div>
          ))}
        </div>

        <aside className="kh-mock-side">
          <p className="kh-mock-side-head">This revision</p>
          <div className="kh-mock-row">
            <span>Audience</span>
            <b>Service desk</b>
          </div>
          <div className="kh-mock-row">
            <span>Reviewer</span>
            <b>Required</b>
          </div>
          <div className="kh-mock-row">
            <span>Watermark</span>
            <b>On export</b>
          </div>
          <div className="kh-mock-mask">
            <span />
            <em>Region masked before upload</em>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Definition() {
  return (
    <section className="kh-section kh-definition" aria-labelledby="what-heading">
      <div className="kh-shell kh-definition-grid">
        <div>
          <p className="kh-eyebrow">What KnowHow is</p>
          <h2 id="what-heading">
            One workspace for the procedures a team repeats.
          </h2>
        </div>
        <p className="kh-definition-body">{PRODUCT_SUMMARY}</p>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section
      className="kh-section kh-how"
      id="how-it-works"
      aria-labelledby="how-heading"
    >
      <div className="kh-shell">
        <header className="kh-section-head">
          <p className="kh-eyebrow">How it works</p>
          <h2 id="how-heading">Four steps, and the fourth one is the point.</h2>
          <p>
            Documentation fails because writing it is a second job. KnowHow moves
            the effort into the run you were already doing, then asks for the
            judgment only a person can add.
          </p>
        </header>

        <ol className="kh-steps">
          {HOW_IT_WORKS.map((step, index) => (
            <li key={step.id} id={step.id}>
              <span className="kh-step-index" aria-hidden="true">
                {`0${index + 1}`}
              </span>
              <div className="kh-step-body">
                <h3>{step.title}</h3>
                <p>{step.summary}</p>
                <ul>
                  {step.detail.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Platform() {
  return (
    <section
      className="kh-section kh-platform"
      id="platform"
      aria-labelledby="platform-heading"
    >
      <div className="kh-shell">
        <header className="kh-section-head">
          <p className="kh-eyebrow">Platform</p>
          <h2 id="platform-heading">
            Capture, editing, governance and export in one place.
          </h2>
          <p>
            Each piece exists because a documented process falls over without it:
            capture that is honest about what it collects, an editor that can hide
            what should not travel, and publishing you can point an auditor at.
          </p>
        </header>

        <div className="kh-cards">
          {CAPABILITIES.map((capability) => (
            <article className="kh-card" key={capability.title}>
              <p className="kh-card-meta">{capability.meta}</p>
              <h3>{capability.title}</h3>
              <p>{capability.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Security() {
  return (
    <section
      className="kh-section kh-security"
      id="security"
      aria-labelledby="security-heading"
    >
      <div className="kh-shell">
        <header className="kh-section-head kh-section-head-invert">
          <p className="kh-eyebrow">Security and governance</p>
          <h2 id="security-heading">
            Recording someone&rsquo;s screen is a promise. Here is ours.
          </h2>
          <p>
            Capture software earns its access or it does not get installed. These
            are the constraints the product enforces, not a policy page.
          </p>
        </header>

        <ul className="kh-controls">
          {SECURITY_CONTROLS.map((control) => (
            <li key={control.title}>
              <h3>{control.title}</h3>
              <p>{control.body}</p>
            </li>
          ))}
        </ul>

        <p className="kh-security-note">
          Read the{" "}
          <Link href="/privacy">privacy notice</Link> for how workspace data is
          handled, or the{" "}
          <Link href="/extension">capture extension page</Link> for what the
          browser add-on can and cannot see.
        </p>
      </div>
    </section>
  );
}

function UseCases() {
  return (
    <section
      className="kh-section kh-use-cases"
      id="use-cases"
      aria-labelledby="use-cases-heading"
    >
      <div className="kh-shell">
        <header className="kh-section-head">
          <p className="kh-eyebrow">Where teams start</p>
          <h2 id="use-cases-heading">
            The procedures that get asked about twice a week.
          </h2>
        </header>

        <div className="kh-use-grid">
          {USE_CASES.map((useCase) => (
            <article key={useCase.title}>
              <h3>{useCase.title}</h3>
              <p>{useCase.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section
      className="kh-section kh-pricing"
      id="pricing"
      aria-labelledby="pricing-heading"
    >
      <div className="kh-shell">
        <header className="kh-section-head">
          <p className="kh-eyebrow">Pricing</p>
          <h2 id="pricing-heading">Start free. Move up when the team does.</h2>
          <p>
            Pro and Enterprise are the same product; Enterprise buys room and
            hands-on provisioning, not different features. Trials need no payment
            method, and a workspace returns to Free rather than locking when one
            ends.
          </p>
        </header>

        <div className="kh-plans">
          {PLANS.map((plan) => (
            <article
              className={`kh-plan${plan.featured ? " is-featured" : ""}`}
              key={plan.id}
            >
              {plan.featured ? (
                <p className="kh-plan-flag">Most teams start here</p>
              ) : null}
              <h3>{plan.name}</h3>
              <p className="kh-plan-price">
                {plan.price}
                <span>{plan.cadence}</span>
              </p>
              <p className="kh-plan-summary">{plan.summary}</p>
              <Link
                className={`kh-button ${
                  plan.featured ? "kh-button-primary" : "kh-button-outline"
                }`}
                href={plan.cta.href}
              >
                {plan.cta.label}
              </Link>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="kh-table-wrap">
          <table className="kh-table">
            <caption>Plan limits and features, as enforced by the product.</caption>
            <thead>
              <tr>
                <th scope="col">Limit or feature</th>
                <th scope="col">Free</th>
                <th scope="col">Pro</th>
                <th scope="col">Enterprise</th>
              </tr>
            </thead>
            <tbody>
              {PLAN_LIMITS.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td>{row.free}</td>
                  <td>{row.pro}</td>
                  <td>{row.enterprise}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="kh-pricing-note">
          Pro and Enterprise are invoiced directly — there is no self-service
          checkout, and authorization never depends on billing state held in the
          browser. <Link href="/contact">Ask for a quote</Link> when you are ready.
        </p>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section className="kh-section kh-faq" id="faq" aria-labelledby="faq-heading">
      <div className="kh-shell">
        <header className="kh-section-head">
          <p className="kh-eyebrow">Frequently asked questions</p>
          <h2 id="faq-heading">Answers, before you have to ask for them.</h2>
        </header>

        <div className="kh-faq-grid">
          {FAQ.map((entry) => (
            <article key={entry.question}>
              <h3>{entry.question}</h3>
              <p>{entry.answer}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="kh-section kh-closing" aria-labelledby="closing-heading">
      <div className="kh-shell kh-closing-inner">
        <h2 id="closing-heading">
          The next time someone asks how, send the guide.
        </h2>
        <p>
          Capture one procedure this week. If it holds up, capture the other
          twenty — that is the whole adoption plan.
        </p>
        <div className="kh-hero-actions">
          <Link className="kh-button kh-button-primary" href="/start-trial">
            Start free trial
          </Link>
          <Link className="kh-button kh-button-outline" href="/contact">
            Talk to us
          </Link>
        </div>
        <p className="kh-hero-note">
          No payment method for the trial. The Free plan needs no card at all.
        </p>
      </div>
    </section>
  );
}
