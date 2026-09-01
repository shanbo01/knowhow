import Link from "next/link";
import { BrandMarkGlyph } from "./brand-mark-glyph";
import { DATA_POLICY_NOTE, PRODUCT_TAGLINE } from "../../lib/marketing-content";
import "../site-chrome.css";

const columns = [
  {
    heading: "Product",
    links: [
      { label: "Platform", href: "/#platform" },
      { label: "How it works", href: "/#how-it-works" },
      { label: "Capture extension", href: "/extension" },
      { label: "Security", href: "/#security" },
      { label: "Pricing", href: "/#pricing" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Where teams start", href: "/#use-cases" },
      { label: "Frequently asked questions", href: "/#faq" },
      { label: "Contact us", href: "/contact" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy notice", href: "/privacy" },
      { label: "Terms summary", href: "/terms" },
    ],
  },
  {
    heading: "Get started",
    links: [
      { label: "Create a free workspace", href: "/register" },
      { label: "Start a 14-day Pro trial", href: "/start-trial" },
      { label: "Sign in", href: "/login" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <Link className="site-brand" href="/" aria-label="KnowHow home">
            <span className="site-brand-mark" aria-hidden="true">
              <BrandMarkGlyph size={17} />
            </span>
            <span className="site-brand-word">knowhow</span>
          </Link>
          <p>{PRODUCT_TAGLINE}</p>
        </div>

        <div className="site-footer-columns">
          {columns.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2>{column.heading}</h2>
              <ul>
                {column.links.map((link) => (
                  <li key={`${column.heading}-${link.label}`}>
                    <Link href={link.href}>{link.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      <div className="site-footer-base">
        <p>© {new Date().getFullYear()} KnowHow. All rights reserved.</p>
        <p>{DATA_POLICY_NOTE}</p>
      </div>
    </footer>
  );
}
