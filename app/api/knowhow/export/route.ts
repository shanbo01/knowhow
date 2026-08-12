import type { WorkspaceSettings } from "../../../../lib/knowhow-types";
import { appendAudit } from "../../../../lib/server/audit-service";
import {
  decodePayload,
  DEFAULT_WORKSPACE_SETTINGS,
  rowData,
  type ExportJobRecord,
  type GuideRecord,
} from "../../../../lib/server/domain-records";
import {
  safeExportFilename,
  verifiedExportObject,
} from "../../../../lib/server/export-job-service";
import { GuideAccessService } from "../../../../lib/server/guide-access-service";
import {
  assertCookieMutationRequest,
  HttpError,
  jsonResponse,
  readJsonObject,
  toErrorResponse,
} from "../../../../lib/server/http-security";
import {
  deterministicResourceId,
  resourceId,
} from "../../../../lib/server/ids";
import { TABLES } from "../../../../lib/server/appwrite-resources";
import { consumeFixedWindows } from "../../../../lib/server/rate-limit-service";
import {
  allowedRequestOrigins,
  correlationId,
  createRequestServices,
  withRequestId,
} from "../../../../lib/server/request-services";
import { requireVerifiedSession } from "../../../../lib/server/session-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const FORMATS = new Set(["pdf", "html", "markdown"] as const);

function exportFormat(value: unknown): ExportJobRecord["format"] {
  if (typeof value !== "string" || !FORMATS.has(value as ExportJobRecord["format"])) {
    throw new HttpError(400, "EXPORT_FORMAT_INVALID", "Choose PDF, HTML, or Markdown.");
  }
  return value as ExportJobRecord["format"];
}

function contentDisposition(filename: string) {
  const safe = filename.replace(/[^a-z0-9._-]/gi, "-").slice(0, 100);
  return `attachment; filename="${safe || "knowhow-export"}"`;
}

export async function POST(request: Request) {
  const requestId = correlationId(request);
  try {
    assertCookieMutationRequest(request, allowedRequestOrigins());
    const body = await readJsonObject(request, 4_096);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const guideId = typeof body.guideId === "string" ? body.guideId.trim() : "";
    const format = exportFormat(body.format);
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim() ?? "";
    if (!ID.test(workspaceId) || !ID.test(guideId)) {
      throw new HttpError(400, "EXPORT_REQUEST_INVALID", "Workspace and guide are required.");
    }
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new HttpError(400, "IDEMPOTENCY_KEY_INVALID", "A valid idempotency key is required.");
    }
    const identity = await requireVerifiedSession(request);
    const { store } = createRequestServices();
    await consumeFixedWindows(store, [
      {
        scope: "knowhow.export",
        subject: identity.userId,
        limit: 20,
        windowSeconds: 600,
      },
    ]);
    const guideRow = await store.get(TABLES.guides, guideId);
    const guide = guideRow
      ? decodePayload<GuideRecord>(guideRow, null as never)
      : null;
    if (
      !guideRow ||
      guideRow.workspace_id !== workspaceId ||
      !guide?.publishedRevisionId ||
      guide.deletedAt
    ) {
      throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    }
    const authorized = await new GuideAccessService(store).require(
      identity,
      workspaceId,
      guideId,
      guide.publishedRevisionId,
      "guide.export",
    );
    const [audienceRows, settingRows] = await Promise.all([
      store.list(TABLES.guideAudiences, {
        filters: [{ field: "subject_id", value: guide.publishedRevisionId }],
      }),
      store.list(TABLES.workspaceSettings, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        limit: 1,
      }),
    ]);
    const settings = settingRows[0]
      ? {
          ...DEFAULT_WORKSPACE_SETTINGS,
          ...decodePayload<Partial<WorkspaceSettings>>(settingRows[0], {}),
        }
      : DEFAULT_WORKSPACE_SETTINGS;
    const restricted = !audienceRows.some((row) => row.kind === "workspace");
    const requestedAt = new Date().toISOString();
    const jobId = await deterministicResourceId(
      "export",
      `${identity.userId}:${workspaceId}:${guideId}:${format}:${idempotencyKey}`,
    );
    const outputFileId = await deterministicResourceId("output", jobId);
    const extension = format === "markdown" ? "md" : format;
    const details: ExportJobRecord = {
      guideId,
      revisionId: guide.publishedRevisionId,
      format,
      filename: `${safeExportFilename(guide.title)}.${extension}`,
      outputFileId,
      requestedAt,
      requester: {
        userId: identity.userId,
        name: identity.name,
        email: identity.email,
      },
      attempts: 0,
      watermarked: restricted && settings.watermarkExports,
    };
    let created = false;
    try {
      await store.transaction(async (transaction) => {
        const existing = await transaction.get(TABLES.exportJobs, jobId);
        if (existing) return;
        await transaction.create(
          TABLES.exportJobs,
          jobId,
          rowData(
            {
              organization_id: authorized.access.workspace.organizationId,
              workspace_id: workspaceId,
              user_id: identity.userId,
              subject_id: guide.publishedRevisionId!,
              status: "queued",
              kind: format,
              idempotency_key: idempotencyKey,
              request_id: requestId,
              scheduled_at: requestedAt,
              created_by: identity.userId,
            },
            details,
          ),
        );
        await transaction.create(
          TABLES.usageEvents,
          resourceId("usage"),
          rowData(
            {
              organization_id: authorized.access.workspace.organizationId,
              workspace_id: workspaceId,
              user_id: identity.userId,
              subject_id: guideId,
              kind: "guide.export-requested",
              status: "recorded",
              occurred_at: requestedAt,
              request_id: requestId,
              created_by: identity.userId,
            },
            { format, restricted },
          ),
        );
        await appendAudit(transaction, identity, workspaceId, {
          action: "guide.export-requested",
          targetType: "guide",
          targetId: guideId,
          targetLabel: authorized.revision.title,
          summary: `${authorized.revision.title} export requested as ${format.toUpperCase()}`,
          metadata: {
            revisionId: guide.publishedRevisionId,
            format,
            restricted,
            watermarked: details.watermarked,
            requestId,
          },
        });
        created = true;
      });
    } catch (error) {
      // A concurrent request may have committed the deterministic job first.
      if (!(await store.get(TABLES.exportJobs, jobId))) throw error;
    }
    const job = await store.get(TABLES.exportJobs, jobId);
    if (!job || job.user_id !== identity.userId) {
      throw new HttpError(500, "EXPORT_QUEUE_FAILED", "The export could not be queued.", {
        expose: false,
      });
    }
    const replay = decodePayload<ExportJobRecord>(job, null as never);
    if (
      !replay ||
      replay.guideId !== guideId ||
      replay.revisionId !== guide.publishedRevisionId ||
      replay.format !== format
    ) {
      throw new HttpError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for another export.",
      );
    }
    return withRequestId(
      jsonResponse(
        {
          jobId,
          status: String(job.status),
          created,
          pollAfterMs: 750,
          requestId,
        },
        { status: created ? 202 : 200 },
      ),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId")?.trim() ?? "";
    if (!ID.test(jobId)) {
      throw new HttpError(400, "EXPORT_JOB_ID_INVALID", "Export job ID is invalid.");
    }
    const identity = await requireVerifiedSession(request);
    const { store, exportObjects } = createRequestServices();
    await consumeFixedWindows(store, [
      {
        scope: "knowhow.export-status",
        subject: identity.userId,
        limit: 180,
        windowSeconds: 600,
      },
    ]);
    const job = await store.get(TABLES.exportJobs, jobId);
    if (!job || job.user_id !== identity.userId) {
      throw new HttpError(404, "EXPORT_JOB_NOT_FOUND", "Export job not found.");
    }
    const details = decodePayload<ExportJobRecord>(job, null as never);
    if (!details) {
      throw new HttpError(500, "EXPORT_JOB_CORRUPT", "The export job is unavailable.", {
        expose: false,
      });
    }
    await new GuideAccessService(store).require(
      identity,
      String(job.workspace_id),
      details.guideId,
      details.revisionId,
      "guide.export",
    );
    const expired = Boolean(
      details.expiresAt && Date.parse(details.expiresAt) <= Date.now(),
    );
    if (url.searchParams.get("download") === "1") {
      if (job.status !== "ready" || expired) {
        throw new HttpError(
          expired ? 410 : 409,
          expired ? "EXPORT_EXPIRED" : "EXPORT_NOT_READY",
          expired ? "This export has expired. Create it again." : "The export is not ready yet.",
        );
      }
      const object = await verifiedExportObject(exportObjects, details);
      const headers = new Headers({
        "content-type": object.contentType,
        "content-disposition": contentDisposition(object.filename),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      if (details.format === "html") {
        headers.set(
          "content-security-policy",
          "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        );
      }
      return withRequestId(
        new Response(object.bytes.slice().buffer as ArrayBuffer, { headers }),
        requestId,
      );
    }
    return withRequestId(
      jsonResponse({
        jobId,
        status: expired ? "expired" : String(job.status),
        format: details.format,
        filename: details.filename,
        attempts: details.attempts,
        ...(job.status === "failed"
          ? { error: "The export could not be created. Try again or contact support." }
          : {}),
        ...(details.completedAt ? { completedAt: details.completedAt } : {}),
        ...(details.expiresAt ? { expiresAt: details.expiresAt } : {}),
        requestId,
      }),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
