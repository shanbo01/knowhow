import assert from "node:assert/strict";
import test from "node:test";
import { TABLES } from "../lib/server/appwrite-resources";
import { CommandService } from "../lib/server/command-service";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  decodePayload,
  type GuideRecord,
  type RevisionRecord,
} from "../lib/server/domain-records";
import { HttpError } from "../lib/server/http-security";
import { InMemoryRecordStore } from "../lib/server/record-store";
import {
  identity,
  seedWorkspace,
  seedWorkspaceMember,
} from "./helpers/appwrite-fixtures";

process.env.KNOWHOW_TOKEN_KEYS_JSON = JSON.stringify({
  test: "test-signing-secret-with-at-least-thirty-two-random-bytes",
});
process.env.KNOWHOW_TOKEN_ACTIVE_KID = "test";

const options = (suffix: string) => ({
  requestId: `request_share_${suffix}_0000000000`,
  idempotencyKey: `idempotency_share_${suffix}_0000000000`,
  reauthenticated: true,
});

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError);
    return error.code;
  }
  assert.fail("Expected command to fail.");
}

function draftPayload(workspaceId: string, extra: Record<string, unknown> = {}) {
  return {
    workspaceId,
    title: "Share first access check",
    summary: "Help teammates complete the workspace access check.",
    category: "Operations",
    tags: ["pilot"],
    systemReferences: [],
    steps: [
      {
        id: "step-1",
        kind: "action",
        title: "Open the workspace",
        description: "Confirm the dashboard is visible.",
      },
    ],
    audiences: [{ kind: "workspace", label: "Entire workspace" }],
    privacyReviewed: false,
    source: "manual",
    transition: "draft",
    ...extra,
  };
}

test("shareGuide publishes a draft and can change the live audience", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const admin = identity("admin", "admin@acme.example", "Admin");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: admin.userId,
    email: admin.email,
    roles: ["administrator", "creator"],
  });
  const service = new CommandService(store);
  const saved = (await service.execute(
    admin,
    "saveGuide",
    draftPayload(workspaceId),
    options("save"),
  )) as { guideId: string };

  const shared = await service.execute(
    admin,
    "shareGuide",
    {
      workspaceId,
      guideId: saved.guideId,
      audiences: [{ kind: "workspace", label: "Entire workspace" }],
      privacyReviewed: false,
    },
    options("share"),
  );
  assert.deepEqual(shared, { published: true });
  const publishedRow = await store.get(TABLES.guides, saved.guideId);
  assert.equal(publishedRow?.status, "published");
  const guide = decodePayload<GuideRecord>(publishedRow!, null as never);
  assert.equal(guide.workingRevisionId, null);
  assert.ok(guide.publishedRevisionId);
  const publishedRevision = decodePayload<RevisionRecord>(
    await store.get(TABLES.guideRevisions, guide.publishedRevisionId),
    null as never,
  );
  assert.ok(publishedRevision.publishedAt);
  assert.ok(publishedRevision.submittedAt);
  assert.ok(publishedRevision.reviewedAt);

  const restricted = await service.execute(
    admin,
    "shareGuide",
    {
      workspaceId,
      guideId: saved.guideId,
      audiences: [
        { kind: "user", subjectId: admin.userId, label: "Admin" },
      ],
      privacyReviewed: false,
    },
    options("audience"),
  );
  assert.deepEqual(restricted, { audienceChanged: true });
  const audiences = await store.list(TABLES.guideAudiences, {
    filters: [{ field: "subject_id", value: guide.publishedRevisionId }],
  });
  assert.equal(audiences[0]?.kind, "user");
  assert.ok(
    (await store.list(TABLES.auditSegments)).some(
      (row) => row.kind === "guide.audience-changed",
    ),
  );
});

test("creators can share their own drafts unless review is required", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const admin = identity("admin", "admin@acme.example", "Admin");
  const creator = identity("creator", "creator@acme.example", "Creator");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: admin.userId,
    email: admin.email,
    roles: ["administrator", "creator"],
  });
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: creator.userId,
    email: creator.email,
    roles: ["creator"],
  });
  const service = new CommandService(store);
  const saved = (await service.execute(
    creator,
    "saveGuide",
    draftPayload(workspaceId, { title: "Creator owned draft" }),
    options("creator-save"),
  )) as { guideId: string };

  const shared = await service.execute(
    creator,
    "shareGuide",
    {
      workspaceId,
      guideId: saved.guideId,
      audiences: [{ kind: "workspace", label: "Entire workspace" }],
    },
    options("creator-share"),
  );
  assert.deepEqual(shared, { published: true });

  await service.execute(
    admin,
    "updateWorkspaceSettings",
    {
      workspaceId,
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS,
        requireReviewBeforePublish: true,
      },
    },
    options("review-on"),
  );
  const governed = (await service.execute(
    creator,
    "saveGuide",
    draftPayload(workspaceId, { title: "Governed creator draft" }),
    options("governed-save"),
  )) as { guideId: string };
  assert.equal(
    await codeOf(
      service.execute(
        creator,
        "shareGuide",
        {
          workspaceId,
          guideId: governed.guideId,
          audiences: [{ kind: "workspace", label: "Entire workspace" }],
        },
        options("governed-share"),
      ),
    ),
    "GUIDE_REVIEW_STATE_REQUIRED",
  );
  assert.equal(
    await codeOf(
      service.execute(
        admin,
        "shareGuide",
        {
          workspaceId,
          guideId: governed.guideId,
          audiences: [{ kind: "workspace", label: "Entire workspace" }],
        },
        options("admin-bypass"),
      ),
    ),
    "DRAFT_EDITOR_REQUIRED",
  );
});

test("captured guides still require a privacy review before share", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const admin = identity("admin", "admin@acme.example", "Admin");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: admin.userId,
    email: admin.email,
    roles: ["administrator", "creator"],
  });
  const service = new CommandService(store);
  const saved = (await service.execute(
    admin,
    "saveGuide",
    draftPayload(workspaceId, {
      title: "Captured access check",
      source: "browser-capture",
    }),
    options("capture-save"),
  )) as { guideId: string };

  assert.equal(
    await codeOf(
      service.execute(
        admin,
        "shareGuide",
        {
          workspaceId,
          guideId: saved.guideId,
          audiences: [{ kind: "workspace", label: "Entire workspace" }],
          privacyReviewed: false,
        },
        options("capture-blocked"),
      ),
    ),
    "PRIVACY_REVIEW_REQUIRED",
  );

  const shared = await service.execute(
    admin,
    "shareGuide",
    {
      workspaceId,
      guideId: saved.guideId,
      audiences: [{ kind: "workspace", label: "Entire workspace" }],
      privacyReviewed: true,
    },
    options("capture-share"),
  );
  assert.deepEqual(shared, { published: true });
});
