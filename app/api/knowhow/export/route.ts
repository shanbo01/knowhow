import { env } from "cloudflare:workers";
import {
  allRows,
  authorize,
  D1KnowHowRepository,
  HttpError,
  readPrivateMedia,
  readWorkspaceLogo,
  requireD1Binding,
  requireR2Binding,
  requireVerifiedIdentity,
  toErrorResponse,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from "../../../../lib/server";
import {
  parsePublishedGuideRevision,
  type GuideActionMedia,
  type GuideAudience,
  type GuideBlock,
  type PublishedGuideRevision,
} from "../../../../lib/guide-contracts";
import {
  renderGuideToHtml,
  renderGuideToMarkdown,
  renderGuideToPdf,
  type GuideExportAsset,
  type GuideRenderOptions,
} from "../../../../lib/exports";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const MAX_EXPORT_ASSET_BYTES = 32 * 1024 * 1024;

function statement(db: D1DatabaseLike, sql: string, ...values: unknown[]) {
  return db.prepare(sql).bind(...values);
}

async function rows<T>(db: D1DatabaseLike, sql: string, ...values: unknown[]) {
  return allRows<T>(statement(db, sql, ...values));
}

async function first<T>(db: D1DatabaseLike, sql: string, ...values: unknown[]) {
  return statement(db, sql, ...values).first<T>();
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function safeFileName(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return normalized || "knowhow-guide";
}

type ExportRevisionRow = {
  guide_id: string;
  revision_id: string;
  workspace_id: string;
  version: number;
  title: string;
  summary: string;
  source_type: "manual" | "capture" | "import";
  privacy_reviewed_at: string | null;
  privacy_reviewed_by: string | null;
  created_by: string;
  created_at: string;
  submitted_at: string | null;
  published_by: string | null;
  published_at: string | null;
  workspace_name: string;
  logo_object_key: string | null;
  accent_color: string;
  click_target_color: string;
  remove_branding: number;
  restricted_exports_enabled: number;
  watermark_restricted_exports: number;
};

async function displayName(db: D1DatabaseLike, workspaceId: string, userId: string | null) {
  if (!userId) return undefined;
  const member = await first<{ display_name: string | null; email: string }>(
    db,
    `SELECT display_name, email FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    workspaceId,
    userId,
  );
  return member?.display_name ?? member?.email ?? userId;
}

async function buildPublishedRevision(
  db: D1DatabaseLike,
  workspaceId: string,
  guideId: string,
) {
  const revision = await first<ExportRevisionRow>(
    db,
    `SELECT g.id AS guide_id, r.id AS revision_id, r.workspace_id, r.version,
            r.title, r.summary, r.source_type, r.privacy_reviewed_at,
            r.privacy_reviewed_by, r.created_by, r.created_at, r.submitted_at,
            r.published_by, r.published_at, w.name AS workspace_name,
            s.logo_object_key, s.accent_color, s.click_target_color,
            s.remove_branding, s.restricted_exports_enabled,
            s.watermark_restricted_exports
     FROM guides g
     JOIN guide_revisions r ON r.id = g.current_published_revision_id
     JOIN workspaces w ON w.id = g.workspace_id
     JOIN workspace_settings s ON s.workspace_id = g.workspace_id
     WHERE g.id = ? AND g.workspace_id = ? AND g.archived_at IS NULL
       AND r.status = 'published'`,
    guideId,
    workspaceId,
  );
  if (!revision || !revision.published_at || !revision.published_by || !revision.submitted_at) {
    throw new HttpError(404, "PUBLISHED_GUIDE_NOT_FOUND", "The published guide is unavailable.");
  }
  const [stepRows, audienceRows, review] = await Promise.all([
    rows<{
      id: string;
      kind: "action" | "heading" | "note" | "warning";
      title: string;
      body: string;
      expected_result: string | null;
      requires_confirmation: number;
      annotation_json: string;
    }>(
      db,
      `SELECT id, kind, title, body, expected_result, requires_confirmation,
              annotation_json
       FROM guide_steps WHERE revision_id = ? ORDER BY position`,
      revision.revision_id,
    ),
    rows<{ subject_type: "workspace" | "group" | "user"; subject_id: string }>(
      db,
      `SELECT subject_type, subject_id FROM guide_audiences WHERE revision_id = ?`,
      revision.revision_id,
    ),
    first<{ reviewer_user_id: string; decided_at: string }>(
      db,
      `SELECT reviewer_user_id, decided_at FROM review_assignments
       WHERE revision_id = ? AND status = 'approved' AND decided_at IS NOT NULL
       ORDER BY decided_at LIMIT 1`,
      revision.revision_id,
    ),
  ]);
  if (!review) throw new HttpError(409, "REVIEW_APPROVAL_REQUIRED", "The published revision has no approved review receipt.");

  const mediaIds = [...new Set(stepRows
    .map((step) => safeJson<{ screenshotMediaId?: string }>(step.annotation_json, {}).screenshotMediaId)
    .filter((item): item is string => Boolean(item)))];
  const mediaRows = mediaIds.length
    ? await rows<{
        id: string;
        object_key: string;
        content_type: "image/png" | "image/jpeg" | "image/webp";
        byte_size: number;
        width: number;
        height: number;
        sha256: string;
        created_at: string;
      }>(
         db,
         `SELECT id, object_key, content_type, byte_size, width, height, sha256, created_at
          FROM guide_media WHERE workspace_id = ? AND revision_id = ?
            AND id IN (SELECT value FROM json_each(?))`,
         workspaceId,
         revision.revision_id,
         JSON.stringify(mediaIds),
      )
    : [];
  const blocks: GuideBlock[] = stepRows.map((step) => {
    if (step.kind === "heading") {
      return { id: step.id, type: "heading", level: 2, text: step.title };
    }
    if (step.kind === "note" || step.kind === "warning") {
      return {
        id: step.id,
        type: "callout",
        tone: step.kind === "warning" ? "warning" : "note",
        title: step.title,
        text: step.body || step.title,
      };
    }
    const annotation = safeJson<{
      screenshotMediaId?: string;
      crop?: { x: number; y: number; width: number; height: number };
      annotations?: Array<{
        id: string;
        kind: "click" | "arrow" | "box" | "text";
        x: number;
        y: number;
        width?: number;
        height?: number;
        text?: string;
        color?: string;
      }>;
    }>(step.annotation_json, {});
    const media = mediaRows.find((item) => item.id === annotation.screenshotMediaId);
    let contractMedia: GuideActionMedia | undefined;
    if (media && media.content_type !== "image/webp") {
      const normalized = annotation.crop
        ? {
            x: annotation.crop.x > 1 ? annotation.crop.x / 100 : annotation.crop.x,
            y: annotation.crop.y > 1 ? annotation.crop.y / 100 : annotation.crop.y,
            width: annotation.crop.width > 1 ? annotation.crop.width / 100 : annotation.crop.width,
            height: annotation.crop.height > 1 ? annotation.crop.height / 100 : annotation.crop.height,
          }
        : undefined;
      const normalizeCoordinate = (value: number | undefined, fallback: number) => {
        const numeric = Number.isFinite(value) ? Number(value) : fallback;
        return Math.min(1, Math.max(0, numeric > 1 ? numeric / 100 : numeric));
      };
      const uiAnnotations = (annotation.annotations ?? []).slice(0, 100);
      const click = uiAnnotations.find((item) => item.kind === "click");
      const contractAnnotations = uiAnnotations
        .filter((item) => item.kind !== "click")
        .map((item) => {
          const x = normalizeCoordinate(item.x, 0);
          const y = normalizeCoordinate(item.y, 0);
          const width = Math.min(1 - x, Math.max(0.000001, normalizeCoordinate(item.width, 0.08)));
          const height = Math.min(1 - y, Math.max(0.000001, normalizeCoordinate(item.height, 0.08)));
          return {
            id: item.id,
            type:
              item.kind === "box"
                ? ("rectangle" as const)
                : item.kind === "text"
                  ? ("text" as const)
                  : ("arrow" as const),
            region: { x, y, width, height },
            color: /^#[0-9a-f]{6}$/i.test(item.color ?? "")
              ? item.color!
              : revision.accent_color,
            ...(item.kind === "text" ? { text: item.text?.trim() || "Annotation" } : {}),
          };
        });
      contractMedia = {
        mediaId: media.id,
        fileName: `${media.id}.${media.content_type === "image/png" ? "png" : "jpg"}`,
        mimeType: media.content_type,
        width: media.width,
        height: media.height,
        altText: `Redacted screenshot for ${step.title}`,
        sanitized: true,
        sanitizedAt: media.created_at,
        contentHash: media.sha256,
        ...(normalized ? { crop: normalized } : {}),
        ...(click
          ? {
              clickTarget: {
                point: {
                  x: normalizeCoordinate(click.x, 0.5),
                  y: normalizeCoordinate(click.y, 0.5),
                },
                color: /^#[0-9a-f]{6}$/i.test(click.color ?? "")
                  ? click.color!
                  : revision.click_target_color,
                radius: Math.min(
                  0.25,
                  Math.max(0.001, normalizeCoordinate(click.width, 0.035)),
                ),
              },
            }
          : {}),
        annotations: contractAnnotations,
        redactions: [],
      };
    }
    return {
      id: step.id,
      type: "action",
      title: step.title,
      instructions: step.body || step.title,
      ...(step.expected_result ? { expectedResult: step.expected_result } : {}),
      ...(step.requires_confirmation ? { requiresConfirmation: true } : {}),
      ...(contractMedia ? { media: contractMedia } : {}),
    };
  });
  const workspaceAudience = audienceRows.some((item) => item.subject_type === "workspace");
  const audience: GuideAudience = workspaceAudience
    ? { mode: "workspace", workspaceId }
    : {
        mode: "restricted",
        workspaceId,
        targets: audienceRows.map((item) => ({
          type: item.subject_type as "group" | "user",
          id: item.subject_id,
        })),
      };
  const [createdBy, reviewedBy, publishedBy, privacyReviewedBy] = await Promise.all([
    displayName(db, workspaceId, revision.created_by),
    displayName(db, workspaceId, review.reviewer_user_id),
    displayName(db, workspaceId, revision.published_by),
    displayName(db, workspaceId, revision.privacy_reviewed_by),
  ]);
  const restricted = audience.mode === "restricted";
  const candidate: PublishedGuideRevision = {
    schemaVersion: 1,
    guideId,
    revisionId: revision.revision_id,
    workspaceId,
    revisionNumber: revision.version,
    source: revision.source_type === "capture" ? "browser-capture" : "manual",
    title: revision.title,
    summary: revision.summary,
    createdAt: revision.created_at,
    createdBy: { userId: revision.created_by, displayName: createdBy },
    blocks,
    audience,
    privacyReview:
      revision.source_type === "capture"
        ? {
            required: true,
            status: "approved",
            originalMediaRetained: false,
            reviewedAt: revision.privacy_reviewed_at!,
            reviewedBy: {
              userId: revision.privacy_reviewed_by!,
              displayName: privacyReviewedBy,
            },
            findingsResolved: true,
          }
        : {
            required: false,
            status: "not-required",
            originalMediaRetained: false,
          },
    branding: {
      workspaceId,
      workspaceName: revision.workspace_name,
      ...(revision.logo_object_key ? { logoMediaId: revision.logo_object_key } : {}),
      accentColor: revision.accent_color,
      clickTargetColor: revision.click_target_color,
      showKnowHowBranding: revision.remove_branding !== 1,
    },
    exportPolicy: {
      allowedFormats: ["live-link", "pdf", "html", "markdown"],
      restrictedGuideExports:
        !restricted || revision.restricted_exports_enabled === 1 ? "allowed" : "disabled",
      watermark: {
        mode: restricted && revision.watermark_restricted_exports === 1 ? "required" : "optional",
        includeViewer: true,
        includeWorkspace: true,
        includeDate: true,
      },
    },
    lifecycle: "published",
    submittedAt: revision.submitted_at,
    submittedBy: { userId: revision.created_by, displayName: createdBy },
    reviewedAt: review.decided_at,
    reviewedBy: { userId: review.reviewer_user_id, displayName: reviewedBy },
    publishedAt: revision.published_at,
    publishedBy: { userId: revision.published_by, displayName: publishedBy },
  };
  return {
    revision: parsePublishedGuideRevision(candidate),
    mediaRows,
    logoObjectKey: revision.logo_object_key,
    restricted,
  };
}

async function mediaAssets(
  workspaceId: string,
  mediaRows: Array<{
    id: string;
    object_key: string;
    content_type: "image/png" | "image/jpeg" | "image/webp";
    byte_size: number;
  }>,
  logoObjectKey: string | null,
) {
  const bucket = requireR2Binding(env.MEDIA);
  const assets: GuideExportAsset[] = [];
  const claimedBytes = mediaRows.reduce((total, media) => total + Number(media.byte_size), 0);
  if (!Number.isSafeInteger(claimedBytes) || claimedBytes > MAX_EXPORT_ASSET_BYTES) {
    throw new HttpError(413, "EXPORT_ASSETS_TOO_LARGE", "This guide contains too much media to export safely.");
  }
  let loadedBytes = 0;
  for (const media of mediaRows) {
    if (media.content_type === "image/webp") continue;
    const object = await readPrivateMedia(bucket, media.object_key, workspaceId);
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    loadedBytes += bytes.byteLength;
    if (loadedBytes > MAX_EXPORT_ASSET_BYTES) {
      throw new HttpError(413, "EXPORT_ASSETS_TOO_LARGE", "This guide contains too much media to export safely.");
    }
    assets.push({ mediaId: media.id, mimeType: media.content_type, bytes });
  }
  if (logoObjectKey) {
    const logo = await readWorkspaceLogo(bucket, logoObjectKey, workspaceId);
    const mimeType = logo.httpMetadata?.contentType;
    if (mimeType === "image/png" || mimeType === "image/jpeg") {
      const bytes = new Uint8Array(await new Response(logo.body).arrayBuffer());
      loadedBytes += bytes.byteLength;
      if (loadedBytes > MAX_EXPORT_ASSET_BYTES) {
        throw new HttpError(413, "EXPORT_ASSETS_TOO_LARGE", "This guide contains too much media to export safely.");
      }
      assets.push({ mediaId: logoObjectKey, mimeType, bytes });
    }
  }
  return assets;
}

export async function GET(request: Request) {
  const eventId = crypto.randomUUID();
  let db: D1DatabaseLike | null = null;
  let exportContext:
    | {
        repository: D1KnowHowRepository;
        identity: Awaited<ReturnType<typeof requireVerifiedIdentity>>;
        workspaceId: string;
        guideId: string;
        format: "pdf" | "html" | "markdown";
      }
    | undefined;
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId") ?? "";
    const guideId = url.searchParams.get("guideId") ?? "";
    const format = url.searchParams.get("format");
    if (!workspaceId || !guideId || (format !== "pdf" && format !== "html" && format !== "markdown")) {
      throw new HttpError(400, "EXPORT_REQUEST_INVALID", "Workspace, guide, and export format are required.");
    }
    db = requireD1Binding(env.DB);
    const repository = new D1KnowHowRepository(db);
    await repository.ensureSecurityGuards();
    const identity = await requireVerifiedIdentity(request);
    const access = await repository.getWorkspaceAccess(workspaceId, identity.userId);
    if (!access) throw new HttpError(403, "WORKSPACE_ACCESS_REQUIRED", "You do not belong to this workspace.");
    const facts = await repository.getGuideAccessFacts(workspaceId, guideId, identity.userId);
    if (!facts) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    const isPlatformAdministrator = await repository.isPlatformAdministrator(identity.userId);
    const context = {
      isVerifiedIdentity: true,
      isPlatformAdministrator,
      membershipStatus: access.membershipStatus,
      workspaceStatus: access.workspaceStatus,
      roles: access.roles,
      capabilities: access.capabilities,
      guide: facts,
    } as const;
    if (!authorize("guide.export", context).allowed) {
      throw new HttpError(403, "EXPORT_NOT_ALLOWED", "This guide cannot be exported by your account.");
    }
    exportContext = { repository, identity, workspaceId, guideId, format };
    const built = await buildPublishedRevision(db, workspaceId, guideId);
    const assets = await mediaAssets(workspaceId, built.mediaRows, built.logoObjectKey);
    const exportedAt = new Date().toISOString();
    const options: GuideRenderOptions = {
      assets,
      ...(built.restricted && built.revision.exportPolicy.watermark.mode === "required"
        ? {
            watermark: {
              viewer: identity.name || identity.email,
              workspace: built.revision.branding.workspaceName,
              exportedAt,
            },
          }
        : {}),
    };
    let body: Uint8Array | string;
    let contentType: string;
    if (format === "pdf") {
      body = await renderGuideToPdf(built.revision, options);
      contentType = "application/pdf";
    } else if (format === "html") {
      body = renderGuideToHtml(built.revision, options);
      contentType = "text/html; charset=utf-8";
    } else {
      body = renderGuideToMarkdown(built.revision, options);
      contentType = "text/markdown; charset=utf-8";
    }
    const exportId = crypto.randomUUID();
    const auditStatements: D1PreparedStatementLike[] = [
      statement(
        db,
        `INSERT INTO exports (id, workspace_id, revision_id, format, status,
          watermarked, created_by, created_at, completed_at)
         VALUES (?, ?, ?, ?, 'ready', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        exportId,
        workspaceId,
        built.revision.revisionId,
        format,
        options.watermark ? 1 : 0,
        identity.userId,
      ),
      statement(
        db,
        `INSERT INTO workspace_metrics_daily
           (workspace_id, metric_date, exports, updated_at)
         VALUES (?, date('now'), 1, CURRENT_TIMESTAMP)
         ON CONFLICT(workspace_id, metric_date) DO UPDATE SET
           exports = exports + 1, updated_at = CURRENT_TIMESTAMP`,
        workspaceId,
      ),
    ];
    await repository.executeAuditedMutation({
      workspaceId,
      actor: { userId: identity.userId, email: identity.email, name: identity.name },
      event: {
        action: "guide.exported",
        targetType: "guide",
        targetId: guideId,
        targetLabel: built.revision.title,
        summary: `${built.revision.title} exported as ${format.toUpperCase()}`,
        metadata: {
          revisionId: built.revision.revisionId,
          format,
          restricted: built.restricted,
          watermarked: Boolean(options.watermark),
        },
      },
      statements: auditStatements,
    });
    const headers = new Headers({
      "content-type": contentType,
      "content-disposition": `attachment; filename="${safeFileName(built.revision.title)}.${format === "markdown" ? "md" : format}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (format === "html") {
      headers.set(
        "content-security-policy",
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      );
    }
    return new Response(typeof body === "string" ? body : body.slice().buffer, { headers });
  } catch (error) {
    if (db && exportContext) {
      try {
        await exportContext.repository.executeAuditedMutation({
          workspaceId: exportContext.workspaceId,
          actor: {
            userId: exportContext.identity.userId,
            email: exportContext.identity.email,
            name: exportContext.identity.name,
          },
          event: {
            action: "guide.export-failed",
            targetType: "guide",
            targetId: exportContext.guideId,
            summary: "Guide export failed",
            metadata: { format: exportContext.format, failureCode: "RENDER_FAILED" },
          },
          statements: [
            statement(
              db,
              `INSERT INTO workspace_metrics_daily
                 (workspace_id, metric_date, failed_operations, updated_at)
               VALUES (?, date('now'), 1, CURRENT_TIMESTAMP)
               ON CONFLICT(workspace_id, metric_date) DO UPDATE SET
                 failed_operations = failed_operations + 1,
                 updated_at = CURRENT_TIMESTAMP`,
              exportContext.workspaceId,
            ),
          ],
        });
      } catch {
        // Preserve the original, user-relevant export failure.
      }
    }
    return toErrorResponse(error, eventId);
  }
}
