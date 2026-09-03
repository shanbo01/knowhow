import "server-only";

import type {
  Audience,
  Guide,
  GuideRevisionView,
  PublicGuideBundle,
  WorkspaceSettings,
} from "../knowhow-types";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  decodePayload,
  type GuideAudienceRecord,
  type GuideRecord,
  type GuideStepRecord,
  type RevisionRecord,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
} from "./domain-records";
import { HttpError } from "./http-security";
import { TABLES } from "./appwrite-resources";
import type { RecordData, RecordStore, StoredRecord } from "./record-store";

const SHARE_TOKEN = /^share_[A-Za-z0-9]{20,30}$/;

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

type PublicGuideRows = {
  audienceRow: StoredRecord<RecordData>;
  revisionRow: StoredRecord<RecordData>;
  revision: RevisionRecord;
  guideRow: StoredRecord<RecordData>;
  guide: GuideRecord;
};

export function assertShareToken(token: string) {
  if (!SHARE_TOKEN.test(token)) {
    throw new HttpError(404, "PUBLIC_GUIDE_NOT_FOUND", "Shared guide not found.");
  }
  return token;
}

export async function requirePublicGuideRows(
  store: RecordStore,
  suppliedToken: string,
): Promise<PublicGuideRows> {
  const token = assertShareToken(suppliedToken);
  const linkRows = await store.list(TABLES.guideAudiences, {
    filters: [
      { field: "kind", value: "link" },
      { field: "user_id", value: token },
      { field: "status", value: "active" },
    ],
    limit: 10,
  });

  for (const audienceRow of linkRows) {
    const audience = decodePayload<GuideAudienceRecord>(audienceRow, null as never);
    if (audience?.kind !== "link" || audience.subjectId !== token) continue;
    const revisionId = stringValue(audienceRow.subject_id);
    const revisionRow = revisionId
      ? await store.get(TABLES.guideRevisions, revisionId)
      : null;
    if (!revisionRow || revisionRow.status !== "published") continue;
    const revision = decodePayload<RevisionRecord>(revisionRow, null as never);
    if (!revision || revision.status !== "published") continue;
    const guideRow = await store.get(TABLES.guides, revision.guideId);
    if (!guideRow || guideRow.status !== "published") continue;
    const guide = decodePayload<GuideRecord>(guideRow, null as never);
    if (
      !guide ||
      guide.deletedAt ||
      guide.archivedAt ||
      guide.publishedRevisionId !== revisionId ||
      guideRow.workspace_id !== audienceRow.workspace_id
    ) {
      continue;
    }
    return { audienceRow, revisionRow, revision, guideRow, guide };
  }

  throw new HttpError(404, "PUBLIC_GUIDE_NOT_FOUND", "Shared guide not found.");
}

export async function loadPublicGuide(
  store: RecordStore,
  suppliedToken: string,
): Promise<PublicGuideBundle> {
  const token = assertShareToken(suppliedToken);
  const rows = await requirePublicGuideRows(store, token);
  const workspaceId = stringValue(rows.guideRow.workspace_id);
  const [workspaceRow, stepRows, audienceRows, settingRows, authorRows] =
    await Promise.all([
      store.get(TABLES.workspaces, workspaceId),
      store.list(TABLES.guideSteps, {
        filters: [{ field: "subject_id", value: rows.revisionRow.$id }],
      }),
      store.list(TABLES.guideAudiences, {
        filters: [{ field: "subject_id", value: rows.revisionRow.$id }],
      }),
      store.list(TABLES.workspaceSettings, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        limit: 1,
      }),
      store.list(TABLES.workspaceMembers, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: rows.revision.authorId },
        ],
        limit: 1,
      }),
    ]);
  if (!workspaceRow || workspaceRow.status !== "active") {
    throw new HttpError(404, "PUBLIC_GUIDE_NOT_FOUND", "Shared guide not found.");
  }
  const workspace = decodePayload<WorkspaceRecord>(workspaceRow, null as never);
  if (!workspace) {
    throw new HttpError(404, "PUBLIC_GUIDE_NOT_FOUND", "Shared guide not found.");
  }
  const author = authorRows[0]
    ? decodePayload<WorkspaceMemberRecord>(authorRows[0], null as never)
    : null;
  const audiences = audienceRows
    .map((row) => decodePayload<GuideAudienceRecord>(row, null as never))
    .filter((item): item is Audience => Boolean(item));
  const revision: GuideRevisionView = {
    id: rows.revisionRow.$id,
    number: rows.revision.number,
    status: "published",
    title: rows.revision.title,
    summary: rows.revision.summary,
    category: rows.revision.category,
    tags: rows.revision.tags,
    systemReferences: rows.revision.systemReferences,
    steps: stepRows
      .sort((left, right) => Number(left.sequence) - Number(right.sequence))
      .map((row) => decodePayload<GuideStepRecord>(row, null as never))
      .filter(Boolean),
    audiences,
    authorId: rows.revision.authorId,
    authorName: author?.name || "KnowHow author",
    createdAt: rows.revision.createdAt,
    updatedAt: rows.revision.updatedAt,
    reviewedBy: rows.revision.reviewedBy,
    reviewedAt: rows.revision.reviewedAt,
    publishedBy: rows.revision.publishedBy,
    publishedAt: rows.revision.publishedAt,
    privacyReviewedAt: rows.revision.privacyReviewedAt,
    source: rows.revision.source,
  };
  const guide: Guide = {
    id: rows.guideRow.$id,
    workspaceId,
    faviconMediaId: rows.guide.faviconMediaId,
    title: rows.guide.title,
    status: "published",
    restricted: false,
    canEdit: false,
    canReview: false,
    canPublish: false,
    canShare: false,
    canArchive: false,
    canUnpublish: false,
    canUnsubmit: false,
    canDuplicate: false,
    canRestore: false,
    canDelete: false,
    createdAt: rows.guide.createdAt,
    updatedAt: rows.guide.updatedAt,
    screenshotsLockedAt: rows.guide.screenshotsLockedAt ?? undefined,
    publishedRevision: revision,
    workingRevision: null,
  };
  const settings = settingRows[0]
    ? {
        ...DEFAULT_WORKSPACE_SETTINGS,
        ...decodePayload<Partial<WorkspaceSettings>>(settingRows[0], {}),
      }
    : DEFAULT_WORKSPACE_SETTINGS;

  return {
    token,
    workspace: {
      id: workspaceId,
      name: workspace.name,
      slug: workspace.slug,
      settings,
    },
    guide,
    revision,
  };
}
