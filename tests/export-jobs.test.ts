import assert from "node:assert/strict";
import test from "node:test";
import type { EditorBlock } from "../lib/knowhow-types";
import {
  decodePayload,
  rowData,
  type ExportJobRecord,
  type GuideRecord,
  type RevisionRecord,
} from "../lib/server/domain-records";
import {
  processExportJob,
  verifiedExportObject,
} from "../lib/server/export-job-service";
import { InMemoryPrivateObjectStore } from "../lib/server/private-object-store";
import { TABLES } from "../lib/server/appwrite-resources";
import { InMemoryRecordStore } from "../lib/server/record-store";
import { seedWorkspace, seedWorkspaceMember } from "./helpers/appwrite-fixtures";

async function seedPublishedGuide(store: InMemoryRecordStore) {
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const userId = "viewer";
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId,
    email: "viewer@acme.example",
    roles: ["viewer"],
  });
  const guideId = "guide_export";
  const revisionId = "revision_export";
  const now = "2026-08-01T00:00:00.000Z";
  const guide: GuideRecord = {
    title: "Reset a Printer Queue",
    slug: "reset-printer-queue",
    authorUserId: userId,
    publishedRevisionId: revisionId,
    workingRevisionId: null,
    screenshotsLockedAt: now,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const revision: RevisionRecord = {
    guideId,
    number: 1,
    status: "published",
    title: guide.title,
    summary: "Restore a stalled office printer queue.",
    category: "Printing",
    tags: ["printer"],
    systemReferences: [],
    authorId: userId,
    createdAt: now,
    updatedAt: now,
    submittedBy: userId,
    submittedAt: now,
    reviewedBy: userId,
    reviewedAt: now,
    publishedBy: userId,
    publishedAt: now,
    source: "manual",
  };
  await store.create(
    TABLES.guides,
    guideId,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        slug: guide.slug,
        status: "published",
        created_by: userId,
      },
      guide,
    ),
  );
  await store.create(
    TABLES.guideRevisions,
    revisionId,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        subject_id: guideId,
        status: "published",
        version: 1,
        created_by: userId,
      },
      revision,
    ),
  );
  const block: EditorBlock = {
    id: "step_heading",
    kind: "heading",
    title: "Clear the queue",
    description: "",
  };
  await store.create(
    TABLES.guideSteps,
    block.id,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        subject_id: revisionId,
        sequence: 1,
        kind: block.kind,
        status: "published",
      },
      block,
    ),
  );
  await store.create(
    TABLES.guideAudiences,
    "audience_export",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        subject_id: revisionId,
        kind: "workspace",
        status: "active",
      },
      { kind: "workspace", workspaceId },
    ),
  );
  await store.create(
    TABLES.reviewAssignments,
    "review_export",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        subject_id: revisionId,
        user_id: userId,
        status: "approved",
      },
      { approvedAt: now },
    ),
  );
  return { organizationId, workspaceId, userId, guideId, revisionId };
}

test("asynchronous exports lease, render, hash, and replay idempotently", async () => {
  const store = new InMemoryRecordStore();
  const privateObjects = new InMemoryPrivateObjectStore();
  const exportObjects = new InMemoryPrivateObjectStore();
  const seeded = await seedPublishedGuide(store);
  const jobId = "export_job_000000000000000000000001";
  const details: ExportJobRecord = {
    guideId: seeded.guideId,
    revisionId: seeded.revisionId,
    format: "markdown",
    filename: "reset-printer-queue.md",
    outputFileId: "output_0000000000000000000000000001",
    requestedAt: "2026-08-01T00:00:00.000Z",
    requester: {
      userId: seeded.userId,
      name: "Viewer",
      email: "viewer@acme.example",
    },
    attempts: 0,
    watermarked: false,
  };
  await store.create(
    TABLES.exportJobs,
    jobId,
    rowData(
      {
        organization_id: seeded.organizationId,
        workspace_id: seeded.workspaceId,
        user_id: seeded.userId,
        subject_id: seeded.revisionId,
        status: "queued",
        kind: "markdown",
        idempotency_key: "export-test-key",
        request_id: "request-export-test",
        scheduled_at: details.requestedAt,
      },
      details,
    ),
  );

  const completed = await processExportJob(
    store,
    privateObjects,
    exportObjects,
    jobId,
    new Date("2026-08-01T00:00:01.000Z"),
  );
  assert.equal(completed.status, "ready");
  assert.ok("byteSize" in completed);
  const row = await store.get(TABLES.exportJobs, jobId);
  assert.equal(row?.status, "ready");
  const ready = decodePayload<ExportJobRecord>(row, details);
  assert.equal(ready.attempts, 1);
  assert.equal(ready.byteSize, completed.byteSize);
  assert.match(ready.sha256 ?? "", /^[a-f0-9]{64}$/);
  const object = await verifiedExportObject(exportObjects, ready);
  assert.match(new TextDecoder().decode(object.bytes), /Reset a Printer Queue/);
  assert.match(new TextDecoder().decode(object.bytes), /Clear the queue/);

  const replay = await processExportJob(
    store,
    privateObjects,
    exportObjects,
    jobId,
  );
  assert.deepEqual(replay, { status: "ready", skipped: true });
  assert.equal(
    decodePayload<ExportJobRecord>(
      await store.get(TABLES.exportJobs, jobId),
      details,
    ).attempts,
    1,
  );
});

test("failed exports retry with bounded attempts and no output", async () => {
  const store = new InMemoryRecordStore();
  const privateObjects = new InMemoryPrivateObjectStore();
  const exportObjects = new InMemoryPrivateObjectStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const details: ExportJobRecord = {
    guideId: "missing_guide",
    revisionId: "missing_revision",
    format: "html",
    filename: "missing.html",
    outputFileId: "output_missing",
    requestedAt: new Date().toISOString(),
    requester: {
      userId: "missing-user",
      name: "Missing User",
      email: "missing@acme.example",
    },
    attempts: 0,
    watermarked: false,
  };
  const jobId = "export_missing";
  await store.create(
    TABLES.exportJobs,
    jobId,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        user_id: details.requester.userId,
        subject_id: details.revisionId,
        status: "queued",
        kind: details.format,
        idempotency_key: "missing-export-key",
        request_id: "request-missing-export",
        scheduled_at: details.requestedAt,
      },
      details,
    ),
  );

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const current = decodePayload<ExportJobRecord>(
      await store.get(TABLES.exportJobs, jobId),
      details,
    );
    const runAt = current.retryAt
      ? new Date(Date.parse(current.retryAt) + 1)
      : new Date();
    const result = await processExportJob(
      store,
      privateObjects,
      exportObjects,
      jobId,
      runAt,
    );
    assert.equal(result.status, attempt === 5 ? "failed" : "retry");
  }
  const failedRow = await store.get(TABLES.exportJobs, jobId);
  assert.equal(failedRow?.status, "failed");
  const failed = decodePayload<ExportJobRecord>(failedRow, details);
  assert.equal(failed.attempts, 5);
  assert.equal(failed.failureCode, "WORKSPACE_NOT_FOUND");
  assert.equal(await exportObjects.get(details.outputFileId), null);
});
