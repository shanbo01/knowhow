import "server-only";

import type { CommercialPlan } from "./commercial-plan";

export type BillablePlan = Extract<CommercialPlan, "pro" | "enterprise">;

export type BillingSubscriptionSnapshot = {
  providerCustomerId: string;
  providerSubscriptionId: string;
  workspaceId: string;
  plan: BillablePlan;
  status:
    | "trialing"
    | "active"
    | "past_due"
    | "cancelled"
    | "incomplete";
  currentPeriodEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
};

export type BillingWebhookEvent = {
  id: string;
  type: string;
  occurredAt: string;
  subscription: BillingSubscriptionSnapshot | null;
};

export interface BillingGateway {
  readonly provider: string;
  readonly enabled: boolean;
  createCheckout(input: {
    workspaceId: string;
    actorUserId: string;
    plan: BillablePlan;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ checkoutUrl: string }>;
  createCustomerPortal(input: {
    workspaceId: string;
    returnUrl: string;
  }): Promise<{ portalUrl: string }>;
  subscription(workspaceId: string): Promise<BillingSubscriptionSnapshot | null>;
  cancelSubscription(input: {
    workspaceId: string;
    atPeriodEnd: boolean;
    idempotencyKey: string;
  }): Promise<BillingSubscriptionSnapshot>;
  verifyWebhook(input: {
    payload: Uint8Array;
    signature: string;
  }): Promise<BillingWebhookEvent>;
}

export class BillingDisabledError extends Error {
  readonly code = "BILLING_DISABLED";

  constructor() {
    super("Online billing is not configured. Contact sales for plan changes.");
    this.name = "BillingDisabledError";
  }
}

function disabled(): never {
  throw new BillingDisabledError();
}

const disabledGateway: BillingGateway = Object.freeze({
  provider: "disabled",
  enabled: false,
  async createCheckout() {
    return disabled();
  },
  async createCustomerPortal() {
    return disabled();
  },
  async subscription() {
    return null;
  },
  async cancelSubscription() {
    return disabled();
  },
  async verifyWebhook() {
    return disabled();
  },
});

export function billingGateway(): BillingGateway {
  const provider = process.env.KNOWHOW_BILLING_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "disabled") return disabledGateway;
  throw new Error(`Unsupported billing provider: ${provider}`);
}
