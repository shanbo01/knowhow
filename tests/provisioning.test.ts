import assert from "node:assert/strict";
import test from "node:test";
import { TABLES } from "../lib/server/appwrite-resources";
import { CommandService } from "../lib/server/command-service";
import { decodePayload, rowData } from "../lib/server/domain-records";
import {
  InMemoryRecordStore,
  RecordConflictError,
  type RecordStore,
} from "../lib/server/record-store";
import { identity } from "./helpers/appwrite-fixtures";

process.env.KNOWHOW_TOKEN_KEYS_JSON = JSON.stringify({
  test: "test-signing-secret-with-at-least-thirty-two-random-bytes",
});
process.env.KNOWHOW_TOKEN_ACTIVE_KID = "test";

const options = (suffix: string) => ({
  requestId: `request_provision_${suffix}_0000000000`,
  idempotencyKey: `idempotency_provision_${suffix}_0000000000`,
  reauthenticated: true,
});

function conflictOnce(store: InMemoryRecordStore) {
  let conflicts = 0;
  const wrapped = new Proxy<RecordStore>(store, {
    get(target, property) {
      if (property === "transaction") {
        return async <T>(work: (transaction: RecordStore) => Promise<T>) =>
          target.transaction(async (transaction) => {
            const result = await work(transaction);
            if (conflicts === 0) {
              conflicts += 1;
              throw new RecordConflictError();
            }
            return result;
          });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store: wrapped, conflictCount: () => conflicts };
}

test("provisioning completes the final wizard step atomically and retries one transient conflict", async () => {
  const store = new InMemoryRecordStore();
  const operator = identity(
    "platform-owner",
    "platform-owner@knowhow.test",
    "Platform Owner",
  );
  await store.create(
    TABLES.platformRoles,
    "platform_owner",
    rowData(
      {
        user_id: operator.userId,
        kind: "owner",
        status: "active",
        created_by: "seed",
      },
      { role: "owner" },
    ),
  );

  const service = new CommandService(store);
  const first = (await service.execute(
    operator,
    "saveProvisioningRun",
    {
      step: 1,
      data: {
        legalName: "Local QA LLC",
        displayName: "Local QA",
        primaryContactName: "Local Owner",
        primaryContactEmail: operator.email,
        country: "QA",
      },
    },
    options("identity"),
  )) as { runId: string };
  await store.create(
    TABLES.privateMedia,
    "logo_local_qa",
    rowData(
      {
        workspace_id: first.runId,
        user_id: operator.userId,
        subject_id: first.runId,
        status: "staged",
        kind: "provisioning-logo",
        created_by: operator.userId,
      },
      { objectKey: "local-qa/logo.png" },
    ),
  );

  const steps: Array<[number, Record<string, unknown>]> = [
    [2, { accentColor: "#c45528", logoMediaId: "logo_local_qa" }],
    [
      3,
      {
        workspaces: [
          {
            name: "Local QA Workspace",
            administratorEmails: [operator.email],
          },
        ],
      },
    ],
    [
      4,
      {
        pilotStart: "2026-08-13",
        pilotEnd: "2026-09-12",
        maximumUsers: 100,
        maximumCreators: 25,
        storageBytes: 5_000_000_000,
      },
    ],
    [
      5,
      {
        initialOwnerEmails: [operator.email, "backup-owner@knowhow.test"],
      },
    ],
  ];
  for (const [step, data] of steps) {
    await service.execute(
      operator,
      "saveProvisioningRun",
      { runId: first.runId, step, data },
      options(`step-${step}`),
    );
  }

  const transient = conflictOnce(store);
  const result = (await new CommandService(transient.store).execute(
    operator,
    "completeProvisioningRun",
    { runId: first.runId, finalStepData: { teamInvitations: [] } },
    options("complete"),
  )) as {
    organizationId: string;
    workspaceId: string;
    runId: string;
  };

  assert.equal(transient.conflictCount(), 1);
  assert.equal(result.runId, first.runId);
  assert.ok(result.organizationId.startsWith("org_"));
  assert.ok(result.workspaceId.startsWith("workspac_"));
  assert.equal((await store.list(TABLES.organizations)).length, 1);
  assert.equal((await store.list(TABLES.workspaces)).length, 1);
  const run = await store.get(TABLES.provisioningRuns, first.runId);
  assert.equal(run?.status, "completed");
  const stored = run
    ? decodePayload<{ completedSteps?: number[] }>(run, {})
    : {};
  assert.deepEqual(stored.completedSteps, [1, 2, 3, 4, 5, 6]);
});
