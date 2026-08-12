import assert from "node:assert/strict";
import test from "node:test";
import { TABLES } from "../lib/server/appwrite-resources";
import { BootstrapService } from "../lib/server/bootstrap-service";
import { CommandService } from "../lib/server/command-service";
import { decodePayload } from "../lib/server/domain-records";
import { HttpError } from "../lib/server/http-security";
import { InMemoryRecordStore } from "../lib/server/record-store";
import {
  identity,
  seedWorkspace,
  seedWorkspaceMember,
} from "./helpers/appwrite-fixtures";

const options = (suffix: string) => ({
  requestId: `request_${suffix}_0000000000000000`,
  idempotencyKey: `idempotency_${suffix}_0000000000000000`,
  reauthenticated: false,
});

test("pilot onboarding is resumable and requires both data-boundary confirmations", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const member = identity("member", "member@acme.example", "Member");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: member.userId,
    email: member.email,
    roles: ["creator"],
  });
  const service = new CommandService(store);

  await assert.rejects(
    service.execute(
      member,
      "confirmOnboardingReadiness",
      {
        workspaceId,
        ordinaryDataOnly: true,
        pilotPoliciesReviewed: false,
      },
      options("missing-policy"),
    ),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "ONBOARDING_CONFIRMATION_REQUIRED",
  );

  await service.execute(
    member,
    "confirmOnboardingReadiness",
    {
      workspaceId,
      ordinaryDataOnly: true,
      pilotPoliciesReviewed: true,
    },
    options("confirmed"),
  );
  const rows = await store.list(TABLES.onboardingProgress);
  assert.equal(rows.length, 1);
  const stored = decodePayload<Record<string, unknown>>(rows[0], {});
  assert.equal(stored.ordinaryDataOnly, true);
  assert.equal(stored.pilotPoliciesReviewed, true);
  assert.equal(typeof stored.readinessConfirmedAt, "string");

  const bootstrap = await new BootstrapService(store).bootstrap(
    member,
    workspaceId,
  );
  assert.equal(bootstrap.activeWorkspace?.onboarding.steps.length, 7);
  assert.equal(
    bootstrap.activeWorkspace?.onboarding.steps[0].id,
    "workspace_readiness",
  );
  assert.equal(
    bootstrap.activeWorkspace?.onboarding.steps[0].completed,
    true,
  );
  assert.equal(bootstrap.activeWorkspace?.onboarding.completedAt, null);
});
