import {
  isCapturedGuideSource,
  parsePublishedGuideRevision,
  type GuideActionMedia,
  type GuideAudience,
  type GuideBlock,
  type PublishedGuideRevision,
} from "../guide-contracts";
import type { EditorBlock, WorkspaceSettings } from "../knowhow-types";
import type { GuideExportAsset } from "../exports";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  decodePayload,
  type GuideAudienceRecord,
  type GuideRecord,
  type PrivateMediaRecord,
  type RevisionRecord,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
} from "./domain-records";
import { HttpError } from "./http-security";
import { sha256Bytes } from "./media-validation";
import { TABLES } from "./appwrite-resources";
import type { PrivateObjectStore } from "./private-object-store";
import type { RecordData, RecordStore, StoredRecord } from "./record-store";

const MAX_EXPORT_ASSET_BYTES = 32 * 1024 * 1024;

function value(candidate: unknown, fallback = "") {
  return typeof candidate === "string" ? candidate : fallback;
}

function annotationMedia(
  step: EditorBlock,
  media: PrivateMediaRecord | undefined,
  settings: WorkspaceSettings,
): GuideActionMedia | undefined {
  if (!media || media.contentType === "image/webp") return undefined;
  const click = step.annotations?.find((item) => item.kind === "click");
  const annotations = (step.annotations ?? [])
    .filter((item) => item.kind !== "click")
    .map((item) => {
      const width = Math.min(1 - item.x, Math.max(0.000001, item.width ?? 0.08));
      const height = Math.min(1 - item.y, Math.max(0.000001, item.height ?? 0.08));
      return {
        id: item.id,
        type:
          item.kind === "box"
            ? ("rectangle" as const)
            : item.kind === "text"
              ? ("text" as const)
              : ("arrow" as const),
        region: { x: item.x, y: item.y, width, height },
        color: /^#[0-9a-f]{6}$/i.test(item.color ?? "")
          ? item.color!
          : settings.accentColor,
        ...(item.kind === "text" ? { text: item.text?.trim() || "Annotation" } : {}),
      };
    });
  return {
    mediaId: media.storageFileId,
    fileName: media.filename,
    mimeType: media.contentType,
    width: media.width,
    height: media.height,
    altText: `Redacted screenshot for ${step.title}`,
    sanitized: true,
    sanitizedAt: media.createdAt,
    contentHash: media.sha256,
    ...(step.crop ? { crop: step.crop } : {}),
    ...(click
      ? {
          clickTarget: {
            point: { x: click.x, y: click.y },
            color: /^#[0-9a-f]{6}$/i.test(click.color ?? "")
              ? click.color!
              : settings.clickTargetColor,
            radius: Math.min(0.25, Math.max(0.001, click.width ?? 0.035)),
          },
        }
      : {}),
    annotations,
    redactions: [],
  };
}

function blocks(
  stepRows: Array<StoredRecord<RecordData>>,
  media: Map<string, PrivateMediaRecord>,
  settings: WorkspaceSettings,
): GuideBlock[] {
  return stepRows
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
    .map((row) => decodePayload<EditorBlock>(row, null as never))
    .map((step) => {
      if (step.kind === "heading") {
        return { id: step.id, type: "heading", level: 2, text: step.title };
      }
      if (step.kind === "note" || step.kind === "warning") {
        return {
          id: step.id,
          type: "callout",
          tone: step.kind === "warning" ? "warning" : "note",
          title: step.title,
          text: step.description || step.title,
        };
      }
      const image = step.screenshotMediaId ? media.get(step.screenshotMediaId) : undefined;
      return {
        id: step.id,
        type: "action",
        title: step.title,
        instructions: step.description || step.title,
        ...(image ? { media: annotationMedia(step, image, settings) } : {}),
      };
    });
}

async function displayNames(store: RecordStore, workspaceId: string) {
  const members = await store.list(TABLES.workspaceMembers, {
    filters: [{ field: "workspace_id", value: workspaceId }],
  });
  return new Map(
    members.map((row) => {
      const member = decodePayload<WorkspaceMemberRecord>(row, {
        name: value(row.email),
        roles: [],
        capabilities: [],
        groupIds: [],
      });
      return [value(row.user_id), member.name || value(row.email)] as const;
    }),
  );
}

export async function buildPublishedExport(
  store: RecordStore,
  objects: PrivateObjectStore,
  input: {
    workspaceId: string;
    guideRow: StoredRecord<RecordData>;
    guide: GuideRecord;
    revisionRow: StoredRecord<RecordData>;
    revision: RevisionRecord;
  },
) {
  const { workspaceId, guideRow, guide, revisionRow, revision } = input;
  if (
    guide.publishedRevisionId !== revisionRow.$id ||
    revision.status !== "published" ||
    !revision.publishedAt ||
    !revision.publishedBy
  ) {
    throw new HttpError(404, "PUBLISHED_GUIDE_NOT_FOUND", "The published guide is unavailable.");
  }
  if (
    isCapturedGuideSource(revision.source) &&
    (!revision.privacyReviewedAt || !revision.privacyReviewedBy)
  ) {
    throw new HttpError(409, "PRIVACY_REVIEW_REQUIRED", "The captured guide has no privacy review receipt.");
  }
  const workspaceRow = await store.get(TABLES.workspaces, workspaceId);
  if (!workspaceRow) throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
  const workspace = decodePayload<WorkspaceRecord>(workspaceRow, null as never);
  const [stepRows, audienceRows, reviewRows, mediaRows, settingRows, names] = await Promise.all([
    store.list(TABLES.guideSteps, { filters: [{ field: "subject_id", value: revisionRow.$id }] }),
    store.list(TABLES.guideAudiences, { filters: [{ field: "subject_id", value: revisionRow.$id }] }),
    store.list(TABLES.reviewAssignments, { filters: [{ field: "subject_id", value: revisionRow.$id }] }),
    store.list(TABLES.privateMedia, {
      filters: [
        { field: "workspace_id", value: workspaceId },
        { field: "subject_id", value: revisionRow.$id },
        { field: "status", value: "ready" },
      ],
    }),
    store.list(TABLES.workspaceSettings, { filters: [{ field: "workspace_id", value: workspaceId }], limit: 1 }),
    displayNames(store, workspaceId),
  ]);
  const settings = settingRows[0]
    ? { ...DEFAULT_WORKSPACE_SETTINGS, ...decodePayload<Partial<WorkspaceSettings>>(settingRows[0], {}) }
    : DEFAULT_WORKSPACE_SETTINGS;
  const review = reviewRows.find((row) => row.status === "approved");
  if (!review && settings.requireReviewBeforePublish) {
    throw new HttpError(409, "REVIEW_APPROVAL_REQUIRED", "The published revision has no approved review receipt.");
  }
  const submittedAt = revision.submittedAt ?? revision.publishedAt;
  const submittedBy = revision.submittedBy ?? revision.publishedBy;
  const reviewedAt = revision.reviewedAt ?? revision.publishedAt;
  const reviewedBy = revision.reviewedBy ?? revision.publishedBy;
  const media = new Map(
    mediaRows.map((row) => [row.$id, decodePayload<PrivateMediaRecord>(row, null as never)]),
  );
  const referencedIds = new Set(
    stepRows
      .map((row) => decodePayload<EditorBlock>(row, null as never)?.screenshotMediaId)
      .filter((id): id is string => Boolean(id)),
  );
  if ([...referencedIds].some((id) => !media.has(id))) {
    throw new HttpError(409, "REVISION_MEDIA_INCOMPLETE", "A published screenshot is missing.");
  }
  if ([...referencedIds].some((id) => media.get(id)?.contentType === "image/webp")) {
    throw new HttpError(415, "EXPORT_MEDIA_UNSUPPORTED", "A published screenshot uses an unsupported export format.");
  }
  const audienceValues = audienceRows.map((row) => decodePayload<GuideAudienceRecord>(row, null as never));
  const audience: GuideAudience = audienceValues.some((item) => item.kind === "workspace")
    ? { mode: "workspace", workspaceId }
    : {
        mode: "restricted",
        workspaceId,
        targets: audienceValues.map((item) => ({
          type: item.kind as "group" | "user",
          id: item.subjectId!,
          ...(item.label ? { label: item.label } : {}),
        })),
      };
  const actor = (userId: string) => ({ userId, displayName: names.get(userId) ?? "Former member" });
  const restricted = audience.mode === "restricted";
  const candidate: PublishedGuideRevision = {
    schemaVersion: 1,
    guideId: guideRow.$id,
    revisionId: revisionRow.$id,
    workspaceId,
    revisionNumber: revision.number,
    source: revision.source,
    title: revision.title,
    summary: revision.summary,
    createdAt: revision.createdAt,
    createdBy: actor(revision.authorId),
    blocks: blocks(stepRows, media, settings),
    audience,
    privacyReview:
      isCapturedGuideSource(revision.source)
        ? {
            required: true,
            status: "approved",
            originalMediaRetained: false,
            reviewedAt: revision.privacyReviewedAt!,
            reviewedBy: actor(revision.privacyReviewedBy!),
            findingsResolved: true,
          }
        : { required: false, status: "not-required", originalMediaRetained: false },
    branding: {
      workspaceId,
      workspaceName: workspace.name,
      ...(settings.logoUrl ? { logoMediaId: settings.logoUrl } : {}),
      accentColor: settings.accentColor,
      clickTargetColor: settings.clickTargetColor,
      showKnowHowBranding: !settings.removeBranding,
    },
    exportPolicy: {
      allowedFormats: ["live-link", "pdf", "html", "markdown", "pptx"],
      restrictedGuideExports: !restricted || settings.allowRestrictedExports ? "allowed" : "disabled",
      watermark: {
        mode: restricted && settings.watermarkExports ? "required" : "optional",
        includeViewer: true,
        includeWorkspace: true,
        includeDate: true,
      },
    },
    lifecycle: "published",
    submittedAt,
    submittedBy: actor(submittedBy),
    reviewedAt,
    reviewedBy: actor(reviewedBy),
    publishedAt: revision.publishedAt,
    publishedBy: actor(revision.publishedBy),
  };
  const parsed = parsePublishedGuideRevision(candidate);
  const assets: GuideExportAsset[] = [];
  let totalBytes = 0;
  for (const mediaId of referencedIds) {
    const metadata = media.get(mediaId)!;
    if (metadata.contentType === "image/webp") {
      throw new HttpError(415, "EXPORT_MEDIA_UNSUPPORTED", "A published screenshot uses an unsupported export format.");
    }
    const object = await objects.get(metadata.storageFileId);
    if (!object || object.contentType !== metadata.contentType || (await sha256Bytes(object.bytes)) !== metadata.sha256) {
      throw new HttpError(500, "MEDIA_INTEGRITY_FAILURE", "Private media failed its integrity check.", { expose: false });
    }
    totalBytes += object.bytes.byteLength;
    if (totalBytes > MAX_EXPORT_ASSET_BYTES) throw new HttpError(413, "EXPORT_ASSETS_TOO_LARGE", "This guide contains too much media to export safely.");
    assets.push({ mediaId: metadata.storageFileId, mimeType: metadata.contentType, bytes: object.bytes });
  }
  if (settings.logoUrl) {
    const logoRow = await store.get(TABLES.privateMedia, settings.logoUrl);
    const logoMetadata = logoRow ? decodePayload<{ storageFileId?: string; contentType?: string; sha256?: string }>(logoRow, {}) : {};
    const logo = logoMetadata.storageFileId ? await objects.get(logoMetadata.storageFileId) : null;
    if (
      logo && (logoMetadata.contentType === "image/png" || logoMetadata.contentType === "image/jpeg") &&
      (!logoMetadata.sha256 || (await sha256Bytes(logo.bytes)) === logoMetadata.sha256)
    ) {
      totalBytes += logo.bytes.byteLength;
      if (totalBytes > MAX_EXPORT_ASSET_BYTES) throw new HttpError(413, "EXPORT_ASSETS_TOO_LARGE", "This guide contains too much media to export safely.");
      assets.push({ mediaId: settings.logoUrl, mimeType: logoMetadata.contentType, bytes: logo.bytes });
    }
  }
  return { revision: parsed, assets, restricted };
}
