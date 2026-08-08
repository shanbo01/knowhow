import { env } from "cloudflare:workers";
import {
  assertMutationRequest,
  authorize,
  D1KnowHowRepository,
  HttpError,
  jsonResponse,
  readPrivateMedia,
  readWorkspaceLogo,
  requireD1Binding,
  requireR2Binding,
  requireVerifiedIdentity,
  storeScreenshot,
  storeWorkspaceLogo,
  toErrorResponse,
  type D1DatabaseLike,
} from "../../../../lib/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

function statement(db: D1DatabaseLike, sql: string, ...values: unknown[]) {
  return db.prepare(sql).bind(...values);
}

function requiredQuery(url: URL, key: string, label: string) {
  const value = url.searchParams.get(key)?.trim() ?? "";
  if (!value || value.length > 256) {
    throw new HttpError(400, "MEDIA_REQUEST_INVALID", `${label} is required.`);
  }
  return value;
}

async function requestContext(request: Request) {
  const db = requireD1Binding(env.DB);
  const repository = new D1KnowHowRepository(db);
  await repository.ensureSecurityGuards();
  const identity = await requireVerifiedIdentity(request);
  const url = new URL(request.url);
  const workspaceId = requiredQuery(url, "workspaceId", "Workspace");
  const access = await repository.getWorkspaceAccess(workspaceId, identity.userId);
  if (!access) {
    throw new HttpError(403, "WORKSPACE_ACCESS_REQUIRED", "You do not belong to this workspace.");
  }
  const base = {
    isVerifiedIdentity: true,
    membershipStatus: access.membershipStatus,
    workspaceStatus: access.workspaceStatus,
    roles: access.roles,
    capabilities: access.capabilities,
  } as const;
  return { db, repository, identity, url, workspaceId, access, base };
}

export async function GET(request: Request) {
  const eventId = crypto.randomUUID();
  try {
    const { db, repository, identity, url, workspaceId, access, base } =
      await requestContext(request);
    const bucket = requireR2Binding(env.MEDIA);
    if (url.searchParams.get("kind") === "logo") {
      if (!authorize("workspace.read", base).allowed) {
        throw new HttpError(403, "WORKSPACE_ACCESS_REQUIRED", "The workspace is unavailable.");
      }
      const setting = await statement(
        db,
        `SELECT logo_object_key FROM workspace_settings WHERE workspace_id = ?`,
        workspaceId,
      ).first<{ logo_object_key: string | null }>();
      if (!setting?.logo_object_key) {
        throw new HttpError(404, "LOGO_NOT_FOUND", "Workspace logo not found.");
      }
      const object = await readWorkspaceLogo(bucket, setting.logo_object_key, workspaceId);
      return new Response(object.body, {
        headers: {
          "content-type": String(object.httpMetadata?.contentType ?? "image/png"),
          "cache-control": "private, no-store",
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const mediaId = requiredQuery(url, "mediaId", "Media");
    const media = await statement(
      db,
      `SELECT m.object_key, m.content_type, r.guide_id, r.id AS revision_id,
              g.archived_at
       FROM guide_media m
       JOIN guide_revisions r ON r.id = m.revision_id AND r.workspace_id = m.workspace_id
       JOIN guides g ON g.id = r.guide_id AND g.workspace_id = r.workspace_id
       WHERE m.id = ? AND m.workspace_id = ?`,
      mediaId,
      workspaceId,
    ).first<{
      object_key: string;
      content_type: "image/png" | "image/jpeg" | "image/webp";
      guide_id: string;
      revision_id: string;
      archived_at: string | null;
    }>();
    if (!media) throw new HttpError(404, "MEDIA_NOT_FOUND", "Media not found.");
    const facts = await repository.getGuideAccessFacts(
      workspaceId,
      media.guide_id,
      identity.userId,
      media.revision_id,
    );
    const mayInspectArchived =
      media.archived_at !== null &&
      access.membershipStatus === "active" &&
      access.workspaceStatus === "active" &&
      access.roles.includes("administrator");
    if (
      !mayInspectArchived &&
      (!facts || !authorize("guide.read", { ...base, guide: facts }).allowed)
    ) {
      throw new HttpError(404, "MEDIA_NOT_FOUND", "Media not found.");
    }
    const object = await readPrivateMedia(bucket, media.object_key, workspaceId);
    return new Response(object.body, {
      headers: {
        "content-type": media.content_type,
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return toErrorResponse(error, eventId);
  }
}

export async function POST(request: Request) {
  const eventId = crypto.randomUUID();
  let storedKey: string | null = null;
  try {
    assertMutationRequest(request);
    const { db, repository, identity, workspaceId, base } = await requestContext(request);
    const url = new URL(request.url);
    if (url.searchParams.get("kind") === "screenshot") {
      const guideId = requiredQuery(url, "guideId", "Guide");
      const revisionId = requiredQuery(url, "revisionId", "Revision");
      const stepId = requiredQuery(url, "stepId", "Step");
      const facts = await repository.getGuideAccessFacts(
        workspaceId,
        guideId,
        identity.userId,
        revisionId,
      );
      if (!facts || !authorize("guide.update", { ...base, guide: facts }).allowed) {
        throw new HttpError(403, "DRAFT_EDITOR_REQUIRED", "Only an authorized draft editor may replace screenshots.");
      }
      const step = await statement(
        db,
        `SELECT s.id
         FROM guide_steps s
         JOIN guide_revisions r ON r.id = s.revision_id
         WHERE s.id = ? AND s.revision_id = ? AND r.guide_id = ?
           AND r.workspace_id = ? AND r.status = 'draft'`,
        stepId,
        revisionId,
        guideId,
        workspaceId,
      ).first<{ id: string }>();
      if (!step) throw new HttpError(404, "STEP_NOT_FOUND", "Draft step not found.");
      if (request.headers.get("x-knowhow-source-rasterized") !== "true") {
        throw new HttpError(400, "REDACTION_ATTESTATION_REQUIRED", "Rasterize the screenshot locally before upload.");
      }
      const guideLock = await statement(
        db,
        `SELECT screenshots_locked_at FROM guides WHERE id = ? AND workspace_id = ?`,
        guideId,
        workspaceId,
      ).first<{ screenshots_locked_at: string | null }>();
      const requestedState = request.headers.get("x-knowhow-redacted") === "true" ? "redacted" : "pending";
      if (guideLock?.screenshots_locked_at && requestedState !== "redacted") {
        throw new HttpError(
          409,
          "SCREENSHOTS_LOCKED",
          "This guide's screenshots are locked; upload an already-flattened image.",
        );
      }
      const contentType = request.headers.get("content-type")?.split(";")[0];
      if (contentType !== "image/png" && contentType !== "image/jpeg") {
        throw new HttpError(415, "MEDIA_TYPE_INVALID", "Use a rasterized PNG or JPEG screenshot.");
      }
      const advertised = Number(request.headers.get("content-length") ?? 0);
      if (Number.isFinite(advertised) && advertised > 5 * 1024 * 1024) {
        throw new HttpError(413, "MEDIA_TOO_LARGE", "The replacement screenshot is too large.");
      }
      const width = Number(request.headers.get("x-knowhow-image-width"));
      const height = Number(request.headers.get("x-knowhow-image-height"));
      const bucket = requireR2Binding(env.MEDIA);
      const stored = await storeScreenshot(bucket, {
        workspaceId,
        revisionId,
        uploadedBy: identity.userId,
        contentType,
        bytes: await request.arrayBuffer(),
        width,
        height,
        redactionState: requestedState,
        sourceRasterized: true,
      });
      storedKey = stored.objectKey;
      const mediaId = `media_${crypto.randomUUID()}`;
      await repository.executeAuditedMutation({
        workspaceId,
        actor: { userId: identity.userId, email: identity.email, name: identity.name },
        event: {
          action: "guide.screenshot-replaced",
          targetType: "guide",
          targetId: guideId,
          summary: "Draft screenshot replaced with a reviewed raster",
          metadata: { revisionId, stepId, mediaId },
        },
        statements: [
          statement(
            db,
            `INSERT INTO guide_media
               (id, workspace_id, revision_id, step_id, object_key, content_type,
                byte_size, width, height, sha256, redaction_state,
                source_rasterized, uploaded_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)`,
            mediaId,
            workspaceId,
            revisionId,
            stepId,
            stored.objectKey,
            stored.contentType,
            stored.byteSize,
            stored.width,
            stored.height,
            stored.sha256,
            stored.redactionState,
            identity.userId,
          ),
          statement(
            db,
            `UPDATE guide_steps
             SET annotation_json = json_set(COALESCE(annotation_json, '{}'), '$.screenshotMediaId', ?),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND revision_id = ?`,
            mediaId,
            stepId,
            revisionId,
          ),
          statement(
            db,
            `UPDATE guide_revisions
             SET privacy_reviewed_at = NULL, privacy_reviewed_by = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND workspace_id = ? AND source_type = 'capture'`,
            revisionId,
            workspaceId,
          ),
        ],
      });
      storedKey = null;
      return jsonResponse({ mediaId });
    }
    if (!authorize("workspace.settings.manage", base).allowed) {
      throw new HttpError(403, "WORKSPACE_ADMIN_REQUIRED", "Workspace administration is required.");
    }
    const contentType = request.headers.get("content-type")?.split(";")[0];
    if (contentType !== "image/png" && contentType !== "image/jpeg") {
      throw new HttpError(415, "LOGO_TYPE_INVALID", "Use a PNG or JPEG workspace logo.");
    }
    const advertised = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(advertised) && advertised > 1024 * 1024) {
      throw new HttpError(413, "LOGO_SIZE_INVALID", "The workspace logo must be 1 MB or smaller.");
    }
    const bytes = await request.arrayBuffer();
    const bucket = requireR2Binding(env.MEDIA);
    const previous = await statement(
      db,
      `SELECT logo_object_key FROM workspace_settings WHERE workspace_id = ?`,
      workspaceId,
    ).first<{ logo_object_key: string | null }>();
    const stored = await storeWorkspaceLogo(bucket, {
      workspaceId,
      uploadedBy: identity.userId,
      contentType,
      bytes,
    });
    storedKey = stored.objectKey;
    await repository.executeAuditedMutation({
      workspaceId,
      actor: { userId: identity.userId, email: identity.email, name: identity.name },
      event: {
        action: "workspace.logo-updated",
        targetType: "workspace",
        targetId: workspaceId,
        summary: "Workspace logo updated",
        metadata: { byteSize: stored.byteSize, contentType: stored.contentType },
      },
      statements: [
        statement(
          db,
          `UPDATE workspace_settings SET logo_object_key = ?, updated_at = CURRENT_TIMESTAMP
           WHERE workspace_id = ?`,
          stored.objectKey,
          workspaceId,
        ),
      ],
    });
    storedKey = null;
    if (previous?.logo_object_key && previous.logo_object_key !== stored.objectKey) {
      await bucket.delete(previous.logo_object_key).catch(() => undefined);
    }
    return jsonResponse({ configured: true });
  } catch (error) {
    if (storedKey) {
      await requireR2Binding(env.MEDIA).delete(storedKey).catch(() => undefined);
    }
    return toErrorResponse(error, eventId);
  }
}

export async function DELETE(request: Request) {
  const eventId = crypto.randomUUID();
  try {
    assertMutationRequest(request);
    const { db, repository, identity, workspaceId, base } = await requestContext(request);
    if (!authorize("workspace.settings.manage", base).allowed) {
      throw new HttpError(403, "WORKSPACE_ADMIN_REQUIRED", "Workspace administration is required.");
    }
    const current = await statement(
      db,
      `SELECT logo_object_key FROM workspace_settings WHERE workspace_id = ?`,
      workspaceId,
    ).first<{ logo_object_key: string | null }>();
    await repository.executeAuditedMutation({
      workspaceId,
      actor: { userId: identity.userId, email: identity.email, name: identity.name },
      event: {
        action: "workspace.logo-removed",
        targetType: "workspace",
        targetId: workspaceId,
        summary: "Workspace logo removed",
      },
      statements: [
        statement(
          db,
          `UPDATE workspace_settings SET logo_object_key = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE workspace_id = ?`,
          workspaceId,
        ),
      ],
    });
    if (current?.logo_object_key) {
      await requireR2Binding(env.MEDIA).delete(current.logo_object_key).catch(() => undefined);
    }
    return jsonResponse({ configured: false });
  } catch (error) {
    return toErrorResponse(error, eventId);
  }
}
