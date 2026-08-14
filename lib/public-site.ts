const DEFAULT_PUBLIC_ORIGIN = "http://localhost:3001";

export const PUBLIC_MARKETING_PATHS = [
  "/",
  "/product",
  "/how-it-works",
  "/extension",
  "/use-cases",
  "/internal-it",
  "/employee-onboarding",
  "/operational-procedures",
  "/compliance-evidence",
  "/customer-service-desk-procedures",
  "/software-training",
  "/trust",
  "/security",
  "/pricing",
  "/contact",
  "/privacy",
  "/terms",
] as const;

export function getPublicSiteOrigin(): string {
  const configured = process.env.KNOWHOW_SITE_ORIGIN?.trim();
  if (!configured) return DEFAULT_PUBLIC_ORIGIN;

  try {
    const url = new URL(configured);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return DEFAULT_PUBLIC_ORIGIN;
    }
    return url.origin;
  } catch {
    return DEFAULT_PUBLIC_ORIGIN;
  }
}
