"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "../marketing.module.css";

const links = [
  { href: "/product", label: "Product" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/use-cases", label: "Use cases" },
  { href: "/trust", label: "Trust" },
  { href: "/pricing", label: "Pricing" },
] as const;

function isActive(pathname: string, href: string) {
  if (href === "/use-cases") {
    return (
      pathname === "/use-cases" ||
      pathname === "/internal-it" ||
      pathname === "/employee-onboarding" ||
      pathname === "/customer-service-desk-procedures" ||
      pathname === "/operational-procedures" ||
      pathname === "/compliance-evidence" ||
      pathname === "/software-training"
    );
  }
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
