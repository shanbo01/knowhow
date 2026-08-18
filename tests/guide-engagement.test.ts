import assert from "node:assert/strict";
import test from "node:test";
import { BootstrapService } from "../lib/server/bootstrap-service";
import { CommandService } from "../lib/server/command-service";
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
  requestId: `request_engage_${suffix}_0000000000`,
  idempotencyKey: `idempotency_engage_${suffix}_0000000000`,
  reauthenticated: true,
});

test("guide views and anonymous reactions stay one vote per person", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const admin = identity("admin", "admin@acme.example", "Admin");
  const viewer = identity("viewer", "viewer@acme.example", "Viewer");
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
    userId: viewer.userId,
    email: viewer.email,
    roles: ["viewer"],
  });
  const service = new CommandService(store);
  const saved = (await service.execute(
    admin,
    "saveGuide",
    {
      workspaceId,
      title: "Access check",
      summary: "Confirm the dashboard is visible.",
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
    },
    options("save"),
  )) as { guideId: string };

  await service.execute(
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

  await service.execute(
    viewer,
    "recordGuideView",
    { workspaceId, guideId: saved.guideId },
    options("view-1"),
  );
  await service.execute(
    viewer,
    "recordGuideView",
    { workspaceId, guideId: saved.guideId },
    options("view-2"),
  );
  await service.execute(
    viewer,
    "recordGuideReaction",
    { workspaceId, guideId: saved.guideId, reaction: "like" },
    options("like"),
  );

  const afterLike = await new BootstrapService(store).bootstrap(
    viewer,
    workspaceId,
  );
  const liked = afterLike.activeWorkspace!.guides.find(
    (guide) => guide.id === saved.guideId,
  )!;
  assert.equal(liked.viewCount, 1);
  assert.equal(liked.likeCount, 1);
  assert.equal(liked.dislikeCount, 0);
  assert.equal(liked.viewerReaction, "like");

  await service.execute(
    viewer,
    "recordGuideReaction",
    { workspaceId, guideId: saved.guideId, reaction: "dislike" },
    options("dislike"),
  );
  const afterSwitch = await new BootstrapService(store).bootstrap(
    admin,
    workspaceId,
  );
  const switched = afterSwitch.activeWorkspace!.guides.find(
    (guide) => guide.id === saved.guideId,
  )!;
  assert.equal(switched.likeCount, 0);
  assert.equal(switched.dislikeCount, 1);
  assert.equal(switched.viewerReaction, null);

  await service.execute(
    viewer,
    "recordGuideReaction",
    { workspaceId, guideId: saved.guideId, reaction: "clear" },
    options("clear"),
  );
  const afterClear = await new BootstrapService(store).bootstrap(
    viewer,
    workspaceId,
  );
  const cleared = afterClear.activeWorkspace!.guides.find(
    (guide) => guide.id === saved.guideId,
  )!;
  assert.equal(cleared.likeCount, 0);
  assert.equal(cleared.dislikeCount, 0);
  assert.equal(cleared.viewerReaction, null);
});
