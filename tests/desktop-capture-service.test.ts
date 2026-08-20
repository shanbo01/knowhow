import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { TABLES } from "../lib/server/appwrite-resources";
import { DesktopAuthService } from "../lib/server/desktop-auth-service";
import { DesktopCaptureService } from "../lib/server/desktop-capture-service";
import {
  decodePayload,
  rowData,
  type RevisionRecord,
} from "../lib/server/domain-records";
import { HttpError } from "../lib/server/http-security";
import { InMemoryPrivateObjectStore } from "../lib/server/private-object-store";
import { InMemoryRecordStore } from "../lib/server/record-store";
import { identity, seedWorkspace, seedWorkspaceMember } from "./helpers/appwrite-fixtures";

process.env.KNOWHOW_TOKEN_KEYS_JSON = JSON.stringify({
  test: "test-device-signing-secret-with-at-least-thirty-two-bytes",
});
process.env.KNOWHOW_TOKEN_ACTIVE_KID = "test";
process.env.KNOWHOW_DESKTOP_MIN_VERSION = "0.1.0";
process.env.KNOWHOW_PUBLIC_APP_ORIGIN = "https://knowhow.example";

const author = identity(
  "desktop-capture-author",
  "desktop.capture@acme.example",
  "Desktop Capture Author",
);

function jsonRequest(
  path: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
  token?: string,
  headers: HeadersInit = {},
) {
  return new Request(`https://knowhow.example${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function pairedDesktopFixture() {
  const store = new InMemoryRecordStore();
  const objects = new InMemoryPrivateObjectStore();
  const { organizationId, workspaceId } = await seedWorkspace(store, {
    subscription: { expiresAt: null, kind: "paid" },
  });
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: author.userId,
    email: author.email,
    roles: ["creator"],
  });
  await store.create(
    TABLES.entitlements,
    "entitlement_desktop_capture_service",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        kind: "desktopCaptureEnabled",
        status: "active",
      },
      { value: true },
    ),
  );

  const auth = new DesktopAuthService(store);
  const verifier = "E".repeat(43);
  const authorization = await auth.createAuthorization(
    jsonRequest(
      "/api/desktop/v1/authorizations",
      "POST",
      {
        deviceId: "windows-device-capture-0001",
        deviceName: "Capture workstation",
        architecture: "x64",
        desktopVersion: "0.1.0",
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        codeChallengeMethod: "S256",
      },
      undefined,
      { "idempotency-key": "desktop-capture-service-authorization" },
    ),
  );
  await auth.approveAuthorization(author, workspaceId, authorization.authorizationId);
  const paired = await auth.token(
    jsonRequest(
      `/api/desktop/v1/authorizations/${authorization.authorizationId}/token`,
      "POST",
      {
        codeVerifier: verifier,
        deviceId: "windows-device-capture-0001",
        architecture: "x64",
        desktopVersion: "0.1.0",
      },
    ),
    authorization.authorizationId,
  );
  return {
    store,
    objects,
    workspaceId,
    token: paired.accessToken,
    service: new DesktopCaptureService(store, objects),
  };
}

test("desktop capture ingests an idempotent private draft pending privacy review", async () => {
  const { store, service, token, workspaceId } = await pairedDesktopFixture();
  const sessionId = "session_desktop_capture_0001";
  const startBody = {
    sessionId,
    policyVersion: "desktop-v2-redacted",
    title: "Workflow in Notepad — 2026-08-20",
    stepCount: 0,
    scope: {
      kind: "application",
      applicationName: "Notepad",
      processId: 4242,
      excludedWindowIds: ["knowhow-main", "knowhow-hud"],
    },
    textInputCapture: "exact-non-password",
  };
  const start = () =>
    service.start(
      jsonRequest("/api/desktop/v1/captures", "POST", startBody, token, {
        "idempotency-key": sessionId,
      }),
    );
  const started = await start();
  assert.equal((await start()).captureId, started.captureId);

  await assert.rejects(
    service.start(
      jsonRequest(
        "/api/desktop/v1/captures",
        "POST",
        { ...startBody, sessionId: "session_cross_tenant", workspaceId: "workspace_other" },
        token,
        { "idempotency-key": "session_cross_tenant" },
      ),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "WORKSPACE_TOKEN_MISMATCH",
  );

  await service.expectedSteps(
    jsonRequest(
      `/api/desktop/v1/captures/${started.captureId}`,
      "PATCH",
      { expectedSteps: 1 },
      token,
    ),
    started.captureId,
  );

  const screenshot = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const upload = () =>
    service.upload(
      new Request(
        `https://knowhow.example/api/desktop/v1/captures/${started.captureId}/steps/step_0001/screenshot`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "image/png",
            "idempotency-key": `${sessionId}:step_0001`,
            "x-knowhow-source-rasterized": "true",
            "x-knowhow-redacted": "true",
            "x-knowhow-image-width": "1",
            "x-knowhow-image-height": "1",
          },
          body: screenshot,
        },
      ),
      started.captureId,
      "step_0001",
    );
  const uploaded = await upload();
  assert.equal((await upload()).mediaId, uploaded.mediaId);

  const commitBody = {
    steps: [
      {
        id: "step_0001",
        order: 0,
        title: "Enter a name",
        instructions: "Enter “Ada” in Name",
        sourceEvent: "text-entry",
        passwordStatus: "not-password",
        text: "Ada",
        annotations: [
          {
            id: "focus_0001",
            kind: "box",
            x: 0.1,
            y: 0.2,
            width: 0.6,
            height: 0.2,
            color: "#7c3aed",
          },
        ],
        imageWidth: 1,
        imageHeight: 1,
        automaticMaskCount: 1,
      },
    ],
    privacyAttestation: {
      policyVersion: "desktop-v2-redacted",
      sourceRasterized: true,
      passwordMasksApplied: true,
      excludedWindowMasksApplied: true,
      automaticMaskCount: 1,
      manualMaskCount: 0,
    },
  };
  const commit = () =>
    service.commit(
      jsonRequest(
        `/api/desktop/v1/captures/${started.captureId}/commit`,
        "POST",
        commitBody,
        token,
      ),
      started.captureId,
    );
  const committed = await commit();
  assert.equal(committed.privacyReviewPending, true);
  assert.equal((await commit()).guideId, committed.guideId);
  assert.equal(
    committed.editUrl,
    `https://knowhow.example/w/${workspaceId}/guides/${committed.guideId}/edit`,
  );

  const guide = await store.get(TABLES.guides, committed.guideId);
  const revisionRow = await store.get(TABLES.guideRevisions, committed.revisionId);
  const revision = decodePayload<RevisionRecord>(revisionRow, null as never);
  assert.equal(guide?.status, "draft");
  assert.equal(revision.source, "desktop-capture");
  assert.equal(revision.privacyReviewedAt, undefined);
  assert.equal(revision.privacyReviewedBy, undefined);

  const steps = await store.list(TABLES.guideSteps, {
    filters: [{ field: "subject_id", value: committed.revisionId }],
  });
  const savedStep = decodePayload<{
    description: string;
    annotations: Array<{ kind: string }>;
  }>(steps[0], { description: "", annotations: [] });
  assert.equal(savedStep.description, "Enter “Ada” in Name");
  assert.deepEqual(savedStep.annotations.map((annotation) => annotation.kind), ["box"]);
});
