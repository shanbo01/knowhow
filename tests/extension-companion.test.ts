import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { companionGuidesFromWorkspace } from "../lib/extension-bridge";
import type { Guide } from "../lib/knowhow-types";

test("companion guides prefer the published revision and keep pending blur overlays", () => {
  const guides: Guide[] = [
    {
      id: "guide-a",
      workspaceId: "workspace-a",
      title: "Fallback title",
      status: "published",
      restricted: false,
      canEdit: true,
      canReview: false,
      canPublish: false,
      canDelete: false,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T12:00:00.000Z",
      publishedRevision: {
        id: "rev-pub",
        number: 2,
        status: "published",
        title: "Reset a helpdesk password",
        summary: "Walk the agent through Support.",
        category: "",
        tags: [],
        systemReferences: [],
        steps: [
          {
            id: "step-1",
            kind: "action",
            title: "Click Support",
            description: "Open Support from Home.",
            screenshotMediaId: "media-1",
            crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
            annotations: [
              {
                id: "click-1",
                kind: "click",
                x: 0.4,
                y: 0.5,
                width: 0.04,
                color: "#ef6f47",
              },
            ],
            redactions: [
              {
                id: "blur-1",
                x: 0.2,
                y: 0.3,
                width: 0.1,
                height: 0.05,
                applied: false,
              },
              {
                id: "blur-2",
                x: 0.8,
                y: 0.8,
                width: 0.1,
                height: 0.05,
                applied: true,
              },
            ],
          },
        ],
        audiences: [{ kind: "workspace" }],
        authorId: "user-a",
        authorName: "Ada",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z",
        source: "browser-capture",
      },
      workingRevision: {
        id: "rev-draft",
        number: 3,
        status: "draft",
        title: "Draft only",
        summary: "Should not be used while published exists.",
        category: "",
        tags: [],
        systemReferences: [],
        steps: [],
        audiences: [],
        authorId: "user-a",
        authorName: "Ada",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z",
        source: "browser-capture",
      },
    },
  ];

  const [guide] = companionGuidesFromWorkspace(guides, "helpdesk-ac3fe");
  assert.equal(guide.title, "Reset a helpdesk password");
  assert.equal(guide.href, "/w/helpdesk-ac3fe/guides/guide-a?revision=published");
  assert.equal(guide.steps[0].media?.mediaId, "media-1");
  assert.equal(guide.steps[0].media?.click?.radius, 0.04);
  assert.deepEqual(guide.steps[0].media?.redactions, [
    { x: 0.2, y: 0.3, width: 0.1, height: 0.05 },
  ]);
});

test("the extension library endpoint is a device-authenticated GET", async () => {
  const [route, service, background] = await Promise.all([
    readFile(
      new URL("../app/api/extension/[[...path]]/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../lib/server/extension-capture-service.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../extension/src/background/index.js", import.meta.url), "utf8"),
  ]);

  assert.match(route, /path.join\("\/"\) === "library"/);
  assert.match(service, /async library\(request: Request\)/);
  assert.match(service, /workspaceGuides\(/);
  assert.match(service, /companionGuidesFromWorkspace\(/);
  assert.match(background, /case "REFRESH_LIBRARY":/);
  assert.match(background, /fetchCompanionLibrary\(\)/);
});
