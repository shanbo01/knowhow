import assert from "node:assert/strict";
import test from "node:test";
import type { Audience, EditorBlock } from "../lib/knowhow-types";
import {
  rowData,
  type GuideRecord,
  type RevisionRecord,
} from "../lib/server/domain-records";
import { searchAuthorizedGuides } from "../lib/server/guide-search-service";
import { HttpError } from "../lib/server/http-security";
import { TABLES } from "../lib/server/appwrite-resources";
import { InMemoryRecordStore } from "../lib/server/record-store";
import {
  identity,
  seedWorkspace,
  seedWorkspaceMember,
} from "./helpers/appwrite-fixtures";

async function seedGuide(
  store: InMemoryRecordStore,
  input: {
    organizationId: string;
    workspaceId: string;
    guideId: string;
    revisionId: string;
    authorId: string;
    status: "draft" | "published";
    title: string;
    summary: string;
    step: string;
    audience?: Audience;
  },
) {
  const now = "2026-08-01T00:00:00.000Z";
  const guide: GuideRecord = {
    title: input.title,
    slug: input.guideId,
    authorUserId: input.authorId,
    publishedRevisionId:
      input.status === "published" ? input.revisionId : null,
    workingRevisionId: input.status === "draft" ? input.revisionId : null,
    screenshotsLockedAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const revision: RevisionRecord = {
    guideId: input.guideId,
    number: 1,
    status: input.status,
    title: input.title,
    summary: input.summary,
    category: "Internal IT",
    tags: [input.status],
    systemReferences: [],
    authorId: input.authorId,
    createdAt: now,
    updatedAt: now,
    ...(input.status === "published"
      ? {
          submittedBy: input.authorId,
          submittedAt: now,
          reviewedBy: input.authorId,
          reviewedAt: now,
          publishedBy: input.authorId,
          publishedAt: now,
        }
      : {}),
    source: "manual",
  };
  await store.create(
    TABLES.guides,
    input.guideId,
    rowData(
      {
        organization_id: input.organizationId,
        workspace_id: input.workspaceId,
        slug: guide.slug,
        status: input.status,
        created_by: input.authorId,
      },
      guide,
    ),
  );
  await store.create(
    TABLES.guideRevisions,
    input.revisionId,
    rowData(
      {
        organization_id: input.organizationId,
        workspace_id: input.workspaceId,
        subject_id: input.guideId,
        status: input.status,
        version: 1,
        created_by: input.authorId,
      },
      revision,
    ),
  );
  const block: EditorBlock = {
    id: `step_${input.guideId}`,
    kind: "action",
    title: input.step,
    description: `${input.step} using the approved console.`,
  };
  await store.create(
    TABLES.guideSteps,
    block.id,
    rowData(
      {
        organization_id: input.organizationId,
        workspace_id: input.workspaceId,
        subject_id: input.revisionId,
        sequence: 1,
        kind: "action",
        status: input.status,
      },
      block,
    ),
  );
  if (input.audience) {
    await store.create(
      TABLES.guideAudiences,
      `audience_${input.guideId}`,
      rowData(
        {
          organization_id: input.organizationId,
          workspace_id: input.workspaceId,
          subject_id: input.revisionId,
          user_id: input.audience.subjectId ?? null,
          kind: input.audience.kind,
          status: "active",
        },
        input.audience,
      ),
    );
  }
}

async function searchFixture() {
  const store = new InMemoryRecordStore();
  const first = await seedWorkspace(store, {
    organizationId: "org_one",
    workspaceId: "workspace_one",
  });
  const second = await seedWorkspace(store, {
    organizationId: "org_two",
    workspaceId: "workspace_two",
  });
  const viewer = identity("viewer", "viewer@one.example", "Viewer");
  const engineer = identity(
    "engineer",
    "engineer@one.example",
    "Engineer",
  );
  await seedWorkspaceMember(store, {
    ...first,
    userId: viewer.userId,
    email: viewer.email,
    roles: ["viewer"],
  });
  await seedWorkspaceMember(store, {
    ...first,
    userId: engineer.userId,
    email: engineer.email,
    roles: ["creator"],
  });
  await seedWorkspaceMember(store, {
    ...second,
    userId: viewer.userId,
    email: viewer.email,
    roles: ["viewer"],
  });
  await store.create(
    TABLES.workspaceGroups,
    "group_engineers",
    rowData(
      {
        organization_id: first.organizationId,
        workspace_id: first.workspaceId,
        slug: "engineers",
        kind: "custom",
        status: "active",
      },
      {
        name: "Engineers",
        description: "Engineering only",
        sensitive: true,
        kind: "custom",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ),
  );
  await store.create(
    TABLES.groupMemberships,
    "group_engineers_engineer",
    rowData(
      {
        organization_id: first.organizationId,
        workspace_id: first.workspaceId,
        subject_id: "group_engineers",
        user_id: engineer.userId,
        status: "active",
      },
      {},
    ),
  );
  await seedGuide(store, {
    ...first,
    guideId: "guide_onboarding",
    revisionId: "revision_onboarding",
    authorId: engineer.userId,
    status: "published",
    title: "Employee onboarding",
    summary: "How new joiners start.",
    step: "Create a user account",
    audience: { kind: "workspace" },
  });
  await seedGuide(store, {
    ...first,
    guideId: "guide_engineers",
    revisionId: "revision_engineers",
    authorId: engineer.userId,
    status: "published",
    title: "Engineers recovery runbook",
    summary: "Restricted production recovery.",
    step: "Recover the private vault",
    audience: {
      kind: "group",
      subjectId: "group_engineers",
      label: "Engineers",
    },
  });
  await seedGuide(store, {
    ...first,
    guideId: "guide_draft",
    revisionId: "revision_draft",
    authorId: engineer.userId,
    status: "draft",
    title: "Vendor negotiation draft",
    summary: "Unpublished pricing thought.",
    step: "Negotiate the private contract",
  });
  await seedGuide(store, {
    ...second,
    guideId: "guide_other_tenant",
    revisionId: "revision_other_tenant",
    authorId: "other-author",
    status: "published",
    title: "Other tenant onboarding",
    summary: "Content belonging to another organization.",
    step: "Create a user in the other tenant",
    audience: { kind: "workspace" },
  });
  return { store, first, second, viewer, engineer };
}

test("search never reveals restricted, draft, or cross-tenant content", async () => {
  const { store, first, second, viewer } = await searchFixture();
  const visible = await searchAuthorizedGuides(
    store,
    viewer,
    first.workspaceId,
    "create user",
  );
  assert.deepEqual(visible.map((result) => result.guideId), [
    "guide_onboarding",
  ]);
  assert.match(visible[0].excerpt.toLowerCase(), /create a user/);
  assert.deepEqual(
    await searchAuthorizedGuides(
      store,
      viewer,
      first.workspaceId,
      "engineers recovery",
    ),
    [],
  );
  assert.deepEqual(
    await searchAuthorizedGuides(
      store,
      viewer,
      first.workspaceId,
      "vendor negotiation",
    ),
    [],
  );
  const other = await searchAuthorizedGuides(
    store,
    viewer,
    second.workspaceId,
    "create user",
  );
  assert.deepEqual(other.map((result) => result.guideId), [
    "guide_other_tenant",
  ]);
});

test("group members see their restricted guide and creators see only their own draft", async () => {
  const { store, first, engineer, viewer } = await searchFixture();
  const restricted = await searchAuthorizedGuides(
    store,
    engineer,
    first.workspaceId,
    "engineers recovery",
  );
  assert.deepEqual(restricted.map((result) => result.guideId), [
    "guide_engineers",
  ]);
  assert.equal(restricted[0].restricted, true);
  assert.deepEqual(
    (
      await searchAuthorizedGuides(
        store,
        engineer,
        first.workspaceId,
        "vendor negotiation",
      )
    ).map((result) => result.guideId),
    ["guide_draft"],
  );
  await assert.rejects(
    searchAuthorizedGuides(store, viewer, "workspace_missing", "create user"),
    (error: unknown) =>
      error instanceof HttpError && error.code === "WORKSPACE_NOT_FOUND",
  );
});

test("search rejects empty, one-character, and oversized terms", async () => {
  const { store, first, viewer } = await searchFixture();
  for (const query of ["", "x", "x ".repeat(151)]) {
    await assert.rejects(
      searchAuthorizedGuides(store, viewer, first.workspaceId, query),
      (error: unknown) =>
        error instanceof HttpError && error.code === "SEARCH_QUERY_INVALID",
    );
  }
});
