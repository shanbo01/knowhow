import type {
  Audience,
  EditorBlock,
  WorkspaceGroup,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSettings,
  WorkspaceStatus,
} from "../knowhow-types";
import type { RecordData } from "./record-store";

export type OrganizationRecord = {
  legalName: string;
  displayName: string;
  primaryContactName: string;
  primaryContactEmail: string;
  country: string;
  status: "provisioning" | "active" | "suspended" | "deleting" | "deleted";
  createdAt: string;
};

export type WorkspaceRecord = {
  organizationId: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  createdAt: string;
  auditSequence: number;
  auditHash: string;
  suspensionReason?: "manual" | "lifecycle" | null;
};

export type SubscriptionKind = "design_partner" | "trial" | "paid";
export type SubscriptionStatus =
  | "active"
  | "grace"
  | "suspended"
  | "converted"
  | "cancelled"
  | "deletion_pending"
  | "deleting"
  | "deleted";

export type SubscriptionRecord = {
  kind: SubscriptionKind;
  startsAt: string;
  expiresAt: string | null;
  graceDays: number;
  retentionDays: number;
  publicTrial: false;
  manualContract: boolean;
  status: SubscriptionStatus;
  extendedAt?: string;
  convertedAt?: string;
  lastEvaluatedAt?: string;
};

export type LifecycleAccess =
  | "active"
  | "read_only"
  | "suspended"
  | "deletion_pending"
  | "deleting"
  | "deleted";

export type LifecycleCaseRecord = {
  kind: "tenant_deletion_approval";
  subscriptionId: string;
  status: "awaiting_approval" | "approved" | "purging" | "completed" | "cancelled";
  eligibleAt: string;
  confirmationText: string;
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
  approvedByHash?: string;
  completedAt?: string;
  purgePlan?: {
    version: 3;
    createdAt: string;
    bindingHash: string;
    workspaceRows: number;
    workspaceFiles: number;
    organizationDeleted: boolean;
    organizationRows: number;
    organizationFiles: number;
    workspaceTargets: Array<{ tableId: string; rowIds: string[] }>;
    workspaceFileTargets: Array<{
      bucket: "private" | "exports";
      fileIds: string[];
    }>;
    organizationTargets: Array<{ tableId: string; rowIds: string[] }>;
    organizationFileTargets: Array<{
      bucket: "private" | "exports";
      fileIds: string[];
    }>;
    candidateUserIds: string[];
  };
  receipt?: {
    version: 2;
    deletedRows: number;
    deletedFiles: number;
    failedFiles: number;
    organizationHash: string;
    workspaceHash: string;
    organizationDeleted: boolean;
    organizationRowsDeleted: number;
    organizationFilesDeleted: number;
    authUsersRemoved: number;
    authUsersPreserved: number;
    userPreferenceRowsDeleted: number;
  };
};

export type ExportJobRecord = {
  guideId: string;
  revisionId: string;
  format: "pdf" | "html" | "markdown";
  filename: string;
  outputFileId: string;
  requestedAt: string;
  requester: {
    userId: string;
    name: string;
    email: string;
  };
  attempts: number;
  watermarked: boolean;
  leaseId?: string;
  leaseUntil?: string;
  retryAt?: string;
  completedAt?: string;
  failedAt?: string;
  expiresAt?: string;
  byteSize?: number;
  sha256?: string;
  contentType?: string;
  failureCode?: string;
};

export type WorkspaceMemberRecord = Omit<WorkspaceMember, "id" | "userId" | "email" | "status"> & {
  name: string;
  roles: WorkspaceRole[];
  capabilities: Array<"vault">;
};

export type WorkspaceGroupRecord = Omit<WorkspaceGroup, "id" | "memberIds" | "memberCount">;

export type GuideRecord = {
  title: string;
  slug: string;
  authorUserId: string;
  publishedRevisionId: string | null;
  workingRevisionId: string | null;
  screenshotsLockedAt: string | null;
  archivedAt: string | null;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type RevisionRecord = {
  guideId: string;
  number: number;
  status: "draft" | "review" | "published" | "archived";
  title: string;
  summary: string;
  category: string;
  tags: string[];
  systemReferences: string[];
  authorId: string;
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  submittedBy?: string;
  submittedAt?: string;
  publishedBy?: string;
  publishedAt?: string;
  privacyReviewedAt?: string;
  privacyReviewedBy?: string;
  source: "manual" | "browser-capture";
};

export type GuideStepRecord = EditorBlock;
export type GuideAudienceRecord = Audience;

export type PrivateMediaRecord = {
  guideId: string;
  revisionId: string;
  stepId: string | null;
  storageFileId: string;
  filename: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  redactionState: "pending" | "redacted";
  sourceRasterized: boolean;
  uploadedBy: string;
  createdAt: string;
  deletedAt: string | null;
};

export type SupportGrantRecord = {
  requestId: string;
  role: WorkspaceRole;
  email: string;
  displayName: string;
  approvedBy: string;
  grantedAt: string;
  expiresAt: string;
  endedAt: string | null;
  revokedBy: string | null;
  reason: string;
};

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  logoUrl: null,
  accentColor: "#2f6fed",
  clickTargetColor: "#ef4444",
  removeBranding: false,
  allowedDomains: [],
  excludedCaptureHosts: [],
  allowRestrictedExports: false,
  watermarkExports: true,
};

export function encodePayload(value: unknown) {
  return JSON.stringify(value);
}

export function decodePayload<T>(row: unknown, fallback: T): T {
  try {
    const payloadJson =
      typeof row === "object" && row !== null && "payload_json" in row
        ? (row as { payload_json?: unknown }).payload_json
        : undefined;
    const parsed = JSON.parse(String(payloadJson)) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export function rowData(
  fields: Record<string, string | number | boolean | null | string[] | number[] | undefined>,
  payload: unknown,
): RecordData {
  const result: RecordData = { payload_json: encodePayload(payload) };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
