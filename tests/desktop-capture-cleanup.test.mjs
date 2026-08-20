import assert from "node:assert/strict";
import test from "node:test";
import { cleanupAbandonedCaptures } from "../functions/operations/src/main.js";

test("operations cleanup discards an expired desktop capture after deleting private media", async () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  const capture = {
    $id: "capture_expired_desktop",
    workspace_id: "workspace_acme",
    status: "recording",
    expires_at: "2026-08-20T11:59:59.000Z",
    payload_json: JSON.stringify({
      workspaceId: "workspace_acme",
      guideId: "guide_expired_desktop",
      revisionId: "revision_expired_desktop",
      source: "desktop-capture",
      captureKind: "desktop",
      status: "recording",
    }),
  };
  const media = {
    $id: "media_expired_desktop",
    workspace_id: "workspace_acme",
    subject_id: "revision_expired_desktop",
    payload_json: JSON.stringify({ storageFileId: "private_file_expired" }),
  };
  const guide = {
    $id: "guide_expired_desktop",
    status: "draft",
    payload_json: JSON.stringify({
      title: "Expired desktop capture",
      deletedAt: null,
    }),
  };
  let captureStatusQuery = 0;
  const deletedRows = [];
  const updatedRows = [];
  const deletedFiles = [];
  const tables = {
    async listRows({ tableId }) {
      if (tableId === "captures") {
        captureStatusQuery += 1;
        return { rows: captureStatusQuery === 1 ? [capture] : [] };
      }
      if (tableId === "private_media") return { rows: [media] };
      return { rows: [] };
    },
    async deleteRow(input) {
      deletedRows.push(input);
    },
    async getRow({ tableId, rowId }) {
      if (tableId === "guides" && rowId === guide.$id) return guide;
      const error = new Error("not found");
      error.code = 404;
      throw error;
    },
    async updateRow(input) {
      updatedRows.push(input);
      return { $id: input.rowId, ...input.data };
    },
  };
  const storage = {
    async deleteFile(input) {
      deletedFiles.push(input);
    },
  };

  const result = await cleanupAbandonedCaptures({ tables, storage }, now);
  assert.deepEqual(result, {
    inspected: 1,
    discarded: 1,
    removedMedia: 1,
    failures: 0,
  });
  assert.deepEqual(deletedFiles, [
    { bucketId: "knowhow_private_media", fileId: "private_file_expired" },
  ]);
  assert.equal(deletedRows[0].tableId, "private_media");
  const guideUpdate = updatedRows.find((row) => row.tableId === "guides");
  const captureUpdate = updatedRows.find((row) => row.tableId === "captures");
  assert.equal(guideUpdate.data.status, "deleted");
  assert.equal(captureUpdate.data.status, "discarded");
  assert.equal(JSON.parse(captureUpdate.data.payload_json).cleanupReason, "capture-expired");
});
