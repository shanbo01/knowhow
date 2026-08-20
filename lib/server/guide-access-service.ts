import type { WorkspaceSettings } from "../knowhow-types";
import { isCapturedGuideSource } from "../guide-contracts";
import { AccessService, type WorkspaceAccess } from "./access-service";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  decodePayload,
  type GuideAudienceRecord,
  type GuideRecord,
  type RevisionRecord,
} from "./domain-records";
import { HttpError } from "./http-security";
import { TABLES } from "./appwrite-resources";
import { authorize, type PolicyAction } from "./policy";
import type { RecordData, RecordStore, StoredRecord } from "./record-store";
import type { AuthenticatedIdentity } from "./session-identity";

function value(value: unknown) {
  return typeof value === "string" ? value : "";
}

export type AuthorizedGuide = {
  guideRow: StoredRecord<RecordData>;
  guide: GuideRecord;
  revisionRow: StoredRecord<RecordData>;
  revision: RevisionRecord;
  access: WorkspaceAccess;
};

export class GuideAccessService {
  private readonly accessService: AccessService;

  constructor(private readonly store: RecordStore) {
    this.accessService = new AccessService(store);
  }

  async require(
    identity: AuthenticatedIdentity,
    workspaceId: string,
    guideId: string,
    revisionId: string,
    action: PolicyAction,
  ): Promise<AuthorizedGuide> {
    const access = await this.accessService.requireWorkspace(workspaceId, identity);
    const [guideRow, revisionRow] = await Promise.all([
      this.store.get(TABLES.guides, guideId),
      this.store.get(TABLES.guideRevisions, revisionId),
    ]);
    if (
      !guideRow || guideRow.workspace_id !== workspaceId || guideRow.status === "deleted" ||
      !revisionRow || revisionRow.workspace_id !== workspaceId || revisionRow.subject_id !== guideId
    ) {
      throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    }
    const guide = decodePayload<GuideRecord>(guideRow, null as never);
    const revision = decodePayload<RevisionRecord>(revisionRow, null as never);
    if (!guide || guide.deletedAt || !revision) throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
    const [audiences, assignments, groupMemberships, settingsRows] = await Promise.all([
      this.store.list(TABLES.guideAudiences, { filters: [{ field: "subject_id", value: revisionId }] }),
      this.store.list(TABLES.reviewAssignments, { filters: [{ field: "subject_id", value: revisionId }] }),
      this.store.list(TABLES.groupMemberships, { filters: [{ field: "workspace_id", value: workspaceId }, { field: "user_id", value: identity.userId }] }),
      this.store.list(TABLES.workspaceSettings, { filters: [{ field: "workspace_id", value: workspaceId }], limit: 1 }),
    ]);
    const groups = new Set(groupMemberships.map((row) => value(row.subject_id)));
    const audienceMember = audiences.some((row) => {
      const audience = decodePayload<GuideAudienceRecord>(row, null as never);
      return audience?.kind === "workspace" ||
        (audience?.kind === "user" && audience.subjectId === identity.userId) ||
        (audience?.kind === "group" && Boolean(audience.subjectId && groups.has(audience.subjectId)));
    });
    const settings = settingsRows[0]
      ? { ...DEFAULT_WORKSPACE_SETTINGS, ...decodePayload<Partial<WorkspaceSettings>>(settingsRows[0], {}) }
      : DEFAULT_WORKSPACE_SETTINGS;
    const context = this.accessService.context(access);
    const decision = authorize(action, {
      ...context,
      guide: {
        revisionStatus: revision.status,
        sourceType: isCapturedGuideSource(revision.source) ? "capture" : "manual",
        isAuthor: guide.authorUserId === identity.userId,
        isAssignedReviewer: assignments.some((row) => row.user_id === identity.userId),
        isAudienceMember: audienceMember,
        exportAllowed: audiences.some((row) => row.kind === "workspace") || settings.allowRestrictedExports,
        privacyReviewed: revision.source === "manual" || Boolean(revision.privacyReviewedAt),
        reviewApproved: assignments.some((row) => row.status === "approved") && !assignments.some((row) => row.status === "changes_requested"),
      },
    });
    if (!decision.allowed) {
      // Do not reveal guide existence across role/audience boundaries.
      throw new HttpError(action === "guide.update" ? 403 : 404, decision.code, action === "guide.update" ? decision.reason : "Guide not found.");
    }
    return { guideRow, guide, revisionRow, revision, access };
  }
}
