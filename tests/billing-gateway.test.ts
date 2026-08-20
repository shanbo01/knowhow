import assert from "node:assert/strict";
import test from "node:test";
import {
  BillingDisabledError,
  billingGateway,
} from "../lib/server/billing-gateway";

function withProvider(provider: string | undefined) {
  const previous = process.env.KNOWHOW_BILLING_PROVIDER;
  if (provider === undefined) delete process.env.KNOWHOW_BILLING_PROVIDER;
  else process.env.KNOWHOW_BILLING_PROVIDER = provider;
  return () => {
    if (previous === undefined) delete process.env.KNOWHOW_BILLING_PROVIDER;
    else process.env.KNOWHOW_BILLING_PROVIDER = previous;
  };
}

test("the disabled billing gateway fails closed and never returns paid state", async () => {
  const restore = withProvider("disabled");
  try {
    const gateway = billingGateway();
    assert.equal(gateway.enabled, false);
    assert.equal(gateway.provider, "disabled");
    assert.equal(await gateway.subscription("workspace_test"), null);
    await assert.rejects(
      gateway.createCheckout({
        workspaceId: "workspace_test",
        actorUserId: "user_test",
        plan: "pro",
        successUrl: "https://knowhow.example/billing/success",
        cancelUrl: "https://knowhow.example/billing/cancel",
        idempotencyKey: "checkout_test",
      }),
      (error: unknown) =>
        error instanceof BillingDisabledError && error.code === "BILLING_DISABLED",
    );
    await assert.rejects(
      gateway.verifyWebhook({
        payload: new Uint8Array(),
        signature: "invalid",
      }),
      BillingDisabledError,
    );
  } finally {
    restore();
  }
});

test("unknown billing providers fail during configuration", () => {
  const restore = withProvider("not-installed");
  try {
    assert.throws(() => billingGateway(), /Unsupported billing provider/);
  } finally {
    restore();
  }
});
