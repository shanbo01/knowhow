"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "../marketing.module.css";

const links = [
  { href: "/#how", label: "How it works" },
  { href: "/#product", label: "Product" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/security", label: "Security" },
  { href: "/trust", label: "Trust" },
] as const;

function isActive(pathname: string, href: string) {
  if (href.startsWith("/#")) return pathname === "/";
  return pathname === href;
}

export function MarketingNav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav className={styles.nav} aria-label="Primary navigation">
      {links.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          aria-current={isActive(pathname, href) ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
