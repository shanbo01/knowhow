import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveCommercialPlan,
  evaluate,
} from "../functions/operations/src/main.js";

test("operations worker treats expired Pro trials as Free, not deletion cases", () => {
  const expiredTrial = {
    kind: "trial",
    plan: "pro_trial",
    status: "active",
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z",
    graceDays: 7,
    retentionDays: 90,
    publicTrial: true,
    manualContract: false,
  };
  const afterExpiry = Date.parse("2026-05-02T00:00:00.000Z");
  assert.equal(effectiveCommercialPlan(expiredTrial, afterExpiry), "free");
  const result = evaluate(expiredTrial, afterExpiry);
  assert.equal(result.access, "active");
  assert.equal(result.eligible, null);
  const enterprise = {
    ...expiredTrial,
    plan: "enterprise",
    kind: "design_partner",
    publicTrial: false,
    manualContract: true,
  };
  assert.equal(evaluate(enterprise, afterExpiry).access, "deletion_pending");
});
