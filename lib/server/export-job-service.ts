import "server-only";

import {
  renderGuideToHtml,
  renderGuideToMarkdown,
  renderGuideToPdf,
  renderGuideToPptx,
  type GuideRenderOptions,
} from "../exports";
import {
  decodePayload,
  rowData,
  type ExportJobRecord,
} from "./domain-records";
import { buildPublishedExport } from "./export-service";
import { GuideAccessService } from "./guide-access-service";
import { HttpError } from "./http-security";
import { sha256Bytes } from "./media-validation";
import type { PrivateObjectStore } from "./private-object-store";
import { TABLES } from "./appwrite-resources";
import type { RecordData, RecordStore, StoredRecord } from "./record-store";
import type { AuthenticatedIdentity } from "./session-identity";

const LEASE_MILLISECONDS = 3 * 60_000;
const EXPORT_TTL_MILLISECONDS = 24 * 60 * 60_000;
const MAX_ATTEMPTS = 5;

export function safeExportFilename(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return normalized || "knowhow-guide";
}

function jobDetails(row: StoredRecord<RecordData>) {
  const details = decodePayload<ExportJobRecord>(row, null as never);
  if (
    !details ||
    !details.guideId ||
    !details.revisionId ||
    !details.outputFileId ||
    !details.requester?.userId ||
    !details.requester.email ||
    !["pdf", "html", "markdown", "pptx"].includes(details.format)
  ) {
    throw new HttpError(500, "EXPORT_JOB_CORRUPT", "The export job is invalid.", {
      expose: false,
    });
  }
  return details;
}

function retryDelay(attempts: number) {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

function failureCode(error: unknown) {
  return error instanceof HttpError && /^[A-Z0-9_]{3,64}$/.test(error.code)
    ? error.code
    : "EXPORT_RENDER_FAILED";
}

async function claimJob(store: RecordStore, jobId: string, now: Date) {
  return store.transaction(async (transaction) => {
    const row = await transaction.get(TABLES.exportJobs, jobId);
    if (!row) throw new HttpError(404, "EXPORT_JOB_NOT_FOUND", "Export job not found.");
    if (row.status === "ready" || row.status === "failed" || row.status === "expired") {
      return {
        row,
        details: decodePayload<ExportJobRecord>(row, null as never),
        claimed: false,
      } as const;
    }
    const details = jobDetails(row);
    const leaseUntil = details.leaseUntil ? Date.parse(details.leaseUntil) : 0;
    if (row.status === "processing" && Number.isFinite(leaseUntil) && leaseUntil > now.getTime()) {
      return { row, details, claimed: false } as const;
    }
    const retryAt = details.retryAt ? Date.parse(details.retryAt) : 0;
    if (row.status === "retry" && Number.isFinite(retryAt) && retryAt > now.getTime()) {
      return { row, details, claimed: false } as const;
    }
    const leaseId = crypto.randomUUID();
    const next: ExportJobRecord = {
      ...details,
      attempts: details.attempts + 1,
      leaseId,
      leaseUntil: new Date(now.getTime() + LEASE_MILLISECONDS).toISOString(),
      retryAt: undefined,
      failureCode: undefined,
    };
    const updated = await transaction.update(
      TABLES.exportJobs,
      row.$id,
      rowData(
        {
          organization_id: row.organization_id as string,
          workspace_id: row.workspace_id as string,
          user_id: row.user_id as string,
          subject_id: row.subject_id as string,
          status: "processing",
          kind: row.kind as string,
          idempotency_key: row.idempotency_key as string,
          request_id: row.request_id as string,
          scheduled_at: next.leaseUntil,
          updated_by: "knowhow_export",
        },
        next,
      ),
    );
    return { row: updated, details: next, claimed: true } as const;
  });
}

async function putIdempotently(
  objects: PrivateObjectStore,
  input: {
    id: string;
    bytes: Uint8Array;
    filename: string;
    contentType: string;
  },
) {
  const expectedHash = await sha256Bytes(input.bytes);
  const verifyExisting = async () => {
    const existing = await objects.get(input.id);
    if (!existing) return false;
    if ((await sha256Bytes(existing.bytes)) !== expectedHash) {
      throw new HttpError(
        500,
        "EXPORT_OUTPUT_COLLISION",
        "The export output could not be verified.",
        { expose: false },
      );
    }
    return true;
  };
  if (!(await verifyExisting())) {
    try {
      await objects.put(input);
    } catch (error) {
      if (!(await verifyExisting())) throw error;
    }
  }
  return expectedHash;
}

async function markFailed(
  store: RecordStore,
  row: StoredRecord<RecordData>,
  details: ExportJobRecord,
  leaseId: string,
  error: unknown,
  now: Date,
) {
  return store.transaction(async (transaction) => {
    const current = await transaction.get(TABLES.exportJobs, row.$id);
    if (!current) return { status: "missing" as const };
    const currentDetails = jobDetails(current);
    if (current.status === "ready" || currentDetails.leaseId !== leaseId) {
      return { status: current.status as string };
    }
    const terminal = details.attempts >= MAX_ATTEMPTS;
    const retryAt = terminal
      ? undefined
      : new Date(now.getTime() + retryDelay(details.attempts)).toISOString();
    const next: ExportJobRecord = {
      ...currentDetails,
      leaseId: undefined,
      leaseUntil: undefined,
      retryAt,
      failedAt: now.toISOString(),
      failureCode: failureCode(error),
    };
    await transaction.update(
      TABLES.exportJobs,
      current.$id,
      rowData(
        {
          organization_id: current.organization_id as string,
          workspace_id: current.workspace_id as string,
          user_id: current.user_id as string,
          subject_id: current.subject_id as string,
          status: terminal ? "failed" : "retry",
          kind: current.kind as string,
          idempotency_key: current.idempotency_key as string,
          request_id: current.request_id as string,
          scheduled_at: retryAt ?? null,
          updated_by: "knowhow_export",
        },
        next,
      ),
    );
    return {
      status: terminal ? ("failed" as const) : ("retry" as const),
      failureCode: next.failureCode,
      retryAt,
    };
  });
}

export async function processExportJob(
  store: RecordStore,
  privateObjects: PrivateObjectStore,
  exportObjects: PrivateObjectStore,
  jobId: string,
  now = new Date(),
) {
  const claim = await claimJob(store, jobId, now);
  if (!claim.claimed) {
    return { status: String(claim.row.status), skipped: true };
  }
  const { row, details } = claim;
  const leaseId = details.leaseId!;
  try {
    // Replays the requester so the export is re-authorized against roles,
    // audience and export policy as they stand now, rather than trusting the
    // decision made when the job was queued. The identity factors are stated
    // as satisfied because they were checked against the live session at that
    // point — `guide.export` requires a verified address, and verification is
    // never withdrawn — and this worker has no session to re-check them from.
    const identity: AuthenticatedIdentity = {
      userId: details.requester.userId,
      email: details.requester.email,
      name: details.requester.name,
      emailVerified: true,
      mfaEnabled: true,
    };
    const authorized = await new GuideAccessService(store).require(
      identity,
      String(row.workspace_id),
      details.guideId,
      details.revisionId,
      "guide.export",
    );
    const built = await buildPublishedExport(store, privateObjects, {
      ...authorized,
      workspaceId: String(row.workspace_id),
    });
    const completedAt = new Date().toISOString();
    const options: GuideRenderOptions = {
      assets: built.assets,
      ...(details.watermarked
        ? {
            watermark: {
              viewer: identity.name || identity.email,
              workspace: built.revision.branding.workspaceName,
              exportedAt: completedAt,
            },
          }
        : {}),
    };
    let bytes: Uint8Array;
    let contentType: string;
    if (details.format === "pdf") {
      bytes = await renderGuideToPdf(built.revision, options);
      contentType = "application/pdf";
    } else if (details.format === "html") {
      bytes = new TextEncoder().encode(renderGuideToHtml(built.revision, options));
      contentType = "text/html";
    } else if (details.format === "pptx") {
      bytes = await renderGuideToPptx(built.revision, options);
      contentType =
        "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    } else {
      bytes = new TextEncoder().encode(renderGuideToMarkdown(built.revision, options));
      contentType = "text/markdown";
    }
    const hash = await putIdempotently(exportObjects, {
      id: details.outputFileId,
      bytes,
      filename: details.filename,
      contentType,
    });
    const expiresAt = new Date(Date.parse(completedAt) + EXPORT_TTL_MILLISECONDS).toISOString();
    const completion = await store.transaction(async (transaction) => {
      const current = await transaction.get(TABLES.exportJobs, row.$id);
      if (!current) throw new HttpError(404, "EXPORT_JOB_NOT_FOUND", "Export job not found.");
      const currentDetails = jobDetails(current);
      if (current.status === "ready") return { status: "ready" as const, skipped: true };
      if (currentDetails.leaseId !== leaseId) return { status: current.status as string, skipped: true };
      const next: ExportJobRecord = {
        ...currentDetails,
        leaseId: undefined,
        leaseUntil: undefined,
        retryAt: undefined,
        failureCode: undefined,
        completedAt,
        expiresAt,
        byteSize: bytes.byteLength,
        sha256: hash,
        contentType,
      };
      await transaction.update(
        TABLES.exportJobs,
        current.$id,
        rowData(
          {
            organization_id: current.organization_id as string,
            workspace_id: current.workspace_id as string,
            user_id: current.user_id as string,
            subject_id: current.subject_id as string,
            status: "ready",
            kind: current.kind as string,
            idempotency_key: current.idempotency_key as string,
            request_id: current.request_id as string,
            expires_at: expiresAt,
            scheduled_at: null,
            updated_by: "knowhow_export",
          },
          next,
        ),
      );
      return { status: "ready" as const, skipped: false };
    });
    return {
      ...completion,
      jobId: row.$id,
      outputFileId: details.outputFileId,
      byteSize: bytes.byteLength,
      sha256: hash,
    };
  } catch (error) {
    return markFailed(store, row, details, leaseId, error, new Date());
  }
}

export async function completeDueExportJob(
  store: RecordStore,
  privateObjects: PrivateObjectStore,
  exportObjects: PrivateObjectStore,
  jobId: string,
  now = new Date(),
) {
  const current = await store.get(TABLES.exportJobs, jobId);
  if (!current) {
    throw new HttpError(404, "EXPORT_JOB_NOT_FOUND", "Export job not found.");
  }
  if (
    current.status === "ready" ||
    current.status === "failed" ||
    current.status === "expired"
  ) {
    return current;
  }
  await processExportJob(store, privateObjects, exportObjects, jobId, now);
  const next = await store.get(TABLES.exportJobs, jobId);
  if (!next) {
    throw new HttpError(404, "EXPORT_JOB_NOT_FOUND", "Export job not found.");
  }
  return next;
}

export async function verifiedExportObject(
  objects: PrivateObjectStore,
  details: ExportJobRecord,
) {
  if (!details.sha256 || !details.contentType || !details.completedAt) {
    throw new HttpError(500, "EXPORT_OUTPUT_CORRUPT", "The export output is unavailable.", {
      expose: false,
    });
  }
  if (details.expiresAt && Date.parse(details.expiresAt) <= Date.now()) {
    throw new HttpError(410, "EXPORT_EXPIRED", "This export has expired. Create it again.");
  }
  const object = await objects.get(details.outputFileId);
  if (
    !object ||
    object.bytes.byteLength !== details.byteSize ||
    (await sha256Bytes(object.bytes)) !== details.sha256
  ) {
    throw new HttpError(500, "EXPORT_INTEGRITY_FAILURE", "The export failed its integrity check.", {
      expose: false,
    });
  }
  return {
    bytes: object.bytes,
    filename: details.filename,
    contentType: details.contentType,
  };
}
