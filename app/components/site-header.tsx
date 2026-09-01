"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BrandMarkGlyph } from "./brand-mark-glyph";
import { getAuthSession } from "../../lib/auth-client";
import { NAV_LINKS } from "../../lib/marketing-content";
import "../site-chrome.css";

/**
 * The marketing header.
 *
 * Every link is in the served HTML whether or not the menu is open — the mobile
 * panel is hidden with CSS rather than unmounted — so a crawler reads the same
 * navigation a person does. The only client-side behaviour is the menu toggle
 * and swapping the trial call to action for a workspace link once we know the
 * visitor already has a session.
 */
export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let active = true;
    void getAuthSession()
      .then((user) => {
        if (active) setSignedIn(Boolean(user));
      })
      .catch(() => {
        if (active) setSignedIn(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  return (
    <header className="site-header">
      <a className="site-skip" href="#main">
        Skip to content
      </a>
      <div className="site-header-inner">
        <Link className="site-brand" href="/" aria-label="KnowHow home">
          <span className="site-brand-mark" aria-hidden="true">
            <BrandMarkGlyph size={17} />
          </span>
          <span className="site-brand-word">knowhow</span>
        </Link>

        <nav
          id="site-navigation"
          className={`site-nav${menuOpen ? " is-open" : ""}`}
          aria-label="Primary"
        >
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <Link
            className="site-nav-quiet"
            href="/extension"
            onClick={() => setMenuOpen(false)}
          >
            Extension
          </Link>
          <Link
            className="site-nav-quiet"
            href="/contact"
            onClick={() => setMenuOpen(false)}
          >
            Contact
          </Link>
        </nav>

        <div className="site-header-actions">
          {signedIn ? (
            <Link className="site-cta" href="/app">
              Open workspace
            </Link>
          ) : (
            <>
              <Link className="site-signin" href="/login">
                Sign in
              </Link>
              <Link className="site-cta" href="/start-trial">
                Start free trial
              </Link>
            </>
          )}
          <button
            className="site-menu-button"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="site-navigation"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}
