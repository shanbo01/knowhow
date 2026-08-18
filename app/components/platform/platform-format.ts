import type { AccountTag, PlatformNextAction } from "../../../lib/knowhow-types";

export const ACCOUNT_TAGS: AccountTag[] = [
  "employee",
  "investor",
  "partner",
  "beta",
  "press",
  "lifetime",
  "complimentary",
];

export function messageFromError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The operation could not be completed.";
}

export function formatDate(value?: string | null, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" as const } : {}),
  }).format(date);
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function titleCase(value: string) {
  return value
    .replace(/[-_.]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function initials(name: string, email = "") {
  const source = name.trim() || email;
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function commercialLabel(plan?: string | null) {
  if (plan === "pro_trial") return "Pro trial";
  if (plan === "pro") return "Pro";
  if (plan === "enterprise") return "Enterprise";
  if (plan === "free") return "Free";
  return titleCase(plan || "unknown");
}

export function nextActionLabel(action: PlatformNextAction) {
  if (action === "grant_trial") return "Grant 14-day Pro trial";
  if (action === "extend_trial") return "Extend trial";
  if (action === "contact_churn") return "Contact — churn risk";
  if (action === "enterprise_lead") return "Enterprise lead";
  if (action === "offer_seats") return "Offer additional seats";
  if (action === "expansion") return "Expansion opportunity";
  return "No action";
}

export function healthLabel(value?: string) {
  if (value === "at_risk") return "At risk";
  if (value === "churning") return "Churning";
  if (value === "trial") return "Trial";
  if (value === "free") return "Free";
  return "Healthy";
}
