import type {
  CommercialPlan,
  LifecycleAccess,
  SubscriptionKind,
  SubscriptionRecord,
} from "./domain-records";

export type { CommercialPlan };

const DAY = 86_400_000;
export const PRO_TRIAL_DAYS = 14;

export type PlanEntitlements = {
  maximumUsers: number;
  maximumCreators: number;
  maximumGuides: number;
  storageBytes: number;
  extensionEnabled: boolean;
  desktopCaptureEnabled: boolean;
  supportEnabled: boolean;
  removeBranding: boolean;
  privacyToolsEnabled: boolean;
  fileExportsEnabled: boolean;
  publicSignup: boolean;
  payments: boolean;
  ssoScim: boolean;
};

export const FREE_ENTITLEMENTS: PlanEntitlements = {
  maximumUsers: 3,
  maximumCreators: 1,
  maximumGuides: 15,
  storageBytes: 1_000_000_000,
  extensionEnabled: true,
  desktopCaptureEnabled: false,
  supportEnabled: false,
  removeBranding: false,
  privacyToolsEnabled: false,
  fileExportsEnabled: false,
  publicSignup: false,
  payments: false,
  ssoScim: false,
};

export const PRO_ENTITLEMENTS: PlanEntitlements = {
  maximumUsers: 100,
  maximumCreators: 25,
  maximumGuides: 1_000,
  storageBytes: 50_000_000_000,
  extensionEnabled: true,
  desktopCaptureEnabled: true,
  supportEnabled: true,
  removeBranding: true,
  privacyToolsEnabled: true,
  fileExportsEnabled: true,
  publicSignup: false,
  payments: false,
  ssoScim: false,
};

export const ENTERPRISE_ENTITLEMENTS: PlanEntitlements = {
  ...PRO_ENTITLEMENTS,
  maximumUsers: 1_000,
  maximumCreators: 250,
  maximumGuides: 10_000,
  storageBytes: 500_000_000_000,
};

/**
 * Workspaces an organization may hold, by its best workspace plan. A trial is
 * deliberately capped at one: admin-created workspaces would otherwise be a way
 * to keep spawning fresh trials.
 */
export const WORKSPACES_PER_PLAN: Record<CommercialPlan, number> = {
  free: 1,
  pro_trial: 1,
  pro: 10,
  enterprise: 50,
};

/**
 * Commercial standing, which is not the same order as workspace slots: Free and
 * a Pro trial both grant one workspace, but a trial is the better plan to name
 * when describing an account.
 */
export const PLAN_RANK: Record<CommercialPlan, number> = {
  free: 0,
  pro_trial: 1,
  pro: 2,
  enterprise: 3,
};

export function bestCommercialPlan(plans: CommercialPlan[]): CommercialPlan {
  return plans.reduce<CommercialPlan>(
    (carry, plan) => (PLAN_RANK[plan] > PLAN_RANK[carry] ? plan : carry),
    "free",
  );
}

export function isCommercialPlan(value: unknown): value is CommercialPlan {
  return (
    value === "free" ||
    value === "pro_trial" ||
    value === "pro" ||
    value === "enterprise"
  );
}

export function entitlementsForPlan(plan: CommercialPlan): PlanEntitlements {
  if (plan === "free") return { ...FREE_ENTITLEMENTS };
  if (plan === "enterprise") return { ...ENTERPRISE_ENTITLEMENTS };
  return { ...PRO_ENTITLEMENTS };
}

function validDate(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hasSimulationState(subscription: SubscriptionRecord) {
  return (
    typeof (subscription as { simulationState?: unknown }).simulationState ===
    "string"
  );
}

export function inferredCommercialPlan(
  subscription: Pick<SubscriptionRecord, "kind" | "manualContract"> & {
    plan?: CommercialPlan;
  },
): CommercialPlan {
  if (isCommercialPlan(subscription.plan)) return subscription.plan;
  if (subscription.kind === "paid") return "pro";
  if (subscription.kind === "design_partner") return "enterprise";
  if (subscription.kind === "trial" && subscription.manualContract) {
    return "enterprise";
  }
  return "pro_trial";
}

export function isRetainLifecycle(subscription: SubscriptionRecord) {
  if (hasSimulationState(subscription)) return true;
  return inferredCommercialPlan(subscription) === "enterprise";
}

export function trialConsumed(subscription: SubscriptionRecord) {
  if (subscription.trialConsumed === true) return true;
  if (subscription.trialConsumed === false) return false;
  const plan = inferredCommercialPlan(subscription);
  return plan !== "free";
}

export function effectiveCommercialPlan(
  subscription: SubscriptionRecord | null,
  now = new Date(),
): CommercialPlan {
  if (!subscription) return "free";
  const stored = inferredCommercialPlan(subscription);
  if (isRetainLifecycle(subscription) || stored === "enterprise") {
    return stored === "free" ? "enterprise" : stored;
  }
  if (stored === "free") return "free";
  const expiry = validDate(subscription.expiresAt);
  if (stored === "pro_trial") {
    if (expiry === null || now.getTime() < expiry) return "pro_trial";
    return "free";
  }
  if (stored === "pro") {
    if (expiry === null || now.getTime() < expiry) return "pro";
    const graceDays = Math.max(0, Math.min(30, subscription.graceDays));
    const graceEnd = expiry + graceDays * DAY;
    if (now.getTime() < graceEnd) return "pro";
    return "free";
  }
  return stored;
}

export function subscriptionKindForPlan(plan: CommercialPlan): SubscriptionKind {
  if (plan === "enterprise") return "design_partner";
  if (plan === "pro") return "paid";
  return "trial";
}

export type WorkspaceSubscriptionView = {
  plan: CommercialPlan;
  billedPlan: CommercialPlan;
  kind: SubscriptionKind;
  status: string;
  access: LifecycleAccess;
  expiresAt: string | null;
  graceEndsAt: string | null;
  deletionEligibleAt: string | null;
  renewsAt: string | null;
  trialConsumed: boolean;
  pastDue: boolean;
};

export function toWorkspaceSubscriptionView(
  subscription: SubscriptionRecord | null,
  evaluation: {
    access: LifecycleAccess;
    expiresAt: string | null;
    graceEndsAt: string | null;
    deletionEligibleAt: string | null;
  },
  now = new Date(),
): WorkspaceSubscriptionView | undefined {
  if (!subscription) return undefined;
  const billedPlan = inferredCommercialPlan(subscription);
  const plan = effectiveCommercialPlan(subscription, now);
  const expiry = validDate(subscription.expiresAt);
  const pastDue =
    billedPlan === "pro" &&
    plan === "pro" &&
    expiry !== null &&
    now.getTime() >= expiry;
  return {
    plan,
    billedPlan,
    kind: subscription.kind,
    status: subscription.status,
    access: evaluation.access,
    expiresAt: evaluation.expiresAt,
    graceEndsAt: evaluation.graceEndsAt,
    deletionEligibleAt: isRetainLifecycle(subscription)
      ? evaluation.deletionEligibleAt
      : null,
    renewsAt: evaluation.expiresAt,
    trialConsumed: trialConsumed(subscription),
    pastDue,
  };
}

export function planDisplayName(plan: CommercialPlan) {
  if (plan === "pro_trial") return "Pro trial";
  if (plan === "pro") return "Pro";
  if (plan === "enterprise") return "Enterprise";
  return "Free";
}
