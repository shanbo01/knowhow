import "server-only";

import { decodePayload } from "./domain-records";
import type { RecordData, StoredRecord } from "./record-store";

type LogoMetadata = {
  storageFileId?: string;
  contentType?: string;
  sha256?: string;
  deletedAt?: string | null;
};

type WorkspaceLogoScope = {
  mediaId: string;
  workspaceId: string;
  organizationId: string;
};

export type AuthorizedWorkspaceLogo = {
  fileId: string;
  contentType: string;
  sha256: string;
};

/**
 * Resolves a configured logo only when its persisted scope belongs to the
 * requested workspace. Provisioning creates one organization logo that is
 * inherited by each workspace; later workspace-specific uploads remain
 * isolated to a single workspace.
 */
export function authorizeWorkspaceLogo(
  row: StoredRecord<RecordData> | null,
  scope: WorkspaceLogoScope,
): AuthorizedWorkspaceLogo | null {
  if (
    !row ||
    row.$id !== scope.mediaId ||
    row.status !== "ready" ||
    row.organization_id !== scope.organizationId
  ) {
    return null;
  }

  const isWorkspaceLogo =
    row.kind === "workspace-logo" && row.workspace_id === scope.workspaceId;
  const isInheritedOrganizationLogo =
    row.kind === "organization-logo" &&
    row.workspace_id === null &&
    row.subject_id === scope.organizationId;
  if (!isWorkspaceLogo && !isInheritedOrganizationLogo) return null;

  const metadata = decodePayload<LogoMetadata>(row, {});
  if (metadata.storageFileId !== scope.mediaId || metadata.deletedAt)
    return null;

  return {
    fileId: metadata.storageFileId,
    contentType: metadata.contentType ?? "image/png",
    sha256: metadata.sha256 ?? "",
  };
}
