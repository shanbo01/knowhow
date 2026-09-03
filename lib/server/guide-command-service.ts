import type {
  Audience,
  EditorBlock,
  WorkspaceSettings,
} from "../knowhow-types";
import {
  isCapturedGuideSource,
  parseGuideRevision,
  type GuideActor,
  type GuideAudience,
  type GuideBlock,
  type GuideRevision,
  type WorkspaceBranding,
} from "../guide-contracts";
import type { WorkspaceAccess } from "./access-service";
import { appendAudit } from "./audit-service";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  decodePayload,
  rowData,
  type GuideAudienceRecord,
  type GuideRecord,
  type PrivateMediaRecord,
  type RevisionRecord,
  type WorkspaceMemberRecord,
} from "./domain-records";
import { normalizeGuideAudiences, normalizeGuideSteps } from "./guide-input";
import { HttpError } from "./http-security";
import { deterministicResourceId, resourceId } from "./ids";
import { inputBoolean, inputStringList, inputText, slugify } from "./input";
import { TABLES } from "./appwrite-resources";
import { EntitlementService } from "./entitlement-service";
import { requireAuthorized, type AuthorizationContext, type GuideAuthorizationFacts } from "./policy";
import type { PrivateObjectStore } from "./private-object-store";
import type { RecordData, RecordStore, StoredRecord } from "./record-store";
import type { AuthenticatedIdentity } from "./session-identity";

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const SHARE_TOKEN = /^share_[A-Za-z0-9]{20,30}$/;
const MAX_MEDIA_CLONES = 50;

/**
 * Names a copy so a library of them stays readable: "Report" becomes
 * "Report (copy)", and copying that again gives "Report (copy 2)" rather than
 * "Report (copy) (copy)".
 */
function duplicateTitle(title: string) {
  const base = String(title ?? "").trim() || "Untitled guide";
  const existing = base.match(/^(.*?)\s*\(copy(?:\s+(\d+))?\)$/);
  if (!existing) return `${base} (copy)`.slice(0, 200);
  const stem = existing[1].trim() || "Untitled guide";
  const next = Math.max(2, (Number(existing[2]) || 1) + 1);
  return `${stem} (copy ${next})`.slice(0, 200);
}
const MAX_TRANSACTION_MUTATIONS = 900;

type GuideCommandOptions = {
  requestId: string;
};

type RevisionBundle = {
  row: StoredRecord<RecordData>;
  value: RevisionRecord;
};

function nowIso() {
  return new Date().toISOString();
}

function resourceInput(value: unknown, label: string) {
  const id = inputText(value, label, { min: 1, max: 36 });
  if (!RESOURCE_ID.test(id)) throw new HttpError(400, "RESOURCE_ID_INVALID", `${label} is invalid.`);
  return id;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function canonicalAudience(audiences: Audience[], workspaceId: string): GuideAudience {
  if (!audiences.length) {
    return { mode: "private", workspaceId };
  }
  if (audiences.some((item) => item.kind === "workspace")) {
    return { mode: "workspace", workspaceId };
  }
  const publicLink = audiences.find((item) => item.kind === "link");
  if (publicLink?.subjectId) {
    return { mode: "public-link", workspaceId, token: publicLink.subjectId };
  }
  return {
    mode: "restricted",
    workspaceId,
    targets: audiences.map((item) => ({
      type: item.kind as "group" | "user",
      id: item.subjectId!,
      ...(item.label ? { label: item.label } : {}),
    })),
  };
}

function canonicalBlocks(blocks: EditorBlock[]): GuideBlock[] {
  return blocks.map((block) => {
    if (block.kind === "heading") {
      return { id: block.id, type: "heading", level: 2, text: block.title };
    }
    if (block.kind === "note" || block.kind === "warning") {
      return {
        id: block.id,
        type: "callout",
        tone: block.kind === "warning" ? "warning" : "note",
        title: block.title,
        text: block.description || block.title,
      };
    }
    return {
      id: block.id,
      type: "action",
      title: block.title,
      instructions: block.description || block.title,
    };
  });
}

function validateCanonicalRevision(input: {
  guideId: string;
  revisionId: string;
  workspaceId: string;
  revisionNumber: number;
  lifecycle: "draft" | "review";
  source: RevisionRecord["source"];
  title: string;
  summary: string;
  createdAt: string;
  identity: AuthenticatedIdentity;
  blocks: EditorBlock[];
  audiences: Audience[];
  privacyReviewed: boolean;
  branding: WorkspaceBranding;
}) {
  const actor: GuideActor = { userId: input.identity.userId, displayName: input.identity.name };
  const base = {
    schemaVersion: 1 as const,
    guideId: input.guideId,
    revisionId: input.revisionId,
    workspaceId: input.workspaceId,
    revisionNumber: input.revisionNumber,
    source: input.source,
    title: input.title,
    summary: input.summary,
    createdAt: input.createdAt,
    createdBy: actor,
    blocks: canonicalBlocks(input.blocks),
    audience: canonicalAudience(input.audiences, input.workspaceId),
    privacyReview:
      isCapturedGuideSource(input.source)
        ? {
            required: true as const,
            status: input.privacyReviewed ? ("approved" as const) : ("pending" as const),
            originalMediaRetained: false as const,
            ...(input.privacyReviewed
              ? {
                  reviewedAt: input.createdAt,
                  reviewedBy: actor,
                  findingsResolved: true,
                }
              : {}),
          }
        : {
            required: false as const,
            status: "not-required" as const,
            originalMediaRetained: false as const,
          },
    branding: input.branding,
    exportPolicy: {
      allowedFormats: ["live-link", "pdf", "html", "markdown", "pptx"] as const,
      restrictedGuideExports: "allowed" as const,
      watermark: {
        mode: "optional" as const,
        includeViewer: true,
        includeWorkspace: true,
        includeDate: true,
      },
    },
  };
  const candidate: GuideRevision =
    input.lifecycle === "review"
      ? { ...base, lifecycle: "review", submittedAt: input.createdAt, submittedBy: actor }
      : { ...base, lifecycle: "draft" };
  parseGuideRevision(candidate);
}

function mediaValue(row: StoredRecord<RecordData>) {
  return decodePayload<PrivateMediaRecord>(row, null as never);
}

export class GuideCommandService {
  constructor(
    private readonly store: RecordStore,
    private readonly objects?: PrivateObjectStore,
  ) {}

  async execute(
    identity: AuthenticatedIdentity,
    action: string,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
    context: AuthorizationContext,
    options: GuideCommandOptions,
  ): Promise<unknown> {
    if (action === "saveGuide") {
      return this.save(identity, payload, workspaceAccess, context, options);
    }
    if (action === "reviewGuide") {
      return this.review(identity, payload, workspaceAccess, context);
    }
    if (action === "unsubmitGuide") {
      return this.unsubmit(identity, payload, workspaceAccess, context);
    }
    if (action === "publishGuide") {
      return this.publish(identity, payload, workspaceAccess, context, options);
    }
    if (action === "shareGuide") {
      return this.share(identity, payload, workspaceAccess, context, options);
    }
    if (action === "unshareGuide") {
      return this.unshare(identity, payload, workspaceAccess);
    }
    if (action === "unpublishGuide") {
      return this.unpublish(identity, payload, workspaceAccess, context);
    }
    if (action === "duplicateGuide") {
      return this.duplicate(identity, payload, workspaceAccess, context, options);
    }
    if (action === "archiveGuide") {
      return this.archive(identity, payload, workspaceAccess, context);
    }
    if (action === "deleteGuide") {
      return this.remove(identity, payload, workspaceAccess);
    }
    if (action === "restoreRevision") {
      return this.restore(identity, payload, workspaceAccess, context, options);
    }
    throw new HttpError(400, "GUIDE_ACTION_UNKNOWN", "The guide action is not supported.");
  }

  private async loadRevision(id: string, guideId: string, workspaceId: string): Promise<RevisionBundle> {
    const row = await this.store.get(TABLES.guideRevisions, id);
    if (!row || row.workspace_id !== workspaceId || row.subject_id !== guideId) {
      throw new HttpError(404, "REVISION_NOT_FOUND", "Revision not found.");
    }
    const value = decodePayload<RevisionRecord>(row, null as never);
    if (!value?.guideId || value.guideId !== guideId) {
      throw new HttpError(500, "REVISION_CORRUPT", "Revision metadata is unavailable.", { expose: false });
    }
    return { row, value };
  }

  private async guideFacts(
    identity: AuthenticatedIdentity,
    workspaceAccess: WorkspaceAccess,
    guide: GuideRecord,
    revision: RevisionBundle,
  ): Promise<GuideAuthorizationFacts> {
    const [audienceRows, assignmentRows, groupRows, settingRows] = await Promise.all([
      this.store.list(TABLES.guideAudiences, {
        filters: [{ field: "subject_id", value: revision.row.$id }],
      }),
      this.store.list(TABLES.reviewAssignments, {
        filters: [{ field: "subject_id", value: revision.row.$id }],
      }),
      this.store.list(TABLES.groupMemberships, {
        filters: [
          { field: "workspace_id", value: workspaceAccess.workspaceRow.$id },
          { field: "user_id", value: identity.userId },
        ],
      }),
      this.store.list(TABLES.workspaceSettings, {
        filters: [{ field: "workspace_id", value: workspaceAccess.workspaceRow.$id }],
        limit: 1,
      }),
    ]);
    const groupIds = new Set(groupRows.map((row) => stringValue(row.subject_id)).filter(Boolean));
    const isAudienceMember = audienceRows.some((row) => {
      const audience = decodePayload<GuideAudienceRecord>(row, null as never);
      if (!audience) return false;
      if (audience.kind === "workspace") return true;
      if (audience.kind === "user") return audience.subjectId === identity.userId;
      return audience.kind === "group" && Boolean(audience.subjectId && groupIds.has(audience.subjectId));
    });
    const settings = settingRows[0]
      ? { ...DEFAULT_WORKSPACE_SETTINGS, ...decodePayload<Partial<WorkspaceSettings>>(settingRows[0], {}) }
      : DEFAULT_WORKSPACE_SETTINGS;
    return {
      revisionStatus: revision.value.status,
      sourceType: isCapturedGuideSource(revision.value.source) ? "capture" : "manual",
      isAuthor: guide.authorUserId === identity.userId,
      isAssignedReviewer: assignmentRows.some((row) => row.user_id === identity.userId),
      isAudienceMember,
      exportAllowed:
        audienceRows.some((row) => row.kind === "workspace") || settings.allowRestrictedExports,
      privacyReviewed:
        revision.value.source === "manual" || Boolean(revision.value.privacyReviewedAt),
      reviewApproved:
        assignmentRows.some((row) => row.status === "approved") &&
        !assignmentRows.some((row) => row.status === "changes_requested"),
      requireReviewBeforePublish: settings.requireReviewBeforePublish,
    };
  }

  private async validateAudiences(audiences: Audience[], workspaceId: string) {
    for (const audience of audiences) {
      if (audience.kind === "workspace") {
        if (audience.subjectId !== workspaceId) {
          throw new HttpError(400, "AUDIENCE_INVALID", "The workspace audience is invalid.");
        }
        continue;
      }
      const subjectId = resourceInput(audience.subjectId, "Audience target");
      if (audience.kind === "link") {
        if (!SHARE_TOKEN.test(subjectId)) {
          throw new HttpError(400, "AUDIENCE_INVALID", "The public link audience is invalid.");
        }
        continue;
      } else if (audience.kind === "group") {
        const group = await this.store.get(TABLES.workspaceGroups, subjectId);
        if (!group || group.workspace_id !== workspaceId || group.status !== "active") {
          throw new HttpError(400, "AUDIENCE_INVALID", "An audience group is outside this workspace.");
        }
      } else {
        const members = await this.store.list(TABLES.workspaceMembers, {
          filters: [
            { field: "workspace_id", value: workspaceId },
            { field: "user_id", value: subjectId },
            { field: "status", value: "active" },
          ],
          limit: 1,
        });
        if (!members.length) {
          throw new HttpError(400, "AUDIENCE_INVALID", "An audience member is outside this workspace.");
        }
      }
    }
  }

  private async settings(workspaceId: string) {
    const rows = await this.store.list(TABLES.workspaceSettings, {
      filters: [{ field: "workspace_id", value: workspaceId }],
      limit: 1,
    });
    return rows[0]
      ? { ...DEFAULT_WORKSPACE_SETTINGS, ...decodePayload<Partial<WorkspaceSettings>>(rows[0], {}) }
      : DEFAULT_WORKSPACE_SETTINGS;
  }

  private async replaceAudiences(
    identity: AuthenticatedIdentity,
    workspaceAccess: WorkspaceAccess,
    revisionId: string,
    audiences: Audience[],
  ) {
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const oldAudiences = await this.store.list(TABLES.guideAudiences, {
      filters: [{ field: "subject_id", value: revisionId }],
    });
    for (const row of oldAudiences) {
      await this.store.delete(TABLES.guideAudiences, row.$id);
    }
    for (const audience of audiences) {
      await this.store.create(
        TABLES.guideAudiences,
        resourceId("audience"),
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            subject_id: revisionId,
            user_id: audience.subjectId ?? workspaceId,
            kind: audience.kind,
            status: "active",
            created_by: identity.userId,
          },
          audience,
        ),
      );
    }
  }

  private async assertPublishableDraft(revisionId: string) {
    const steps = await this.store.list(TABLES.guideSteps, {
      filters: [{ field: "subject_id", value: revisionId }],
    });
    const hasUnappliedRedaction = steps.some((row) => {
      const step = decodePayload<EditorBlock>(row, null as never);
      return (step?.redactions ?? []).some((redaction) => !redaction.applied);
    });
    if (hasUnappliedRedaction) {
      throw new HttpError(
        409,
        "REDACTIONS_NOT_FLATTENED",
        "Flatten every redaction before sharing.",
      );
    }
  }

  /**
   * Ids of every element the `privacyToolsEnabled` entitlement covers: redaction
   * regions and every annotation except the free click marker.
   */
  private privacyElementIds(steps: EditorBlock[]) {
    const ids = new Set<string>();
    for (const step of steps) {
      for (const redaction of step.redactions ?? []) ids.add(redaction.id);
      for (const annotation of step.annotations ?? []) {
        if (annotation.kind !== "click") ids.add(annotation.id);
      }
    }
    return ids;
  }

  /**
   * Privacy tools are a paid feature, so a workspace without the entitlement
   * cannot add new redactions or non-click annotations. Elements the guide
   * already carried stay saveable — a workspace that drops to Free keeps
   * working on guides it built while entitled instead of being locked out.
   */
  private async assertPrivacyToolsAllowed(
    workspaceId: string,
    steps: EditorBlock[],
    baselineRevisionId: string | null,
  ) {
    const incoming = this.privacyElementIds(steps);
    if (!incoming.size) return;
    const entitlements = new EntitlementService(this.store, workspaceId);
    if (await entitlements.value<boolean>("privacyToolsEnabled", false)) return;

    const rows = baselineRevisionId
      ? await this.store.list(TABLES.guideSteps, {
          filters: [{ field: "subject_id", value: baselineRevisionId }],
        })
      : [];
    const existing = this.privacyElementIds(
      rows.map((row) => decodePayload<EditorBlock>(row, null as never)).filter(Boolean),
    );
    if ([...incoming].every((id) => existing.has(id))) return;
    await entitlements.requireFeature("privacyToolsEnabled");
  }

  private async save(
    identity: AuthenticatedIdentity,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
    context: AuthorizationContext,
    options: GuideCommandOptions,
  ) {
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const guideId = payload.guideId === undefined ? resourceId("guide") : resourceInput(payload.guideId, "Guide");
    const existingRow = await this.store.get(TABLES.guides, guideId);
    if (existingRow && existingRow.workspace_id !== workspaceId) {
      throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    }
    const existing = existingRow ? decodePayload<GuideRecord>(existingRow, null as never) : null;
    if (existing?.deletedAt) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    if (existing?.archivedAt) {
      throw new HttpError(409, "GUIDE_ARCHIVED", "Restore an archived revision before editing it.");
    }

    const title = inputText(payload.title, "Guide title", { min: 3, max: 500 });
    const summary = inputText(payload.summary, "Guide summary", { min: 1, max: 5_000 });
    const category = inputText(payload.category ?? "", "Category", { max: 200 });
    const tags = inputStringList(payload.tags ?? [], "Tags", 50, 200);
    const systemReferences = inputStringList(payload.systemReferences ?? [], "Systems", 50, 200);
    let steps = normalizeGuideSteps(payload.steps);
    const audiences = normalizeGuideAudiences(payload.audiences, workspaceId).map(
      (audience) =>
        audience.kind === "link" && !audience.subjectId
          ? { ...audience, subjectId: resourceId("share") }
          : audience,
    );
    await this.validateAudiences(audiences, workspaceId);
    const source: RevisionRecord["source"] =
      payload.source === "browser-capture" || payload.source === "desktop-capture"
        ? payload.source
        : "manual";
    const privacyReviewed = inputBoolean(payload.privacyReviewed ?? false, "Privacy review");
    const transition = payload.transition === "review" ? "review" : "draft";
    if (isCapturedGuideSource(source) && transition === "review" && !privacyReviewed) {
      throw new HttpError(409, "PRIVACY_REVIEW_REQUIRED", "Complete the capture privacy review before requesting review.");
    }

    let working: RevisionBundle | null = null;
    let revisionId: string;
    let revisionNumber = 1;
    let createdAt = nowIso();
    let createRevision = true;
    if (!existing) {
      requireAuthorized("guide.create", context);
      const entitlements = new EntitlementService(this.store, workspaceId);
      await entitlements.assertCreatorCapacity(identity.userId);
      await entitlements.assertGuideCapacity();
      revisionId = resourceId("revision");
    } else if (existing.workingRevisionId) {
      working = await this.loadRevision(existing.workingRevisionId, guideId, workspaceId);
      const suppliedRevision = payload.revisionId === undefined
        ? working.row.$id
        : resourceInput(payload.revisionId, "Revision");
      if (suppliedRevision !== working.row.$id) {
        throw new HttpError(409, "REVISION_CONFLICT", "The draft changed. Refresh before saving again.");
      }
      const facts = await this.guideFacts(identity, workspaceAccess, existing, working);
      requireAuthorized("guide.update", { ...context, guide: facts });
      if (working.value.status !== "draft") {
        throw new HttpError(409, "DRAFT_NOT_EDITABLE", "Only a draft revision can be edited.");
      }
      revisionId = working.row.$id;
      revisionNumber = working.value.number;
      createdAt = working.value.createdAt;
      createRevision = false;
    } else {
      const mayCreateDraft =
        existing.authorUserId === identity.userId &&
        (workspaceAccess.roles.includes("creator") || workspaceAccess.roles.includes("administrator"));
      if (!mayCreateDraft) {
        throw new HttpError(403, "DRAFT_EDITOR_REQUIRED", "You cannot create a draft for this guide.");
      }
      const revisions = await this.store.list(TABLES.guideRevisions, {
        filters: [{ field: "subject_id", value: guideId }],
      });
      revisionNumber = Math.max(
        0,
        ...revisions.map((row) => Number(row.version) || decodePayload<RevisionRecord>(row, null as never)?.number || 0),
      ) + 1;
      revisionId = resourceId("revision");
    }

    const firstReviewSubmission = !existing?.screenshotsLockedAt && transition === "review";
    const hasUnappliedRedaction = steps.some((step) =>
      (step.redactions ?? []).some((redaction) => !redaction.applied),
    );
    if (existing?.screenshotsLockedAt && hasUnappliedRedaction) {
      throw new HttpError(409, "SCREENSHOTS_LOCKED", "Screenshots were locked at first review and cannot contain reversible redactions.");
    }
    if (firstReviewSubmission && hasUnappliedRedaction) {
      throw new HttpError(409, "REDACTIONS_NOT_FLATTENED", "Flatten every redaction before requesting review.");
    }
    await this.assertPrivacyToolsAllowed(
      workspaceId,
      steps,
      createRevision
        ? existing?.workingRevisionId ?? existing?.publishedRevisionId ?? null
        : revisionId,
    );

    const referencedMediaIds = [...new Set(
      steps.map((step) => step.screenshotMediaId).filter((id): id is string => Boolean(id)),
    )];
    const sourceRevisionId = existing
      ? createRevision
        ? existing.publishedRevisionId
        : revisionId
      : null;
    const inheritedMedia: Array<{ id: string; source: PrivateMediaRecord }> = [];
    const createdFiles: string[] = [];
    if (referencedMediaIds.length) {
      if (!sourceRevisionId) {
        throw new HttpError(409, "SCREENSHOT_REFERENCE_INVALID", "Save the guide before attaching a private screenshot.");
      }
      const mediaRows = await this.store.list(TABLES.privateMedia, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "subject_id", value: sourceRevisionId },
        ],
      });
      const byId = new Map(mediaRows.map((row) => [row.$id, row]));
      if (referencedMediaIds.some((id) => {
        const row = byId.get(id);
        const media = row ? mediaValue(row) : null;
        return !row || row.status !== "ready" || !media || media.deletedAt !== null;
      })) {
        throw new HttpError(409, "SCREENSHOT_REFERENCE_INVALID", "Each screenshot must belong to the revision being saved.");
      }
      if (createRevision) {
        if (referencedMediaIds.length > MAX_MEDIA_CLONES) {
          throw new HttpError(413, "GUIDE_MEDIA_LIMIT", `A restored draft can contain at most ${MAX_MEDIA_CLONES} screenshots.`);
        }
        if (!this.objects) {
          throw new HttpError(503, "PRIVATE_STORAGE_UNAVAILABLE", "Private media storage is unavailable.", { expose: false });
        }
        const idMap = new Map<string, string>();
        try {
          for (const sourceId of referencedMediaIds) {
            const sourceMedia = mediaValue(byId.get(sourceId)!);
            const nextId = resourceId("media");
            await this.objects.clone(sourceMedia.storageFileId, nextId, sourceMedia.filename);
            createdFiles.push(nextId);
            idMap.set(sourceId, nextId);
            inheritedMedia.push({ id: nextId, source: sourceMedia });
          }
        } catch (error) {
          await Promise.all(createdFiles.map((id) => this.objects!.delete(id).catch(() => undefined)));
          throw error;
        }
        steps = steps.map((step) =>
          step.screenshotMediaId
            ? { ...step, screenshotMediaId: idMap.get(step.screenshotMediaId)! }
            : step,
        );
      }
    }

    const oldSteps = createRevision
      ? []
      : await this.store.list(TABLES.guideSteps, { filters: [{ field: "subject_id", value: revisionId }] });
    const oldAudiences = createRevision
      ? []
      : await this.store.list(TABLES.guideAudiences, { filters: [{ field: "subject_id", value: revisionId }] });
    const oldReviews = createRevision
      ? []
      : await this.store.list(TABLES.reviewAssignments, { filters: [{ field: "subject_id", value: revisionId }] });
    const reviewerRows = transition === "review"
      ? await this.store.list(TABLES.workspaceMembers, {
          filters: [
            { field: "workspace_id", value: workspaceId },
            { field: "status", value: "active" },
          ],
        })
      : [];
    const reviewerIds = reviewerRows
      .filter((row) => {
        const member = decodePayload<WorkspaceMemberRecord>(row, null as never);
        return member?.roles.includes("reviewer");
      })
      .map((row) => stringValue(row.user_id))
      .filter(Boolean);
    if (transition === "review" && !reviewerIds.length) {
      await Promise.all(createdFiles.map((id) => this.objects!.delete(id).catch(() => undefined)));
      throw new HttpError(409, "REVIEWER_REQUIRED", "Assign an active reviewer first.");
    }
    const mutationEstimate =
      oldSteps.length + oldAudiences.length + oldReviews.length +
      steps.length + audiences.length + reviewerIds.length + inheritedMedia.length + 8;
    if (mutationEstimate > MAX_TRANSACTION_MUTATIONS) {
      await Promise.all(createdFiles.map((id) => this.objects!.delete(id).catch(() => undefined)));
      throw new HttpError(413, "GUIDE_TRANSACTION_LIMIT", "The guide is too large to save safely in one transaction.");
    }

    const settings = await this.settings(workspaceId);
    const branding: WorkspaceBranding = {
      workspaceId,
      workspaceName: workspaceAccess.workspace.name,
      ...(settings.logoUrl ? { logoMediaId: settings.logoUrl } : {}),
      accentColor: settings.accentColor,
      clickTargetColor: settings.clickTargetColor,
      showKnowHowBranding: !settings.removeBranding,
    };
    validateCanonicalRevision({
      guideId,
      revisionId,
      workspaceId,
      revisionNumber,
      lifecycle: transition,
      source,
      title,
      summary,
      createdAt,
      identity,
      blocks: steps,
      audiences,
      privacyReviewed,
      branding,
    });

    const updatedAt = nowIso();
    const guide: GuideRecord = existing
      ? {
          ...existing,
          title,
          workingRevisionId: revisionId,
          screenshotsLockedAt:
            existing.screenshotsLockedAt ?? (firstReviewSubmission ? updatedAt : null),
          archivedAt: null,
          updatedAt,
        }
      : {
          title,
          slug: `${slugify(title)}-${guideId.slice(-5)}`,
          authorUserId: identity.userId,
          publishedRevisionId: null,
          workingRevisionId: revisionId,
          screenshotsLockedAt: firstReviewSubmission ? updatedAt : null,
          archivedAt: null,
          createdAt,
          updatedAt,
        };
    const revision: RevisionRecord = {
      guideId,
      number: revisionNumber,
      status: transition,
      title,
      summary,
      category,
      tags,
      systemReferences,
      authorId: working?.value.authorId ?? identity.userId,
      createdAt,
      updatedAt,
      ...(transition === "review"
        ? { submittedAt: updatedAt, submittedBy: identity.userId }
        : working?.value.submittedAt
          ? { submittedAt: working.value.submittedAt, submittedBy: working.value.submittedBy }
          : {}),
      ...(privacyReviewed && isCapturedGuideSource(source)
        ? { privacyReviewedAt: updatedAt, privacyReviewedBy: identity.userId }
        : {}),
      source,
    };

    try {
      if (existingRow) {
        await this.store.update(
          TABLES.guides,
          guideId,
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              subject_id: guideId,
              slug: guide.slug,
              status: transition,
              updated_by: identity.userId,
            },
            guide,
          ),
        );
      } else {
        await this.store.create(
          TABLES.guides,
          guideId,
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              subject_id: guideId,
              slug: guide.slug,
              status: transition,
              created_by: identity.userId,
            },
            guide,
          ),
        );
      }
      if (createRevision) {
        await this.store.create(
          TABLES.guideRevisions,
          revisionId,
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              subject_id: guideId,
              status: transition,
              version: revisionNumber,
              created_by: identity.userId,
            },
            revision,
          ),
        );
      } else {
        await this.store.update(
          TABLES.guideRevisions,
          revisionId,
          rowData({ status: transition, version: revisionNumber, updated_by: identity.userId }, revision),
        );
        for (const row of [...oldSteps, ...oldAudiences, ...oldReviews]) {
          const table = oldSteps.includes(row)
            ? TABLES.guideSteps
            : oldAudiences.includes(row)
              ? TABLES.guideAudiences
              : TABLES.reviewAssignments;
          await this.store.delete(table, row.$id);
        }
      }
      for (const [sequence, step] of steps.entries()) {
        await this.store.create(
          TABLES.guideSteps,
          resourceId("step"),
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              subject_id: revisionId,
              status: "active",
              kind: step.kind,
              sequence,
              created_by: identity.userId,
            },
            step,
          ),
        );
      }
      for (const audience of audiences) {
        await this.store.create(
          TABLES.guideAudiences,
          resourceId("audience"),
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              subject_id: revisionId,
              user_id: audience.subjectId ?? workspaceId,
              kind: audience.kind,
              status: "active",
              created_by: identity.userId,
            },
            audience,
          ),
        );
      }
      for (const reviewerId of reviewerIds) {
        await this.store.create(
          TABLES.reviewAssignments,
          resourceId("review"),
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              subject_id: revisionId,
              user_id: reviewerId,
              status: "pending",
              created_by: identity.userId,
            },
            { assignedAt: updatedAt, assignedBy: identity.userId },
          ),
        );
      }
      for (const inherited of inheritedMedia) {
        const media: PrivateMediaRecord = {
          ...inherited.source,
          guideId,
          revisionId,
          stepId:
            steps.find((step) => step.screenshotMediaId === inherited.id)?.id ?? null,
          storageFileId: inherited.id,
          uploadedBy: identity.userId,
          createdAt: updatedAt,
          deletedAt: null,
        };
        await this.store.create(
          TABLES.privateMedia,
          inherited.id,
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              subject_id: revisionId,
              user_id: identity.userId,
              status: "ready",
              kind: media.contentType,
              created_by: identity.userId,
            },
            media,
          ),
        );
      }
      await appendAudit(this.store, identity, workspaceId, {
        action: transition === "review" ? "guide.submitted" : existing ? "guide.updated" : "guide.created",
        targetType: "guide",
        targetId: guideId,
        targetLabel: title,
        summary:
          transition === "review" ? `${title} submitted for review` : `${title} private draft saved`,
        metadata: {
          revisionId,
          revisionNumber,
          source,
          clonedMediaCount: inheritedMedia.length,
          requestId: options.requestId,
        },
      });
    } catch (error) {
      if (this.objects) {
        await Promise.all(createdFiles.map((id) => this.objects!.delete(id).catch(() => undefined)));
      }
      throw error;
    }
    return { guideId, revisionId };
  }

  private async review(
    identity: AuthenticatedIdentity,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
    context: AuthorizationContext,
  ) {
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const guideId = resourceInput(payload.guideId, "Guide");
    const guideRow = await this.store.get(TABLES.guides, guideId);
    if (!guideRow || guideRow.workspace_id !== workspaceId) {
      throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    }
    const guide = decodePayload<GuideRecord>(guideRow, null as never);
    if (!guide?.workingRevisionId || guide.deletedAt || guide.archivedAt) {
      throw new HttpError(409, "REVIEW_NOT_AVAILABLE", "This guide has no review revision.");
    }
    const revision = await this.loadRevision(guide.workingRevisionId, guideId, workspaceId);
    const facts = await this.guideFacts(identity, workspaceAccess, guide, revision);
    requireAuthorized("guide.review", { ...context, guide: facts });
    if (payload.decision !== "approved" && payload.decision !== "changes_requested") {
      throw new HttpError(400, "REVIEW_DECISION_INVALID", "Select an explicit review decision.");
    }
    const decision = payload.decision;
    const assignments = await this.store.list(TABLES.reviewAssignments, {
      filters: [
        { field: "subject_id", value: revision.row.$id },
        { field: "user_id", value: identity.userId },
      ],
      limit: 1,
    });
    // requireAuthorized("guide.review") above already established that this
    // actor is an assigned reviewer, so there is no unassigned case left to
    // let an administrator through. A revision whose reviewers have all been
    // suspended is unstuck by withdrawing it, not by deciding it.
    const assignment = assignments[0];
    const decidedAt = nowIso();
    const assignmentPayload = { assignedAt: assignment?.$createdAt ?? decidedAt, assignedBy: stringValue(assignment?.created_by, identity.userId), decidedAt };
    if (assignment) {
      await this.store.update(TABLES.reviewAssignments, assignment.$id, rowData({ status: decision, updated_by: identity.userId }, assignmentPayload));
    } else {
      await this.store.create(TABLES.reviewAssignments, resourceId("review"), rowData({ organization_id: workspaceAccess.workspace.organizationId, workspace_id: workspaceId, subject_id: revision.row.$id, user_id: identity.userId, status: decision, created_by: identity.userId }, assignmentPayload));
    }
    const nextRevision: RevisionRecord = {
      ...revision.value,
      status: decision === "approved" ? "review" : "draft",
      updatedAt: decidedAt,
      ...(decision === "approved" ? { reviewedBy: identity.userId, reviewedAt: decidedAt } : {}),
    };
    if (decision === "changes_requested") {
      delete nextRevision.reviewedBy;
      delete nextRevision.reviewedAt;
      delete nextRevision.submittedBy;
      delete nextRevision.submittedAt;
    }
    await this.store.update(TABLES.guideRevisions, revision.row.$id, rowData({ status: nextRevision.status, updated_by: identity.userId }, nextRevision));
    if (decision === "changes_requested") {
      await this.store.update(TABLES.guides, guideId, rowData({ status: "draft", updated_by: identity.userId }, { ...guide, updatedAt: decidedAt }));
    }
    await appendAudit(this.store, identity, workspaceId, {
      action: decision === "approved" ? "guide.review-approved" : "guide.review-changes-requested",
      targetType: "guide",
      targetId: guideId,
      targetLabel: guide.title,
      summary: `${guide.title} review ${decision === "approved" ? "approved" : "returned for changes"}`,
      metadata: { revisionId: revision.row.$id },
    });
    return { reviewed: true };
  }

  /**
   * Returns a submitted revision to draft without a review decision.
   *
   * Submitting was a one-way door. A review revision cannot be edited, and
   * only an assigned reviewer can decide it, so a workspace that suspends its
   * reviewers after a submission leaves that revision frozen with nobody able
   * to move it. This is the mirror of submitting: the author changes their
   * mind, or an administrator recovers a stranded revision.
   */
  private async unsubmit(
    identity: AuthenticatedIdentity,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
    context: AuthorizationContext,
  ) {
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const guideId = resourceInput(payload.guideId, "Guide");
    const guideRow = await this.store.get(TABLES.guides, guideId);
    if (!guideRow || guideRow.workspace_id !== workspaceId) {
      throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    }
    const guide = decodePayload<GuideRecord>(guideRow, null as never);
    if (!guide?.workingRevisionId || guide.deletedAt || guide.archivedAt) {
      throw new HttpError(409, "WITHDRAW_NOT_AVAILABLE", "This guide has no revision in review.");
    }
    const revision = await this.loadRevision(guide.workingRevisionId, guideId, workspaceId);
    const facts = await this.guideFacts(identity, workspaceAccess, guide, revision);
    requireAuthorized("guide.unsubmit", { ...context, guide: facts });

    const withdrawnAt = nowIso();
    const nextRevision: RevisionRecord = {
      ...revision.value,
      status: "draft",
      updatedAt: withdrawnAt,
    };
    delete nextRevision.reviewedBy;
    delete nextRevision.reviewedAt;
    delete nextRevision.submittedBy;
    delete nextRevision.submittedAt;
    await this.store.update(
      TABLES.guideRevisions,
      revision.row.$id,
      rowData({ status: "draft", updated_by: identity.userId }, nextRevision),
    );
    // The pending assignments described a review that is no longer happening.
    // Clearing them means a later submission assigns whoever holds the role
    // then, rather than resurrecting decisions from an abandoned round.
    for (const row of await this.store.list(TABLES.reviewAssignments, {
      filters: [{ field: "subject_id", value: revision.row.$id }],
    })) {
      await this.store.delete(TABLES.reviewAssignments, row.$id);
    }
    await this.store.update(
      TABLES.guides,
      guideId,
      rowData({ status: "draft", updated_by: identity.userId }, { ...guide, updatedAt: withdrawnAt }),
    );
    await appendAudit(this.store, identity, workspaceId, {
      action: "guide.review-withdrawn",
      targetType: "guide",
      targetId: guideId,
      targetLabel: guide.title,
      summary: `${guide.title} withdrawn from review`,
      metadata: { revisionId: revision.row.$id },
    });
    return { withdrawn: true };
  }

  private async publish(
    identity: AuthenticatedIdentity,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
    context: AuthorizationContext,
    options: GuideCommandOptions,
  ) {
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const guideId = resourceInput(payload.guideId, "Guide");
    const guideRow = await this.store.get(TABLES.guides, guideId);
    if (!guideRow || guideRow.workspace_id !== workspaceId) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    const guide = decodePayload<GuideRecord>(guideRow, null as never);
    if (!guide?.workingRevisionId || guide.deletedAt || guide.archivedAt) {
      throw new HttpError(409, "PUBLISH_NOT_AVAILABLE", "This guide has no working revision to share.");
    }
    const revision = await this.loadRevision(guide.workingRevisionId, guideId, workspaceId);
    if (revision.value.status === "draft") {
      await this.assertPublishableDraft(revision.row.$id);
    }
    const facts = await this.guideFacts(identity, workspaceAccess, guide, revision);
    requireAuthorized("guide.publish", { ...context, guide: facts });
    // Check before staging the ordinary guide.published row. Appwrite's
    // transaction overlay can otherwise return a staged row to a later
    // filtered list query and make the first-publication event look present.
    const priorPublications = await this.store.list(TABLES.usageEvents, {
      filters: [
        { field: "workspace_id", value: workspaceId },
        { field: "kind", value: "activation.first_guide_published" },
      ],
      limit: 1,
    });
    const publishedAt = nowIso();
    if (guide.publishedRevisionId) {
      const previous = await this.loadRevision(guide.publishedRevisionId, guideId, workspaceId);
      await this.store.update(TABLES.guideRevisions, previous.row.$id, rowData({ status: "archived", updated_by: identity.userId }, { ...previous.value, status: "archived", updatedAt: publishedAt }));
    }
    await this.store.update(
      TABLES.guideRevisions,
      revision.row.$id,
      rowData(
        { status: "published", updated_by: identity.userId },
        {
          ...revision.value,
          status: "published",
          submittedAt: revision.value.submittedAt ?? publishedAt,
          submittedBy: revision.value.submittedBy ?? identity.userId,
          reviewedAt: revision.value.reviewedAt ?? publishedAt,
          reviewedBy: revision.value.reviewedBy ?? identity.userId,
          publishedBy: identity.userId,
          publishedAt,
          updatedAt: publishedAt,
        },
      ),
    );
    await this.store.update(
      TABLES.guides,
      guideId,
      rowData(
        { status: "published", updated_by: identity.userId },
        { ...guide, publishedRevisionId: revision.row.$id, workingRevisionId: null, screenshotsLockedAt: guide.screenshotsLockedAt ?? publishedAt, updatedAt: publishedAt },
      ),
    );
    await this.store.create(
      TABLES.usageEvents,
      resourceId("usage"),
      rowData(
        {
          organization_id: workspaceAccess.workspace.organizationId,
          workspace_id: workspaceId,
          user_id: identity.userId,
          subject_id: guideId,
          kind: "guide.published",
          status: "recorded",
          occurred_at: publishedAt,
          request_id: options.requestId,
          created_by: identity.userId,
        },
        { revisionId: revision.row.$id },
      ),
    );
    if (!priorPublications.length) {
      const activationKey = `${workspaceId}:activation.first_guide_published`;
      await this.store.create(
        TABLES.usageEvents,
        await deterministicResourceId("usage", activationKey),
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: identity.userId,
            subject_id: guideId,
            kind: "activation.first_guide_published",
            status: "recorded",
            occurred_at: publishedAt,
            request_id: await deterministicResourceId(
              "request",
              activationKey,
            ),
            created_by: identity.userId,
          },
          {
            elapsedSeconds: Math.max(
              0,
              Math.floor((Date.parse(publishedAt) - Date.parse(workspaceAccess.workspace.createdAt)) / 1_000),
            ),
            contentIncluded: false,
          },
        ),
      );
    }
    await appendAudit(this.store, identity, workspaceId, {
      action: "guide.published",
      targetType: "guide",
      targetId: guideId,
      targetLabel: guide.title,
      summary: `${guide.title} published`,
      metadata: { revisionId: revision.row.$id },
    });
    return { published: true };
  }

  private async share(
    identity: AuthenticatedIdentity,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
    context: AuthorizationContext,
    options: GuideCommandOptions,
  ) {
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const guideId = resourceInput(payload.guideId, "Guide");
    const guideRow = await this.store.get(TABLES.guides, guideId);
    if (!guideRow || guideRow.workspace_id !== workspaceId) {
      throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    }
    const guide = decodePayload<GuideRecord>(guideRow, null as never);
    if (guide.deletedAt || guide.archivedAt) {
      throw new HttpError(409, "SHARE_NOT_AVAILABLE", "This guide cannot be shared.");
    }
    const audiences = normalizeGuideAudiences(payload.audiences, workspaceId).map(
      (audience) =>
        audience.kind === "link" && !audience.subjectId
          ? { ...audience, subjectId: resourceId("share") }
          : audience,
    );
    if (!audiences.length) {
      throw new HttpError(400, "AUDIENCE_REQUIRED", "Select at least one audience.");
    }
    await this.validateAudiences(audiences, workspaceId);
    const privacyReviewed = inputBoolean(payload.privacyReviewed ?? false, "Privacy review");
    const settings = await this.settings(workspaceId);
    const requireReview = settings.requireReviewBeforePublish;
    const isPublisher = workspaceAccess.roles.includes("publisher");
    const isAuthorCreator =
      guide.authorUserId === identity.userId &&
      (workspaceAccess.roles.includes("creator") || workspaceAccess.roles.includes("administrator"));
    const mayUpdateLive = isPublisher || (isAuthorCreator && !requireReview);

    if (guide.workingRevisionId) {
      const working = await this.loadRevision(guide.workingRevisionId, guideId, workspaceId);
      if (working.value.status === "draft") {
        const facts = await this.guideFacts(identity, workspaceAccess, guide, working);
        requireAuthorized("guide.update", { ...context, guide: facts });
        await this.replaceAudiences(identity, workspaceAccess, working.row.$id, audiences);
        const updatedAt = nowIso();
        if (privacyReviewed && isCapturedGuideSource(working.value.source)) {
          await this.store.update(
            TABLES.guideRevisions,
            working.row.$id,
            rowData(
              { updated_by: identity.userId },
              {
                ...working.value,
                privacyReviewedAt: updatedAt,
                privacyReviewedBy: identity.userId,
                updatedAt,
              },
            ),
          );
        }
      } else {
        // A revision already in review is authorized as the publish it is
        // about to become. The check has to come first: publish() would refuse
        // an unauthorized caller a moment later, but the audience would
        // already have been rewritten, leaving authorization dependent on the
        // store rolling the write back.
        const facts = await this.guideFacts(identity, workspaceAccess, guide, working);
        requireAuthorized("guide.publish", { ...context, guide: facts });
        await this.replaceAudiences(identity, workspaceAccess, working.row.$id, audiences);
      }
      return this.publish(identity, payload, workspaceAccess, context, options);
    }

    if (!guide.publishedRevisionId) {
      throw new HttpError(409, "SHARE_NOT_AVAILABLE", "This guide has no revision to share.");
    }
    if (!mayUpdateLive) {
      throw new HttpError(
        403,
        "PUBLISHER_REQUIRED",
        "Publisher access is required to change the live audience.",
      );
    }
    const published = await this.loadRevision(guide.publishedRevisionId, guideId, workspaceId);
    await this.replaceAudiences(identity, workspaceAccess, published.row.$id, audiences);
    const changedAt = nowIso();
    await this.store.update(
      TABLES.guides,
      guideId,
      rowData({ updated_by: identity.userId }, { ...guide, updatedAt: changedAt }),
    );
    await appendAudit(this.store, identity, workspaceId, {
      action: "guide.audience-changed",
      targetType: "guide",
      targetId: guideId,
      targetLabel: guide.title,
      summary: `${guide.title} live audience updated`,
      metadata: { revisionId: published.row.$id },
    });
    return { audienceChanged: true };
  }

  private async unshare(
    identity: AuthenticatedIdentity,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
  ) {
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const guideId = resourceInput(payload.guideId, "Guide");
    const guideRow = await this.store.get(TABLES.guides, guideId);
    if (!guideRow || guideRow.workspace_id !== workspaceId) {
      throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    }
    const guide = decodePayload<GuideRecord>(guideRow, null as never);
    if (!guide?.publishedRevisionId || guide.deletedAt || guide.archivedAt) {
      throw new HttpError(409, "UNSHARE_NOT_AVAILABLE", "This guide is not live.");
    }
    const settings = await this.settings(workspaceId);
    const isPublisher = workspaceAccess.roles.includes("publisher");
    const isAuthorCreator =
      guide.authorUserId === identity.userId &&
      (workspaceAccess.roles.includes("creator") ||
        workspaceAccess.roles.includes("administrator"));
    if (!isPublisher && !(isAuthorCreator && !settings.requireReviewBeforePublish)) {
      throw new HttpError(
        403,
        "PUBLISHER_REQUIRED",
        "Publisher access is required to stop sharing this guide.",
      );
    }

    await this.replaceAudiences(
      identity,
      workspaceAccess,
      guide.publishedRevisionId,
      [],
    );
    const changedAt = nowIso();
    await this.store.update(
      TABLES.guides,
      guideId,
      rowData({ updated_by: identity.userId }, { ...guide, updatedAt: changedAt }),
    );
    await appendAudit(this.store, identity, workspaceId, {
      action: "guide.unshared",
      targetType: "guide",
      targetId: guideId,
      targetLabel: guide.title,
      summary: `${guide.title} is no longer shared`,
      metadata: { revisionId: guide.publishedRevisionId },
    });
    return { unshared: true };
  }

  /**
   * Returns a published guide to an editable draft.
   *
   * Archiving was the only way out of the published state, which is a
   * different intent entirely: archiving retires a guide, while this is how an
   * author corrects one that is already live. The published revision goes back
   * to draft and becomes the working revision again, and its audience is
   * cleared, so a guide taken down for editing is not still readable by the
   * people it was shared with while it is being rewritten.
   */
  private async unpublish(
    identity: AuthenticatedIdentity,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
    context: AuthorizationContext,
  ) {
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const guideId = resourceInput(payload.guideId, "Guide");
    const guideRow = await this.store.get(TABLES.guides, guideId);
    if (!guideRow || guideRow.workspace_id !== workspaceId) {
      throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    }
    const guide = decodePayload<GuideRecord>(guideRow, null as never);
    if (!guide?.publishedRevisionId || guide.deletedAt || guide.archivedAt) {
      throw new HttpError(409, "UNPUBLISH_NOT_AVAILABLE", "This guide is not live.");
    }
    if (guide.workingRevisionId) {
      throw new HttpError(
        409,
        "WORKING_DRAFT_EXISTS",
        "This guide already has a draft in progress. Finish or archive it first.",
      );
    }
    const revision = await this.loadRevision(guide.publishedRevisionId, guideId, workspaceId);
    const facts = await this.guideFacts(identity, workspaceAccess, guide, revision);
    requireAuthorized("guide.unpublish", { ...context, guide: facts });

    await this.replaceAudiences(identity, workspaceAccess, revision.row.$id, []);
    const changedAt = nowIso();
    await this.store.update(
      TABLES.guideRevisions,
      revision.row.$id,
      rowData(
        { status: "draft", updated_by: identity.userId },
        {
          ...revision.value,
          status: "draft",
          publishedAt: undefined,
          publishedBy: undefined,
          updatedAt: changedAt,
        },
      ),
    );
    await this.store.update(
      TABLES.guides,
      guideId,
      rowData(
        { status: "draft", updated_by: identity.userId },
        {
          ...guide,
          publishedRevisionId: null,
          workingRevisionId: revision.row.$id,
          updatedAt: changedAt,
        },
      ),
    );
    await appendAudit(this.store, identity, workspaceId, {
      action: "guide.unpublished",
      targetType: "guide",
      targetId: guideId,
      targetLabel: guide.title,
      summary: `${guide.title} returned to draft`,
      metadata: { revisionId: revision.row.$id },
    });
    return { unpublished: true, revisionId: revision.row.$id };
  }

  /**
   * Copies a guide into a new private draft, screenshots included.
   *
   * The media is cloned rather than shared: every guide owns its own objects,
   * so deleting or archiving one can never pull the pictures out from under
   * the other. Whichever revision the reader would currently see is the one
   * copied, so duplicating a live guide gives back what is live, not a
   * half-finished draft that happened to be lying next to it.
   */
  private async duplicate(
    identity: AuthenticatedIdentity,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
    context: AuthorizationContext,
    options: GuideCommandOptions,
  ) {
    requireAuthorized("guide.create", context);
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const sourceGuideId = resourceInput(payload.guideId, "Guide");
    const guideRow = await this.store.get(TABLES.guides, sourceGuideId);
    if (!guideRow || guideRow.workspace_id !== workspaceId) {
      throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    }
    const source = decodePayload<GuideRecord>(guideRow, null as never);
    if (source.deletedAt) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    const sourceRevisionId = source.publishedRevisionId ?? source.workingRevisionId;
    if (!sourceRevisionId) {
      throw new HttpError(409, "GUIDE_EMPTY", "This guide has no revision to copy.");
    }
    const revision = await this.loadRevision(sourceRevisionId, sourceGuideId, workspaceId);
    const facts = await this.guideFacts(identity, workspaceAccess, source, revision);
    requireAuthorized("guide.read", { ...context, guide: facts });

    const [stepRows, mediaRows] = await Promise.all([
      this.store.list(TABLES.guideSteps, {
        filters: [{ field: "subject_id", value: sourceRevisionId }],
      }),
      this.store.list(TABLES.privateMedia, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "subject_id", value: sourceRevisionId },
        ],
      }),
    ]);
    const sourceSteps = stepRows
      .sort((left, right) => Number(left.sequence) - Number(right.sequence))
      .map((row) => decodePayload<EditorBlock>(row, null as never));
    const referencedIds = [
      ...new Set(
        sourceSteps
          .map((step) => step.screenshotMediaId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (referencedIds.length > MAX_MEDIA_CLONES) {
      throw new HttpError(
        413,
        "GUIDE_MEDIA_LIMIT",
        `A duplicated guide can contain at most ${MAX_MEDIA_CLONES} screenshots.`,
      );
    }
    const byId = new Map(mediaRows.map((row) => [row.$id, row]));
    if (referencedIds.some((id) => !byId.has(id) || byId.get(id)!.status !== "ready")) {
      throw new HttpError(
        409,
        "REVISION_MEDIA_INCOMPLETE",
        "A private screenshot required by this guide is missing.",
      );
    }
    if (referencedIds.length && !this.objects) {
      throw new HttpError(
        503,
        "PRIVATE_STORAGE_UNAVAILABLE",
        "Private media storage is unavailable.",
        { expose: false },
      );
    }

    const guideId = resourceId("guide");
    const revisionId = resourceId("revision");
    const createdAt = nowIso();
    const title = duplicateTitle(source.title);
    const idMap = new Map<string, string>();
    const createdFiles: string[] = [];
    try {
      for (const sourceId of referencedIds) {
        const media = mediaValue(byId.get(sourceId)!);
        const nextId = resourceId("media");
        await this.objects!.clone(media.storageFileId, nextId, media.filename);
        createdFiles.push(nextId);
        idMap.set(sourceId, nextId);
      }
      const copiedSteps = sourceSteps.map((step) =>
        step.screenshotMediaId
          ? { ...step, screenshotMediaId: idMap.get(step.screenshotMediaId)! }
          : step,
      );
      const guide: GuideRecord = {
        ...source,
        title,
        authorUserId: identity.userId,
        workingRevisionId: revisionId,
        publishedRevisionId: null,
        archivedAt: null,
        // A copy has never been reviewed or locked, whatever the original was.
        screenshotsLockedAt: null,
        createdAt,
        updatedAt: createdAt,
      };
      delete guide.deletedAt;
      await this.store.create(
        TABLES.guides,
        guideId,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: identity.userId,
            status: "draft",
            created_by: identity.userId,
          },
          guide,
        ),
      );
      const copiedRevision: RevisionRecord = {
        ...revision.value,
        guideId,
        title,
        number: 1,
        status: "draft",
        authorId: identity.userId,
        createdAt,
        updatedAt: createdAt,
      };
      delete copiedRevision.reviewedBy;
      delete copiedRevision.reviewedAt;
      delete copiedRevision.submittedBy;
      delete copiedRevision.submittedAt;
      delete copiedRevision.publishedBy;
      delete copiedRevision.publishedAt;
      await this.store.create(
        TABLES.guideRevisions,
        revisionId,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            subject_id: guideId,
            status: "draft",
            version: 1,
            created_by: identity.userId,
          },
          copiedRevision,
        ),
      );
      for (const [sequence, step] of copiedSteps.entries()) {
        await this.store.create(
          TABLES.guideSteps,
          resourceId("step"),
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              subject_id: revisionId,
              status: "active",
              kind: step.kind,
              sequence,
              created_by: identity.userId,
            },
            step,
          ),
        );
      }
      // Audiences are deliberately not copied: a duplicate starts private, and
      // is shared on purpose rather than by inheritance.
      for (const sourceId of referencedIds) {
        const sourceMedia = mediaValue(byId.get(sourceId)!);
        const mediaId = idMap.get(sourceId)!;
        const media: PrivateMediaRecord = {
          ...sourceMedia,
          guideId,
          revisionId,
          stepId:
            copiedSteps.find((step) => step.screenshotMediaId === mediaId)?.id ?? null,
          storageFileId: mediaId,
          uploadedBy: identity.userId,
          createdAt,
          deletedAt: null,
        };
        await this.store.create(
          TABLES.privateMedia,
          mediaId,
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              subject_id: revisionId,
              user_id: identity.userId,
              status: "ready",
              kind: media.contentType,
              created_by: identity.userId,
            },
            media,
          ),
        );
      }
      await appendAudit(this.store, identity, workspaceId, {
        action: "guide.duplicated",
        targetType: "guide",
        targetId: guideId,
        targetLabel: title,
        summary: `${source.title} duplicated as ${title}`,
        metadata: {
          sourceGuideId,
          sourceRevisionId,
          revisionId,
          clonedMediaCount: referencedIds.length,
          requestId: options.requestId,
        },
      });
      return { guideId, revisionId };
    } catch (error) {
      if (this.objects) {
        await Promise.all(
          createdFiles.map((id) => this.objects!.delete(id).catch(() => undefined)),
        );
      }
      throw error;
    }
  }

  private async archive(
    identity: AuthenticatedIdentity,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
    context: AuthorizationContext,
  ) {
    requireAuthorized("guide.archive", context);
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const guideId = resourceInput(payload.guideId, "Guide");
    const guideRow = await this.store.get(TABLES.guides, guideId);
    if (!guideRow || guideRow.workspace_id !== workspaceId) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    const guide = decodePayload<GuideRecord>(guideRow, null as never);
    if (guide.deletedAt) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    const archivedAt = nowIso();
    const revisions = await this.store.list(TABLES.guideRevisions, {
      filters: [{ field: "subject_id", value: guideId }],
    });
    for (const row of revisions) {
      const value = decodePayload<RevisionRecord>(row, null as never);
      if (value.status !== "archived") {
        await this.store.update(TABLES.guideRevisions, row.$id, rowData({ status: "archived", updated_by: identity.userId }, { ...value, status: "archived", updatedAt: archivedAt }));
      }
    }
    await this.store.update(TABLES.guides, guideId, rowData({ status: "archived", updated_by: identity.userId }, { ...guide, archivedAt, updatedAt: archivedAt }));
    await appendAudit(this.store, identity, workspaceId, {
      action: "guide.archived",
      targetType: "guide",
      targetId: guideId,
      targetLabel: guide.title,
      summary: `${guide.title} archived`,
    });
    return { archived: true };
  }

  private async remove(
    identity: AuthenticatedIdentity,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
  ) {
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const guideId = resourceInput(payload.guideId, "Guide");
    const guideRow = await this.store.get(TABLES.guides, guideId);
    if (!guideRow || guideRow.workspace_id !== workspaceId) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    const guide = decodePayload<GuideRecord>(guideRow, null as never);
    if (guide.deletedAt) return { deleted: true };
    const mayDelete =
      workspaceAccess.roles.includes("publisher") ||
      (guide.authorUserId === identity.userId &&
        (workspaceAccess.roles.includes("creator") || workspaceAccess.roles.includes("administrator")) &&
        !guide.publishedRevisionId);
    if (!mayDelete) {
      throw new HttpError(403, "GUIDE_DELETE_FORBIDDEN", "You cannot delete this guide.");
    }
    const deletedAt = nowIso();
    const [revisions, mediaRows] = await Promise.all([
      this.store.list(TABLES.guideRevisions, { filters: [{ field: "subject_id", value: guideId }] }),
      this.store.list(TABLES.privateMedia, {
        filters: [{ field: "workspace_id", value: workspaceId }],
      }),
    ]);
    const revisionIds = new Set(revisions.map((row) => row.$id));
    for (const row of revisions) {
      const value = decodePayload<RevisionRecord>(row, null as never);
      await this.store.update(TABLES.guideRevisions, row.$id, rowData({ status: "archived", deleted_at: deletedAt, updated_by: identity.userId }, { ...value, status: "archived", updatedAt: deletedAt }));
    }
    for (const row of mediaRows.filter((candidate) => revisionIds.has(stringValue(candidate.subject_id)))) {
      const media = mediaValue(row);
      await this.store.update(TABLES.privateMedia, row.$id, rowData({ status: "quarantined", deleted_at: deletedAt, updated_by: identity.userId }, { ...media, deletedAt }));
    }
    await this.store.update(TABLES.guides, guideId, rowData({ status: "deleted", deleted_at: deletedAt, updated_by: identity.userId }, { ...guide, deletedAt, updatedAt: deletedAt }));
    await appendAudit(this.store, identity, workspaceId, {
      action: "guide.deleted",
      targetType: "guide",
      targetId: guideId,
      targetLabel: guide.title,
      summary: `${guide.title} moved to deletion quarantine`,
      metadata: { mediaCount: mediaRows.filter((candidate) => revisionIds.has(stringValue(candidate.subject_id))).length },
    });
    return { deleted: true };
  }

  private async restore(
    identity: AuthenticatedIdentity,
    payload: Record<string, unknown>,
    workspaceAccess: WorkspaceAccess,
    context: AuthorizationContext,
    options: GuideCommandOptions,
  ) {
    const workspaceId = workspaceAccess.workspaceRow.$id;
    const guideId = resourceInput(payload.guideId, "Guide");
    const sourceRevisionId = resourceInput(payload.revisionId, "Revision");
    const guideRow = await this.store.get(TABLES.guides, guideId);
    if (!guideRow || guideRow.workspace_id !== workspaceId) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    const guide = decodePayload<GuideRecord>(guideRow, null as never);
    if (guide.deletedAt) throw new HttpError(409, "GUIDE_QUARANTINED", "A quarantined guide requires a lifecycle recovery case.");
    if (guide.workingRevisionId && !guide.archivedAt) {
      throw new HttpError(409, "WORKING_DRAFT_EXISTS", "Finish or archive the current draft first.");
    }
    const mayRestore =
      guide.authorUserId === identity.userId &&
      (workspaceAccess.roles.includes("creator") || workspaceAccess.roles.includes("administrator"));
    if (!mayRestore) throw new HttpError(403, "DRAFT_EDITOR_REQUIRED", "You cannot restore this guide.");
    requireAuthorized("guide.create", context);
    const source = await this.loadRevision(sourceRevisionId, guideId, workspaceId);
    const revisionRows = await this.store.list(TABLES.guideRevisions, {
      filters: [{ field: "subject_id", value: guideId }],
    });
    const revisionNumber = Math.max(...revisionRows.map((row) => Number(row.version) || 0), 0) + 1;
    const revisionId = resourceId("revision");
    const [stepRows, audienceRows, mediaRows] = await Promise.all([
      this.store.list(TABLES.guideSteps, { filters: [{ field: "subject_id", value: sourceRevisionId }] }),
      this.store.list(TABLES.guideAudiences, { filters: [{ field: "subject_id", value: sourceRevisionId }] }),
      this.store.list(TABLES.privateMedia, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "subject_id", value: sourceRevisionId },
        ],
      }),
    ]);
    const sourceSteps = stepRows
      .sort((left, right) => Number(left.sequence) - Number(right.sequence))
      .map((row) => decodePayload<EditorBlock>(row, null as never));
    const referencedIds = [...new Set(sourceSteps.map((step) => step.screenshotMediaId).filter((id): id is string => Boolean(id)))];
    if (referencedIds.length > MAX_MEDIA_CLONES) throw new HttpError(413, "GUIDE_MEDIA_LIMIT", `A restored draft can contain at most ${MAX_MEDIA_CLONES} screenshots.`);
    const byId = new Map(mediaRows.map((row) => [row.$id, row]));
    if (referencedIds.some((id) => !byId.has(id) || byId.get(id)!.status !== "ready")) {
      throw new HttpError(409, "REVISION_MEDIA_INCOMPLETE", "A private screenshot required by this revision is missing.");
    }
    if (referencedIds.length && !this.objects) {
      throw new HttpError(503, "PRIVATE_STORAGE_UNAVAILABLE", "Private media storage is unavailable.", { expose: false });
    }
    const idMap = new Map<string, string>();
    const createdFiles: string[] = [];
    try {
      for (const sourceId of referencedIds) {
        const media = mediaValue(byId.get(sourceId)!);
        const nextId = resourceId("media");
        await this.objects!.clone(media.storageFileId, nextId, media.filename);
        createdFiles.push(nextId);
        idMap.set(sourceId, nextId);
      }
      const restoredSteps = sourceSteps.map((step) =>
        step.screenshotMediaId ? { ...step, screenshotMediaId: idMap.get(step.screenshotMediaId)! } : step,
      );
      const restoredAt = nowIso();
      const revision: RevisionRecord = {
        ...source.value,
        guideId,
        number: revisionNumber,
        status: "draft",
        authorId: identity.userId,
        createdAt: restoredAt,
        updatedAt: restoredAt,
      };
      delete revision.reviewedBy;
      delete revision.reviewedAt;
      delete revision.submittedBy;
      delete revision.submittedAt;
      delete revision.publishedBy;
      delete revision.publishedAt;
      await this.store.create(TABLES.guideRevisions, revisionId, rowData({ organization_id: workspaceAccess.workspace.organizationId, workspace_id: workspaceId, subject_id: guideId, status: "draft", version: revisionNumber, created_by: identity.userId }, revision));
      await this.store.update(
        TABLES.guides,
        guideId,
        rowData(
          { status: "draft", updated_by: identity.userId },
          {
            ...guide,
            workingRevisionId: revisionId,
            publishedRevisionId: null,
            archivedAt: null,
            updatedAt: restoredAt,
          },
        ),
      );
      for (const [sequence, step] of restoredSteps.entries()) {
        await this.store.create(TABLES.guideSteps, resourceId("step"), rowData({ organization_id: workspaceAccess.workspace.organizationId, workspace_id: workspaceId, subject_id: revisionId, status: "active", kind: step.kind, sequence, created_by: identity.userId }, step));
      }
      for (const row of audienceRows) {
        const audience = decodePayload<GuideAudienceRecord>(row, null as never);
        await this.store.create(TABLES.guideAudiences, resourceId("audience"), rowData({ organization_id: workspaceAccess.workspace.organizationId, workspace_id: workspaceId, subject_id: revisionId, user_id: audience.subjectId ?? workspaceId, kind: audience.kind, status: "active", created_by: identity.userId }, audience));
      }
      for (const sourceId of referencedIds) {
        const sourceMedia = mediaValue(byId.get(sourceId)!);
        const mediaId = idMap.get(sourceId)!;
        const media: PrivateMediaRecord = { ...sourceMedia, guideId, revisionId, stepId: restoredSteps.find((step) => step.screenshotMediaId === mediaId)?.id ?? null, storageFileId: mediaId, uploadedBy: identity.userId, createdAt: restoredAt, deletedAt: null };
        await this.store.create(TABLES.privateMedia, mediaId, rowData({ organization_id: workspaceAccess.workspace.organizationId, workspace_id: workspaceId, subject_id: revisionId, user_id: identity.userId, status: "ready", kind: media.contentType, created_by: identity.userId }, media));
      }
      await appendAudit(this.store, identity, workspaceId, {
        action: "guide.restored",
        targetType: "guide",
        targetId: guideId,
        targetLabel: source.value.title,
        summary: `${source.value.title} revision ${source.value.number} restored as draft`,
        metadata: { sourceRevisionId, revisionId, revisionNumber, clonedMediaCount: referencedIds.length, requestId: options.requestId },
      });
      return { revisionId };
    } catch (error) {
      if (this.objects) await Promise.all(createdFiles.map((id) => this.objects!.delete(id).catch(() => undefined)));
      throw error;
    }
  }
}
