import { AccessService } from "../../../../lib/server/access-service";
import { isCapturedGuideSource } from "../../../../lib/guide-contracts";
import { appendAudit } from "../../../../lib/server/audit-service";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  decodePayload,
  rowData,
  type PrivateMediaRecord,
  type RevisionRecord,
  type GuideStepRecord,
} from "../../../../lib/server/domain-records";
import type { WorkspaceSettings } from "../../../../lib/knowhow-types";
import { GuideAccessService } from "../../../../lib/server/guide-access-service";
import {
  allowedRequestOrigins,
  correlationId,
  createRequestServices,
  withRequestId,
} from "../../../../lib/server/request-services";
import {
  assertCookieMutationRequest,
  HttpError,
  jsonResponse,
  toErrorResponse,
} from "../../../../lib/server/http-security";
import { resourceId } from "../../../../lib/server/ids";
import { sha256Bytes, validateLogo, validateScreenshot } from "../../../../lib/server/media-validation";
import { TABLES } from "../../../../lib/server/appwrite-resources";
import { EntitlementService } from "../../../../lib/server/entitlement-service";
import { requireAuthorized } from "../../../../lib/server/policy";
import type { RecordStore } from "../../../../lib/server/record-store";
import { requireVerifiedSession } from "../../../../lib/server/session-identity";
import { consumeFixedWindows } from "../../../../lib/server/rate-limit-service";
import { authorizeWorkspaceLogo } from "../../../../lib/server/workspace-logo-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requiredId(url: URL, key: string, label: string) {
  const value = url.searchParams.get(key)?.trim() ?? "";
  if (!ID.test(value)) throw new HttpError(400, "MEDIA_REQUEST_INVALID", `${label} is required.`);
  return value;
}

function requiredClientId(url: URL, key: string, label: string) {
  const value = url.searchParams.get(key)?.trim() ?? "";
  if (!CLIENT_ID.test(value)) throw new HttpError(400, "MEDIA_REQUEST_INVALID", `${label} is required.`);
  return value;
}

async function boundedBytes(request: Request, maximum: number) {
  const advertised = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(advertised) && advertised > maximum) {
    throw new HttpError(413, "MEDIA_SIZE_INVALID", "The upload is too large.");
  }
  if (!request.body) throw new HttpError(400, "MEDIA_EMPTY", "Choose an image to upload.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new HttpError(413, "MEDIA_SIZE_INVALID", "The upload is too large.");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function mediaHeaders(contentType: string) {
  return {
    "content-type": contentType,
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  };
}

async function workspaceContext(request: Request) {
  const identity = await requireVerifiedSession(request);
  const services = createRequestServices();
  const url = new URL(request.url);
  const workspaceId = requiredId(url, "workspaceId", "Workspace");
  const accessService = new AccessService(services.store);
  const access = await accessService.requireWorkspace(workspaceId, identity);
  return {
    ...services,
    identity,
    url,
    workspaceId,
    access,
    context: accessService.context(access),
  };
}

async function configuredLogo(store: RecordStore, workspaceId: string) {
  const settings = await store.list(TABLES.workspaceSettings, {
    filters: [{ field: "workspace_id", value: workspaceId }],
    limit: 1,
  });
  if (!settings[0]) return { row: null, value: DEFAULT_WORKSPACE_SETTINGS };
  return {
    row: settings[0],
    value: {
      ...DEFAULT_WORKSPACE_SETTINGS,
      ...decodePayload<Partial<WorkspaceSettings>>(settings[0], {}),
    },
  };
}

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const { store, objects, identity, url, workspaceId, access, context } = await workspaceContext(request);
    await consumeFixedWindows(store, [{ scope: "knowhow.media-read", subject: identity.userId, limit: 600, windowSeconds: 60 }]);
    let fileId: string;
    let contentType: string;
    let expectedHash: string;
    if (url.searchParams.get("kind") === "logo") {
      requireAuthorized("workspace.read", context);
      const logo = await configuredLogo(store, workspaceId);
      if (!logo.value.logoUrl) throw new HttpError(404, "LOGO_NOT_FOUND", "Workspace logo not found.");
      const mediaRow = await store.get(TABLES.privateMedia, logo.value.logoUrl);
      const authorizedLogo = authorizeWorkspaceLogo(mediaRow, {
        mediaId: logo.value.logoUrl,
        workspaceId,
        organizationId: access.workspace.organizationId,
      });
      if (!authorizedLogo) {
        throw new HttpError(404, "LOGO_NOT_FOUND", "Workspace logo not found.");
      }
      fileId = authorizedLogo.fileId;
      contentType = authorizedLogo.contentType;
      expectedHash = authorizedLogo.sha256;
    } else {
      const mediaId = requiredId(url, "mediaId", "Media");
      const mediaRow = await store.get(TABLES.privateMedia, mediaId);
      if (!mediaRow || mediaRow.workspace_id !== workspaceId || mediaRow.status !== "ready") {
        throw new HttpError(404, "MEDIA_NOT_FOUND", "Media not found.");
      }
      const metadata = decodePayload<PrivateMediaRecord>(mediaRow, null as never);
      if (!metadata || metadata.deletedAt || metadata.storageFileId !== mediaId) {
        throw new HttpError(404, "MEDIA_NOT_FOUND", "Media not found.");
      }
      await new GuideAccessService(store).require(
        identity,
        workspaceId,
        metadata.guideId,
        metadata.revisionId,
        "guide.read",
      );
      fileId = metadata.storageFileId;
      contentType = metadata.contentType;
      expectedHash = metadata.sha256;
    }
    const object = await objects.get(fileId);
    if (!object) throw new HttpError(404, "MEDIA_NOT_FOUND", "Media not found.");
    if (object.contentType !== contentType || (expectedHash && (await sha256Bytes(object.bytes)) !== expectedHash)) {
      throw new HttpError(500, "MEDIA_INTEGRITY_FAILURE", "Private media failed its integrity check.", { expose: false });
    }
    return withRequestId(
      new Response(object.bytes.slice().buffer as ArrayBuffer, {
        headers: mediaHeaders(contentType),
      }),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}

export async function POST(request: Request) {
  const requestId = correlationId(request);
  let createdFileId: string | null = null;
  try {
    assertCookieMutationRequest(request, allowedRequestOrigins());
    const initialUrl = new URL(request.url);
    if (initialUrl.searchParams.get("kind") === "provisioning-logo") {
      const identity = await requireVerifiedSession(request);
      const { store, objects } = createRequestServices();
      await consumeFixedWindows(store, [{ scope: "knowhow.provisioning-logo", subject: identity.userId, limit: 20, windowSeconds: 600 }]);
      const platformRoles = await store.list(TABLES.platformRoles, {
        filters: [{ field: "user_id", value: identity.userId }, { field: "status", value: "active" }],
      });
      if (!platformRoles.some((row) => row.kind === "owner" || row.kind === "operations")) {
        throw new HttpError(403, "PLATFORM_OPERATIONS_REQUIRED", "Platform operations access is required.");
      }
      const runId = requiredId(initialUrl, "runId", "Provisioning run");
      const run = await store.get(TABLES.provisioningRuns, runId);
      if (!run || run.user_id !== identity.userId || run.status !== "draft") {
        throw new HttpError(404, "PROVISIONING_RUN_NOT_FOUND", "Provisioning draft not found.");
      }
      const contentType = request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      const bytes = await boundedBytes(request, 1024 * 1024);
      const validated = await validateLogo(bytes, contentType);
      const logoId = resourceId("logo");
      createdFileId = logoId;
      await objects.put({ id: logoId, bytes, filename: `organization-logo.${validated.contentType === "image/png" ? "png" : "jpg"}`, contentType: validated.contentType });
      await store.create(
        TABLES.privateMedia,
        logoId,
        rowData(
          { workspace_id: runId, user_id: identity.userId, subject_id: runId, status: "staged", kind: "provisioning-logo", created_by: identity.userId },
          { storageFileId: logoId, filename: `organization-logo.${validated.contentType === "image/png" ? "png" : "jpg"}`, contentType: validated.contentType, byteSize: validated.byteSize, width: validated.width, height: validated.height, sha256: validated.sha256, uploadedBy: identity.userId, createdAt: new Date().toISOString(), deletedAt: null },
        ),
      );
      createdFileId = null;
      return withRequestId(jsonResponse({ mediaId: logoId, requestId }), requestId);
    }
    const { store, objects, identity, url, workspaceId, access, context } = await workspaceContext(request);
    await consumeFixedWindows(store, [{ scope: "knowhow.media-write", subject: identity.userId, limit: 60, windowSeconds: 60 }]);
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (url.searchParams.get("kind") === "screenshot") {
      const guideId = requiredId(url, "guideId", "Guide");
      const revisionId = requiredId(url, "revisionId", "Revision");
      const stepId = requiredClientId(url, "stepId", "Step");
      const authorized = await new GuideAccessService(store).require(
        identity,
        workspaceId,
        guideId,
        revisionId,
        "guide.update",
      );
      if (authorized.guide.workingRevisionId !== revisionId || authorized.revision.status !== "draft") {
        throw new HttpError(409, "DRAFT_NOT_EDITABLE", "Only the current draft can receive screenshots.");
      }
      if (request.headers.get("x-knowhow-source-rasterized") !== "true") {
        throw new HttpError(400, "REDACTION_ATTESTATION_REQUIRED", "Rasterize the screenshot locally before upload.");
      }
      const redactionState = request.headers.get("x-knowhow-redacted") === "true" ? "redacted" : "pending";
      if (authorized.guide.screenshotsLockedAt && redactionState !== "redacted") {
        throw new HttpError(409, "SCREENSHOTS_LOCKED", "Upload an already-flattened screenshot after first review.");
      }
      const stepRows = await store.list(TABLES.guideSteps, {
        filters: [{ field: "subject_id", value: revisionId }],
      });
      const stepRow = stepRows.find((row) => decodePayload<GuideStepRecord>(row, null as never)?.id === stepId);
      if (!stepRow) throw new HttpError(404, "STEP_NOT_FOUND", "Draft step not found.");
      const currentStep = decodePayload<GuideStepRecord>(stepRow, null as never);
      const bytes = await boundedBytes(request, 5 * 1024 * 1024);
      const validated = await validateScreenshot(
        bytes,
        contentType,
        Number(request.headers.get("x-knowhow-image-width")),
        Number(request.headers.get("x-knowhow-image-height")),
      );
      await new EntitlementService(store, workspaceId).assertStorageCapacity(
        validated.byteSize,
        currentStep.screenshotMediaId,
      );
      const mediaId = resourceId("media");
      createdFileId = mediaId;
      await objects.put({
        id: mediaId,
        bytes,
        filename: `screenshot.${validated.contentType === "image/png" ? "png" : "jpg"}`,
        contentType: validated.contentType,
      });
      const timestamp = new Date().toISOString();
      await store.transaction(async (transaction) => {
        const media: PrivateMediaRecord = {
          guideId,
          revisionId,
          stepId,
          storageFileId: mediaId,
          filename: `screenshot.${validated.contentType === "image/png" ? "png" : "jpg"}`,
          contentType: validated.contentType,
          byteSize: validated.byteSize,
          width: validated.width,
          height: validated.height,
          sha256: validated.sha256,
          redactionState,
          sourceRasterized: true,
          uploadedBy: identity.userId,
          createdAt: timestamp,
          deletedAt: null,
        };
        await transaction.create(TABLES.privateMedia, mediaId, rowData({ organization_id: access.workspace.organizationId, workspace_id: workspaceId, subject_id: revisionId, user_id: identity.userId, status: "ready", kind: validated.contentType, created_by: identity.userId }, media));
        await transaction.update(TABLES.guideSteps, stepRow.$id, rowData({ updated_by: identity.userId }, { ...currentStep, screenshotMediaId: mediaId }));
        if (isCapturedGuideSource(authorized.revision.source)) {
          const nextRevision: RevisionRecord = { ...authorized.revision, updatedAt: timestamp };
          delete nextRevision.privacyReviewedAt;
          delete nextRevision.privacyReviewedBy;
          await transaction.update(TABLES.guideRevisions, revisionId, rowData({ updated_by: identity.userId }, nextRevision));
        }
        if (currentStep.screenshotMediaId) {
          const old = await transaction.get(TABLES.privateMedia, currentStep.screenshotMediaId);
          if (old && old.workspace_id === workspaceId && old.subject_id === revisionId) {
            const oldMedia = decodePayload<PrivateMediaRecord>(old, null as never);
            await transaction.update(TABLES.privateMedia, old.$id, rowData({ status: "quarantined", deleted_at: timestamp, updated_by: identity.userId }, { ...oldMedia, deletedAt: timestamp }));
          }
        }
        await appendAudit(transaction, identity, workspaceId, {
          action: "guide.screenshot-replaced",
          targetType: "guide",
          targetId: guideId,
          summary: "Draft screenshot replaced with a reviewed raster",
          metadata: { revisionId, stepId, mediaId, requestId },
        });
      });
      createdFileId = null;
      return withRequestId(jsonResponse({ mediaId, requestId }), requestId);
    }

    requireAuthorized("workspace.settings.manage", context);
    const bytes = await boundedBytes(request, 1024 * 1024);
    const validated = await validateLogo(bytes, contentType);
    const current = await configuredLogo(store, workspaceId);
    await new EntitlementService(store, workspaceId).assertStorageCapacity(
      validated.byteSize,
      current.value.logoUrl ?? undefined,
    );
    const logoId = resourceId("logo");
    createdFileId = logoId;
    await objects.put({
      id: logoId,
      bytes,
      filename: `workspace-logo.${validated.contentType === "image/png" ? "png" : "jpg"}`,
      contentType: validated.contentType,
    });
    const timestamp = new Date().toISOString();
    await store.transaction(async (transaction) => {
      await transaction.create(TABLES.privateMedia, logoId, rowData({ organization_id: access.workspace.organizationId, workspace_id: workspaceId, subject_id: workspaceId, user_id: identity.userId, status: "ready", kind: "workspace-logo", created_by: identity.userId }, { storageFileId: logoId, filename: `workspace-logo.${validated.contentType === "image/png" ? "png" : "jpg"}`, contentType: validated.contentType, byteSize: validated.byteSize, width: validated.width, height: validated.height, sha256: validated.sha256, uploadedBy: identity.userId, createdAt: timestamp, deletedAt: null }));
      const next = { ...current.value, logoUrl: logoId };
      if (current.row) await transaction.update(TABLES.workspaceSettings, current.row.$id, rowData({ updated_by: identity.userId }, next));
      else await transaction.create(TABLES.workspaceSettings, resourceId("settings"), rowData({ organization_id: access.workspace.organizationId, workspace_id: workspaceId, status: "active", created_by: identity.userId }, next));
      if (current.value.logoUrl) {
        const previous = await transaction.get(TABLES.privateMedia, current.value.logoUrl);
        if (previous && previous.workspace_id === workspaceId) {
          await transaction.update(TABLES.privateMedia, previous.$id, rowData({ status: "quarantined", deleted_at: timestamp, updated_by: identity.userId }, { ...decodePayload(previous, {}), deletedAt: timestamp }));
        }
      }
      await appendAudit(transaction, identity, workspaceId, { action: "workspace.logo-updated", targetType: "workspace", targetId: workspaceId, summary: "Workspace logo updated", metadata: { byteSize: validated.byteSize, contentType: validated.contentType, requestId } });
    });
    createdFileId = null;
    return withRequestId(jsonResponse({ configured: true, requestId }), requestId);
  } catch (error) {
    if (createdFileId) {
      try {
        await createRequestServices().objects.delete(createdFileId).catch(() => undefined);
      } catch {
        // Runtime configuration failures are represented by the primary error.
      }
    }
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}

export async function DELETE(request: Request) {
  const requestId = correlationId(request);
  try {
    assertCookieMutationRequest(request, allowedRequestOrigins());
    const { store, identity, workspaceId, context } = await workspaceContext(request);
    await consumeFixedWindows(store, [{ scope: "knowhow.media-delete", subject: identity.userId, limit: 20, windowSeconds: 600 }]);
    requireAuthorized("workspace.settings.manage", context);
    const current = await configuredLogo(store, workspaceId);
    if (!current.row || !current.value.logoUrl) {
      return withRequestId(jsonResponse({ configured: false, requestId }), requestId);
    }
    const removedAt = new Date().toISOString();
    await store.transaction(async (transaction) => {
      await transaction.update(TABLES.workspaceSettings, current.row!.$id, rowData({ updated_by: identity.userId }, { ...current.value, logoUrl: null }));
      const media = await transaction.get(TABLES.privateMedia, current.value.logoUrl!);
      if (media && media.workspace_id === workspaceId) {
        await transaction.update(TABLES.privateMedia, media.$id, rowData({ status: "quarantined", deleted_at: removedAt, updated_by: identity.userId }, { ...decodePayload(media, {}), deletedAt: removedAt }));
      }
      await appendAudit(transaction, identity, workspaceId, { action: "workspace.logo-removed", targetType: "workspace", targetId: workspaceId, summary: "Workspace logo removed", metadata: { requestId } });
    });
    return withRequestId(jsonResponse({ configured: false, requestId }), requestId);
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
