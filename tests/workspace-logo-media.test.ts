import assert from "node:assert/strict";
import test from "node:test";
import { rowData } from "../lib/server/domain-records";
import { authorizeWorkspaceLogo } from "../lib/server/workspace-logo-media";
import type { RecordData, StoredRecord } from "../lib/server/record-store";

const MEDIA_ID = "logo_organization";
const ORGANIZATION_ID = "org_alpha";
const WORKSPACE_ID = "workspace_alpha";

function logoRow(
  fields: Partial<RecordData> = {},
  metadata: Record<string, unknown> = {},
) {
  return {
    ...rowData(
      {
        organization_id: ORGANIZATION_ID,
        workspace_id: null,
        subject_id: ORGANIZATION_ID,
        status: "ready",
        kind: "organization-logo",
        ...fields,
      },
      {
        storageFileId: MEDIA_ID,
        contentType: "image/png",
        sha256: "a".repeat(64),
        deletedAt: null,
        ...metadata,
      },
    ),
    $id: MEDIA_ID,
    $createdAt: "2026-08-13T00:00:00.000Z",
    $updatedAt: "2026-08-13T00:00:00.000Z",
  } as StoredRecord;
}

const scope = {
  mediaId: MEDIA_ID,
  organizationId: ORGANIZATION_ID,
  workspaceId: WORKSPACE_ID,
};

test("a provisioned organization logo is inherited by a workspace in the same organization", () => {
  assert.deepEqual(authorizeWorkspaceLogo(logoRow(), scope), {
    fileId: MEDIA_ID,
    contentType: "image/png",
    sha256: "a".repeat(64),
  });
});

test("workspace-specific logos remain isolated to their exact workspace", () => {
  const workspaceLogo = logoRow({
    kind: "workspace-logo",
    workspace_id: WORKSPACE_ID,
    subject_id: WORKSPACE_ID,
  });
  assert.ok(authorizeWorkspaceLogo(workspaceLogo, scope));
  assert.equal(
    authorizeWorkspaceLogo(workspaceLogo, {
      ...scope,
      workspaceId: "workspace_bravo",
    }),
    null,
  );
});

test("organization logos cannot cross tenants or bypass media lifecycle checks", () => {
  assert.equal(
    authorizeWorkspaceLogo(logoRow(), {
      ...scope,
      organizationId: "org_bravo",
    }),
    null,
  );
  assert.equal(
    authorizeWorkspaceLogo(logoRow({ status: "staged" }), scope),
    null,
  );
  assert.equal(
    authorizeWorkspaceLogo(logoRow({}, { storageFileId: "logo_other" }), scope),
    null,
  );
  assert.equal(
    authorizeWorkspaceLogo(
      logoRow({}, { deletedAt: "2026-08-13T01:00:00.000Z" }),
      scope,
    ),
    null,
  );
});
