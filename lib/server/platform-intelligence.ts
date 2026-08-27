import type { CommercialPlan } from "./commercial-plan";
import { planDisplayName } from "./commercial-plan";

export const ACCOUNT_TAGS = [
  "employee",
  "investor",
  "partner",
  "beta",
  "press",
  "lifetime",
  "complimentary",
] as const;

export type AccountTag = (typeof ACCOUNT_TAGS)[number];

export type PlatformHealth =
  | "healthy"
  | "at_risk"
  | "churning"
  | "trial"
  | "free";

export type PlatformNextAction =
  | "none"
  | "grant_trial"
  | "extend_trial"
  | "contact_churn"
  | "enterprise_lead"
  | "offer_seats"
  | "expansion";

const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
]);

const DAY = 86_400_000;
const VIP_TAGS = new Set<string>(ACCOUNT_TAGS);

export function isAccountTag(value: string): value is AccountTag {
  return (ACCOUNT_TAGS as readonly string[]).includes(value);
}

export function normalizeAccountTags(value: unknown): AccountTag[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((item): item is AccountTag => typeof item === "string" && isAccountTag(item)),
    ),
  ];
}

export function isVipAccount(tags: readonly string[] | undefined, complimentary = false) {
  if (complimentary) return true;
  return Boolean(tags?.some((tag) => VIP_TAGS.has(tag)));
}

export function emailDomain(email: string) {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

export function isConsumerEmailDomain(domain: string | null) {
  if (!domain) return true;
  return CONSUMER_EMAIL_DOMAINS.has(domain);
}

export type WorkspaceSignals = {
  workspaceId: string;
  name: string;
  organizationName: string;
  plan: CommercialPlan;
  billedPlan: CommercialPlan;
  complimentary: boolean;
  tags: AccountTag[];
  status: string;
  createdAt: string;
  expiresAt: string | null;
  trialConsumed: boolean;
  downgradedAt: string | null;
  memberCount: number;
  seatLimit: number;
  storageBytes: number;
  storageLimit: number;
  published: boolean;
  captureCount: number;
  publishCount: number;
  lastActivityAt: string | null;
  lastExtensionAt: string | null;
  paywallHits14d: number;
  corporateDomain: string | null;
  siblingCount: number;
};

export function daysUntil(iso: string | null, now: number) {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  return Math.ceil((timestamp - now) / DAY);
}

export function daysSince(iso: string | null, now: number) {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  return Math.floor((now - timestamp) / DAY);
}

export function customerHealth(signals: WorkspaceSignals, now: number): PlatformHealth {
  if (signals.plan === "pro_trial") return "trial";
  if (signals.plan === "free") return "free";
  const idle = daysSince(signals.lastActivityAt, now);
  if (idle !== null && idle >= 21) return "churning";
  if (
    (idle !== null && idle >= 14) ||
    (signals.memberCount <= 1 && signals.seatLimit >= 8)
  ) {
    return "at_risk";
  }
  return "healthy";
}

export function intentScore(signals: WorkspaceSignals, at = Date.now()) {
  const reasons: string[] = [];
  let score = 0;
  if (signals.publishCount > 0) {
    score += Math.min(20, 8 + signals.publishCount);
    reasons.push(`${signals.publishCount} published guide${signals.publishCount === 1 ? "" : "s"}`);
  }
  if (signals.captureCount > 0) {
    score += Math.min(20, signals.captureCount);
    reasons.push(`${signals.captureCount} extension capture${signals.captureCount === 1 ? "" : "s"}`);
  }
  if (signals.memberCount > 1) {
    score += 12;
    reasons.push(`${signals.memberCount} members`);
  }
  const extensionIdle = daysSince(signals.lastExtensionAt, at);
  if (extensionIdle !== null && extensionIdle <= 7) {
    score += 10;
    reasons.push("Extension used this week");
  }
  if (signals.paywallHits14d > 0) {
    score += Math.min(24, signals.paywallHits14d * 6);
    reasons.push(`Hit a Pro limit ${signals.paywallHits14d} time${signals.paywallHits14d === 1 ? "" : "s"}`);
  }
  if (signals.seatLimit > 0 && signals.memberCount / signals.seatLimit >= 0.8) {
    score += 15;
    reasons.push("Near seat capacity");
  }
  if (signals.storageLimit > 0 && signals.storageBytes / signals.storageLimit >= 0.8) {
    score += 10;
    reasons.push("Near storage capacity");
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

export function nextBestAction(
  signals: WorkspaceSignals,
  at = Date.now(),
): { action: PlatformNextAction; reason: string } {
  if (isVipAccount(signals.tags, signals.complimentary)) {
    return { action: "none", reason: "VIP or complimentary account — excluded from sales queues." };
  }
  if (signals.status !== "active") {
    return { action: "none", reason: `Workspace is ${signals.status}.` };
  }
  if (signals.corporateDomain && signals.siblingCount >= 2) {
    return {
      action: "enterprise_lead",
      reason: `${signals.siblingCount + 1} workspaces on @${signals.corporateDomain}.`,
    };
  }
  const remaining = daysUntil(signals.expiresAt, at);
  if (signals.plan === "pro_trial" && remaining !== null && remaining <= 7) {
    return {
      action: remaining <= 2 ? "extend_trial" : "none",
      reason:
        remaining <= 2
          ? `Trial ends in ${remaining} day${remaining === 1 ? "" : "s"}.`
          : `${planDisplayName(signals.plan)} — ${remaining} days left.`,
    };
  }
  if (
    signals.plan === "free" &&
    (signals.trialConsumed || signals.downgradedAt) &&
    (signals.publishCount >= 3 || signals.captureCount >= 5 || signals.memberCount >= 3 || signals.paywallHits14d >= 2)
  ) {
    const idle = daysSince(signals.lastActivityAt, at);
    if (idle === null || idle <= 45) {
      return {
        action: "grant_trial",
        reason: "Still active after Free downgrade — strong second-trial candidate.",
      };
    }
  }
  if (signals.seatLimit > 0 && signals.memberCount / signals.seatLimit >= 0.8) {
    return {
      action: "offer_seats",
      reason: `${signals.memberCount} of ${signals.seatLimit} seats used.`,
    };
  }
  if (signals.storageLimit > 0 && signals.storageBytes / signals.storageLimit >= 0.8) {
    return {
      action: "expansion",
      reason: "Storage is at or above 80% of the current allowance.",
    };
  }
  const health = customerHealth(signals, at);
  if (health === "churning" || health === "at_risk") {
    return {
      action: "contact_churn",
      reason:
        health === "churning"
          ? "No product activity in 21 days."
          : "Usage is thinning or only one seat is active.",
    };
  }
  if (signals.paywallHits14d >= 3) {
    return {
      action: "grant_trial",
      reason: `Hit a paid limit ${signals.paywallHits14d} times in 14 days.`,
    };
  }
  return { action: "none", reason: "No operator action required." };
}
