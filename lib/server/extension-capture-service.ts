import type { Audience, EditorBlock, WorkspaceSettings } from "../knowhow-types";
import { appendAudit } from "./audit-service";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  decodePayload,
  rowData,
  type GuideRecord,
  type PrivateMediaRecord,
  type RevisionRecord,
  type WorkspaceRecord,
} from "./domain-records";
import type { ExtensionCredential } from "./extension-auth-service";
import { ExtensionAuthService } from "./extension-auth-service";
import { GuideAccessService } from "./guide-access-service";
import { normalizeGuideSteps } from "./guide-input";
import { HttpError, readJsonObject } from "./http-security";
import { resourceId } from "./ids";
import { inputInteger, inputObject, inputText, slugify } from "./input";
import { sha256Bytes, validateScreenshot } from "./media-validation";
import { TABLES } from "./appwrite-resources";
import { EntitlementService } from "./entitlement-service";
import type { PrivateObjectStore } from "./private-object-store";
import type { RecordStore } from "./record-store";

export const CAPTURE_POLICY_VERSION = "privacy-v2-redacted";
const MAX_CAPTURE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const SAFE_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type CaptureRecord = {
  workspaceId: string;
  organizationId: string;
  userId: string;
  deviceRecordId: string;
  sessionId: string;
  guideId: string;
  revisionId: string;
  title: string;
  policyVersion: string;
  sanitizedOrigin?: string;
  expectedSteps: number;
  status: "recording" | "paused" | "finished" | "discarded";
  startedAt: string;
  updatedAt: string;
  pausedAt?: string;
  finishedAt?: string;
};

async function stableId(prefix: string, input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex.slice(0, 35 - prefix.length)}`;
}

function clientId(input: unknown, label: string) {
  const id = inputText(input, label, { min: 1, max: 128 });
  if (!SAFE_CLIENT_ID.test(id)) throw new HttpError(400, "CAPTURE_ID_INVALID", `${label} is invalid.`);
  return id;
}

function coordinate(input: unknown, label: string) {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1) {
    throw new HttpError(400, "CAPTURE_STEPS_INVALID", `${label} is invalid.`);
  }
  return input;
}

function region(input: unknown, label: string) {
  const item = inputObject(input, label);
  const result = {
    x: coordinate(item.x, `${label} x`),
    y: coordinate(item.y, `${label} y`),
    width: coordinate(item.width, `${label} width`),
    height: coordinate(item.height, `${label} height`),
  };
  if (result.width <= 0 || result.height <= 0 || result.x + result.width > 1 || result.y + result.height > 1) {
    throw new HttpError(400, "CAPTURE_STEPS_INVALID", `${label} is outside the screenshot.`);
  }
  return result;
}

function safeOrigin(input: unknown, excludedHosts: readonly string[]) {
  if (input === undefined || input === null || input === "") return undefined;
  const text = inputText(input, "Capture URL", { max: 2_048 });
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, "CAPTURE_URL_INVALID", "The capture origin is invalid.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new HttpError(400, "CAPTURE_URL_INVALID", "The capture origin is invalid.");
  }
  const host = url.hostname.toLowerCase();
  if (excludedHosts.some((excluded) => host === excluded || host.endsWith(`.${excluded}`))) {
    throw new HttpError(403, "CAPTURE_ORIGIN_EXCLUDED", "Workspace policy excludes this capture origin.");
  }
  // Paths, query strings and fragments can contain identifiers or form data.
  return url.origin;
}

async function boundedBytes(request: Request) {
  const advertised = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(advertised) && advertised > MAX_SCREENSHOT_BYTES) {
    throw new HttpError(413, "MEDIA_TOO_LARGE", "The redacted screenshot is too large.");
  }
  if (!request.body) throw new HttpError(400, "MEDIA_EMPTY", "A redacted screenshot is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    total += chunk.byteLength;
    if (total > MAX_SCREENSHOT_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "MEDIA_TOO_LARGE", "The redacted screenshot is too large.");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertFresh(capture: CaptureRecord) {
  if (Date.now() - Date.parse(capture.startedAt) > MAX_CAPTURE_AGE_MS) {
    throw new HttpError(409, "CAPTURE_EXPIRED", "This capture is too old to continue.");
  }
}

export class ExtensionCaptureService {
  private readonly auth: ExtensionAuthService;

  constructor(
    private readonly store: RecordStore,
    private readonly objects: PrivateObjectStore,
  ) {
    this.auth = new ExtensionAuthService(store);
  }

  private async credential(request: Request, media = false) {
    return this.auth.authenticate(
      request,
      media ? ["capture:write", "media:write"] : ["capture:write"],
    );
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

  async context(request: Request) {
    const credential = await this.credential(request);
    const workspaceId = String(credential.row.workspace_id);
    const [settings, workspaceRow, preferenceRows] = await Promise.all([
      this.settings(workspaceId),
      this.store.get(TABLES.workspaces, workspaceId),
      this.store.list(TABLES.userPreferences, {
        filters: [{ field: "user_id", value: credential.identity.userId }],
        limit: 1,
      }),
    ]);
    const workspace = workspaceRow ? decodePayload<WorkspaceRecord>(workspaceRow, null as never) : null;
    const preference = preferenceRows[0]
      ? decodePayload<{ theme?: "light" | "dark" | "system" }>(preferenceRows[0], {})
      : {};
    return {
      workspaceId,
      workspaceName: workspace?.name ?? "KnowHow workspace",
      themePreference: preference.theme ?? "system",
      policyVersion: CAPTURE_POLICY_VERSION,
      excludedOrigins: settings.excludedCaptureHosts.map((host) => `https://${host}`),
      clickTargetColor: settings.clickTargetColor,
      minimumVersion: credential.details.minimumVersion,
      privacy: {
        excludePasswordFields: true,
        captureClipboard: false,
        captureRawKeystrokes: false,
        captureIncognito: false,
        retainUnredactedScreenshots: false,
        requireFlattenedRedactions: true,
        automatic: ["email", "phone-number", "financial-number", "identifier", "form-field"],
        assisted: ["common-name", "long-text"],
      },
    };
  }

  async media(request: Request, mediaId: string) {
    const credential = await this.credential(request);
    const workspaceId = String(credential.row.workspace_id);
    const row = await this.store.get(TABLES.privateMedia, mediaId);
    const media = row ? decodePayload<PrivateMediaRecord>(row, null as never) : null;
    if (!row || row.workspace_id !== workspaceId || row.status !== "ready" || !media || media.deletedAt) {
      throw new HttpError(404, "MEDIA_NOT_FOUND", "Media not found.");
    }
    await new GuideAccessService(this.store).require(
      credential.identity,
      workspaceId,
      media.guideId,
      media.revisionId,
      "guide.read",
    );
    const object = await this.objects.get(media.storageFileId);
    if (!object || object.contentType !== media.contentType || (await sha256Bytes(object.bytes)) !== media.sha256) {
      throw new HttpError(500, "MEDIA_INTEGRITY_FAILURE", "Private media failed its integrity check.", { expose: false });
    }
    return new Response(object.bytes.slice().buffer as ArrayBuffer, {
      headers: {
        "content-type": media.contentType,
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  }

  async start(request: Request) {
    const credential = await this.credential(request);
    const payload = await readJsonObject(request, 100_000);
    const sessionId = clientId(payload.sessionId, "Capture session");
    const idempotency = inputText(request.headers.get("idempotency-key"), "Idempotency key", { min: 8, max: 128 });
    if (!constantSessionKey(sessionId, idempotency)) {
      throw new HttpError(400, "IDEMPOTENCY_KEY_INVALID", "The capture idempotency key is invalid.");
    }
    const workspaceId = String(credential.row.workspace_id);
    if (payload.workspaceId !== undefined && payload.workspaceId !== workspaceId) {
      throw new HttpError(403, "WORKSPACE_TOKEN_MISMATCH", "The capture belongs to another workspace.");
    }
    const policyVersion = inputText(payload.policyVersion, "Policy version", { min: 1, max: 100 });
    if (policyVersion !== CAPTURE_POLICY_VERSION) {
      throw new HttpError(409, "CAPTURE_POLICY_STALE", "Refresh the workspace capture policy before recording.");
    }
    const title = inputText(payload.title ?? "Captured workflow", "Guide title", { min: 2, max: 500 });
    const expectedSteps = inputInteger(payload.stepCount ?? 0, "Step count", 0, 100);
    const settings = await this.settings(workspaceId);
    const sanitizedOrigin = safeOrigin(payload.sanitizedUrl ?? payload.origin, settings.excludedCaptureHosts);
    const captureId = await stableId("capture", `${workspaceId}:${credential.identity.userId}:${sessionId}`);
    const existingRow = await this.store.get(TABLES.captures, captureId);
    if (existingRow) {
      const existing = decodePayload<CaptureRecord>(existingRow, null as never);
      if (existing.workspaceId !== workspaceId || existing.userId !== credential.identity.userId || existing.sessionId !== sessionId) {
        throw new HttpError(409, "CAPTURE_ID_CONFLICT", "The capture idempotency key is already in use.");
      }
      return {
        captureId,
        guideId: existing.guideId,
        revisionId: existing.revisionId,
        status: existing.status,
        expectedSteps: existing.expectedSteps,
      };
    }
    const guideId = resourceId("guide");
    const revisionId = resourceId("revision");
    const timestamp = new Date().toISOString();
    const guide: GuideRecord = {
      title,
      slug: `${slugify(title)}-${guideId.slice(-5)}`,
      authorUserId: credential.identity.userId,
      publishedRevisionId: null,
      workingRevisionId: revisionId,
      screenshotsLockedAt: null,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const revision: RevisionRecord = {
      guideId,
      number: 1,
      status: "draft",
      title,
      summary: "Captured browser workflow pending author review.",
      category: "",
      tags: [],
      systemReferences: [],
      authorId: credential.identity.userId,
      createdAt: timestamp,
      updatedAt: timestamp,
      source: "browser-capture",
    };
    const capture: CaptureRecord = {
      workspaceId,
      organizationId: credential.access.workspace.organizationId,
      userId: credential.identity.userId,
      deviceRecordId: credential.row.$id,
      sessionId,
      guideId,
      revisionId,
      title,
      policyVersion,
      ...(sanitizedOrigin ? { sanitizedOrigin } : {}),
      expectedSteps,
      status: "recording",
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.transaction(async (transaction) => {
      await transaction.create(TABLES.guides, guideId, rowData({ organization_id: capture.organizationId, workspace_id: workspaceId, subject_id: guideId, slug: guide.slug, status: "draft", created_by: credential.identity.userId }, guide));
      await transaction.create(TABLES.guideRevisions, revisionId, rowData({ organization_id: capture.organizationId, workspace_id: workspaceId, subject_id: guideId, status: "draft", version: 1, created_by: credential.identity.userId }, revision));
      const audience: Audience = { kind: "user", subjectId: credential.identity.userId, label: "Capture author" };
      await transaction.create(TABLES.guideAudiences, resourceId("audience"), rowData({ organization_id: capture.organizationId, workspace_id: workspaceId, subject_id: revisionId, user_id: credential.identity.userId, kind: "user", status: "active", created_by: credential.identity.userId }, audience));
      await transaction.create(TABLES.captures, captureId, rowData({ organization_id: capture.organizationId, workspace_id: workspaceId, user_id: credential.identity.userId, subject_id: guideId, status: "recording", kind: "browser", idempotency_key: idempotency, created_by: credential.identity.userId }, capture));
      await appendAudit(transaction, credential.identity, workspaceId, { action: "capture.started", targetType: "capture", targetId: captureId, targetLabel: title, summary: `${title} private capture upload started`, metadata: { expectedSteps } });
    });
    return { captureId, guideId, revisionId, status: "recording", expectedSteps };
  }

  private async capture(captureId: string, credential: ExtensionCredential) {
    const row = await this.store.get(TABLES.captures, captureId);
    const capture = row ? decodePayload<CaptureRecord>(row, null as never) : null;
    if (
      !row || !capture || capture.workspaceId !== credential.row.workspace_id ||
      capture.userId !== credential.identity.userId || capture.deviceRecordId !== credential.row.$id
    ) {
      throw new HttpError(404, "CAPTURE_NOT_FOUND", "Capture not found.");
    }
    return { row, capture };
  }

  async expectedSteps(request: Request, captureId: string) {
    const credential = await this.credential(request);
    const current = await this.capture(captureId, credential);
    if (current.capture.status !== "recording" && current.capture.status !== "paused") {
      throw new HttpError(409, "CAPTURE_TERMINAL", "This capture can no longer be changed.");
    }
    assertFresh(current.capture);
    const payload = await readJsonObject(request, 20_000);
    const expectedSteps = inputInteger(payload.expectedSteps, "Expected steps", 1, 100);
    const media = await this.captureMedia(current.capture);
    if (media.length && expectedSteps !== current.capture.expectedSteps) {
      throw new HttpError(409, "CAPTURE_MEDIA_STARTED", "The expected step count cannot change after screenshot upload begins.");
    }
    if (expectedSteps !== current.capture.expectedSteps) {
      const next = { ...current.capture, expectedSteps, updatedAt: new Date().toISOString() };
      await this.store.transaction(async (transaction) => {
        await transaction.update(TABLES.captures, captureId, rowData({ updated_by: credential.identity.userId }, next));
        await appendAudit(transaction, credential.identity, current.capture.workspaceId, { action: "capture.expected-steps-updated", targetType: "capture", targetId: captureId, targetLabel: current.capture.title, summary: `${current.capture.title} expected step count updated`, metadata: { previousExpectedSteps: current.capture.expectedSteps, expectedSteps } });
      });
    }
    return { captureId, status: current.capture.status, expectedSteps };
  }

  async transition(request: Request, captureId: string, transition: "pause" | "resume") {
    const credential = await this.credential(request);
    const current = await this.capture(captureId, credential);
    const target = transition === "pause" ? "paused" : "recording";
    if (current.capture.status === target) return { captureId, status: target };
    const required = transition === "pause" ? "recording" : "paused";
    if (current.capture.status !== required) throw new HttpError(409, "CAPTURE_TRANSITION_INVALID", `This capture cannot ${transition}.`);
    assertFresh(current.capture);
    const timestamp = new Date().toISOString();
    const next: CaptureRecord = { ...current.capture, status: target, updatedAt: timestamp, ...(target === "paused" ? { pausedAt: timestamp } : {}) };
    if (target === "recording") delete next.pausedAt;
    await this.store.transaction(async (transaction) => {
      await transaction.update(TABLES.captures, captureId, rowData({ status: target, updated_by: credential.identity.userId }, next));
      await appendAudit(transaction, credential.identity, current.capture.workspaceId, { action: `capture.${transition}d`, targetType: "capture", targetId: captureId, targetLabel: current.capture.title, summary: `${current.capture.title} capture ${transition}d` });
    });
    return { captureId, status: target };
  }

  private async captureMedia(capture: CaptureRecord) {
    const rows = await this.store.list(TABLES.privateMedia, {
      filters: [
        { field: "workspace_id", value: capture.workspaceId },
        { field: "subject_id", value: capture.revisionId },
      ],
    });
    return rows.filter(
      (row) =>
        decodePayload<PrivateMediaRecord & { captureId?: string }>(
          row,
          null as never,
        )?.captureId === capture.sessionId,
    );
  }

  async upload(request: Request, captureId: string, stepId: string) {
    const credential = await this.credential(request, true);
    const current = await this.capture(captureId, credential);
    if (current.capture.status !== "recording") throw new HttpError(409, "CAPTURE_NOT_RECORDING", "This capture no longer accepts screenshots.");
    assertFresh(current.capture);
    if (current.capture.expectedSteps < 1) throw new HttpError(409, "CAPTURE_STEP_COUNT_REQUIRED", "Set the expected step count before uploading.");
    const idempotency = inputText(request.headers.get("idempotency-key"), "Idempotency key", { min: 8, max: 256 });
    if (!idempotency.endsWith(`:${stepId}`)) throw new HttpError(400, "IDEMPOTENCY_KEY_INVALID", "The screenshot idempotency key is invalid.");
    if (request.headers.get("x-knowhow-source-rasterized") !== "true" || request.headers.get("x-knowhow-redacted") !== "true") {
      throw new HttpError(400, "REDACTION_ATTESTATION_REQUIRED", "Flatten all redactions locally before upload.");
    }
    const bytes = await boundedBytes(request);
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const validated = await validateScreenshot(bytes, contentType, Number(request.headers.get("x-knowhow-image-width")), Number(request.headers.get("x-knowhow-image-height")));
    const mediaId = await stableId("media", `${captureId}:${stepId}`);
    const existing = await this.store.get(TABLES.privateMedia, mediaId);
    if (existing) {
      const metadata = decodePayload<PrivateMediaRecord & { captureId?: string }>(existing, null as never);
      if (existing.workspace_id !== current.capture.workspaceId || metadata.captureId !== current.capture.sessionId || metadata.sha256 !== validated.sha256) {
        throw new HttpError(409, "CAPTURE_MEDIA_CONFLICT", "This capture step was already uploaded with different bytes.");
      }
      return { captureId, stepId, mediaId, uploaded: true };
    }
    if ((await this.captureMedia(current.capture)).length >= current.capture.expectedSteps) {
      throw new HttpError(409, "CAPTURE_MEDIA_LIMIT", "This capture already has all expected screenshots.");
    }
    await new EntitlementService(this.store, current.capture.workspaceId).assertStorageCapacity(
      validated.byteSize,
    );
    let createdObject = false;
    const orphan = await this.objects.get(mediaId);
    if (orphan) {
      if (orphan.contentType !== validated.contentType || (await sha256Bytes(orphan.bytes)) !== validated.sha256) {
        throw new HttpError(500, "MEDIA_INTEGRITY_FAILURE", "A private media identifier collision occurred.", { expose: false });
      }
    } else {
      await this.objects.put({ id: mediaId, bytes, filename: `capture.${validated.contentType === "image/png" ? "png" : "jpg"}`, contentType: validated.contentType });
      createdObject = true;
    }
    const timestamp = new Date().toISOString();
    const media: PrivateMediaRecord & { captureId: string } = {
      guideId: current.capture.guideId,
      revisionId: current.capture.revisionId,
      stepId,
      storageFileId: mediaId,
      filename: `capture.${validated.contentType === "image/png" ? "png" : "jpg"}`,
      contentType: validated.contentType,
      byteSize: validated.byteSize,
      width: validated.width,
      height: validated.height,
      sha256: validated.sha256,
      redactionState: "redacted",
      sourceRasterized: true,
      uploadedBy: credential.identity.userId,
      createdAt: timestamp,
      deletedAt: null,
      captureId: current.capture.sessionId,
    };
    try {
      await this.store.create(TABLES.privateMedia, mediaId, rowData({ organization_id: current.capture.organizationId, workspace_id: current.capture.workspaceId, subject_id: current.capture.revisionId, user_id: credential.identity.userId, status: "ready", kind: validated.contentType, idempotency_key: idempotency, created_by: credential.identity.userId }, media));
    } catch (error) {
      if (createdObject) await this.objects.delete(mediaId).catch(() => undefined);
      throw error;
    }
    return { captureId, stepId, mediaId, uploaded: true };
  }

  async discard(request: Request, captureId: string) {
    const credential = await this.credential(request);
    const current = await this.capture(captureId, credential);
    if (current.capture.status === "discarded") return { captureId, status: "discarded", deleted: true };
    if (current.capture.status === "finished") throw new HttpError(409, "CAPTURE_ALREADY_COMMITTED", "A committed capture cannot be discarded here.");
    const timestamp = new Date().toISOString();
    const mediaRows = await this.captureMedia(current.capture);
    await this.store.transaction(async (transaction) => {
      for (const row of mediaRows) {
        const media = decodePayload<PrivateMediaRecord>(row, null as never);
        await transaction.update(TABLES.privateMedia, row.$id, rowData({ status: "quarantined", deleted_at: timestamp, updated_by: credential.identity.userId }, { ...media, deletedAt: timestamp }));
      }
      const guideRow = await transaction.get(TABLES.guides, current.capture.guideId);
      if (guideRow) {
        const guide = decodePayload<GuideRecord>(guideRow, null as never);
        await transaction.update(TABLES.guides, guideRow.$id, rowData({ status: "deleted", deleted_at: timestamp, updated_by: credential.identity.userId }, { ...guide, deletedAt: timestamp, updatedAt: timestamp }));
      }
      const next: CaptureRecord = { ...current.capture, status: "discarded", finishedAt: timestamp, updatedAt: timestamp };
      await transaction.update(TABLES.captures, captureId, rowData({ status: "discarded", updated_by: credential.identity.userId }, next));
      await appendAudit(transaction, credential.identity, current.capture.workspaceId, { action: "capture.discarded", targetType: "capture", targetId: captureId, targetLabel: current.capture.title, summary: `${current.capture.title} private capture discarded`, metadata: { mediaCount: mediaRows.length } });
    });
    return { captureId, status: "discarded", deleted: true };
  }

  async commit(request: Request, captureId: string) {
    const credential = await this.credential(request);
    const current = await this.capture(captureId, credential);
    if (current.capture.status === "finished") {
      return { guideId: current.capture.guideId, revisionId: current.capture.revisionId, editUrl: await this.editUrl(request, current.capture) };
    }
    if (current.capture.status !== "recording") throw new HttpError(409, "CAPTURE_NOT_RECORDING", "This capture cannot be committed.");
    assertFresh(current.capture);
    const payload = await readJsonObject(request, 500_000);
    if (!Array.isArray(payload.steps) || payload.steps.length < 1 || payload.steps.length > 100 || payload.steps.length !== current.capture.expectedSteps) {
      throw new HttpError(409, "CAPTURE_STEP_COUNT_MISMATCH", "The reviewed step count does not match this capture.");
    }
    const mediaRows = await this.captureMedia(current.capture);
    if (mediaRows.length !== payload.steps.length) throw new HttpError(409, "CAPTURE_MEDIA_INCOMPLETE", "Every capture step needs one redacted screenshot.");
    const mediaByStep = new Map(mediaRows.map((row) => [decodePayload<PrivateMediaRecord>(row, null as never).stepId, row]));
    const editorSteps: EditorBlock[] = payload.steps.map((candidate, index) => {
      const step = inputObject(candidate, `Step ${index + 1}`);
      const id = clientId(step.id, `Step ${index + 1} ID`);
      if (step.order !== index || !mediaByStep.has(id)) throw new HttpError(400, "CAPTURE_STEPS_INVALID", "Capture step ordering is invalid.");
      const click = step.clickTarget === undefined ? null : inputObject(step.clickTarget, "Click target");
      const redactions = step.redactions === undefined
        ? []
        : Array.isArray(step.redactions)
          ? step.redactions.map((item, redactionIndex) => ({ id: clientId(inputObject(item, "Redaction").id ?? `redaction_${redactionIndex}`, "Redaction ID"), ...region(item, "Redaction"), applied: true }))
          : (() => { throw new HttpError(400, "CAPTURE_STEPS_INVALID", "Redactions are invalid."); })();
      const mediaId = mediaByStep.get(id)!.$id;
      return {
        id,
        kind: "action",
        title: inputText(step.title, "Step title", { min: 1, max: 500 }),
        description: inputText(step.instructions, "Step instructions", { min: 1, max: 2_000 }),
        screenshotMediaId: mediaId,
        ...(step.crop === undefined ? {} : { crop: region(step.crop, "Crop") }),
        ...(click
          ? {
              annotations: [{
                id: `click_${index}`,
                kind: "click" as const,
                x: coordinate(click.x, "Click x"),
                y: coordinate(click.y, "Click y"),
                width: typeof click.radius === "number" ? Math.min(0.25, Math.max(0.001, click.radius)) : 0.035,
                color: typeof click.color === "string" && /^#[0-9a-f]{6}$/i.test(click.color) ? click.color : undefined,
              }],
            }
          : {}),
        ...(redactions.length ? { redactions } : {}),
      };
    });
    const normalizedSteps = normalizeGuideSteps(editorSteps);
    const privacy = inputObject(payload.privacyReview, "Privacy review");
    if (privacy.policyVersion !== CAPTURE_POLICY_VERSION) throw new HttpError(409, "CAPTURE_POLICY_STALE", "Refresh the capture policy before finishing.");
    const completedAt = inputText(privacy.completedAt, "Privacy review time", { min: 20, max: 40 });
    if (Number.isNaN(Date.parse(completedAt))) throw new HttpError(400, "PRIVACY_REVIEW_INVALID", "The privacy review receipt is invalid.");
    const automaticMaskCount = inputInteger(privacy.automaticMaskCount ?? 0, "Automatic mask count", 0, 100_000);
    const manualMaskCount = inputInteger(privacy.manualMaskCount ?? 0, "Manual mask count", 0, 100_000);
    const timestamp = new Date().toISOString();
    await this.store.transaction(async (transaction) => {
      for (const old of await transaction.list(TABLES.guideSteps, { filters: [{ field: "subject_id", value: current.capture.revisionId }] })) await transaction.delete(TABLES.guideSteps, old.$id);
      for (const [sequence, step] of normalizedSteps.entries()) {
        await transaction.create(TABLES.guideSteps, resourceId("step"), rowData({ organization_id: current.capture.organizationId, workspace_id: current.capture.workspaceId, subject_id: current.capture.revisionId, status: "active", kind: "action", sequence, created_by: credential.identity.userId }, step));
        const mediaRow = mediaByStep.get(step.id)!;
        const media = decodePayload<PrivateMediaRecord & { captureId?: string }>(mediaRow, null as never);
        await transaction.update(TABLES.privateMedia, mediaRow.$id, rowData({ updated_by: credential.identity.userId }, { ...media, stepId: step.id }));
      }
      const revisionRow = await transaction.get(TABLES.guideRevisions, current.capture.revisionId);
      const revision = revisionRow ? decodePayload<RevisionRecord>(revisionRow, null as never) : null;
      if (!revisionRow || !revision || revision.status !== "draft") throw new HttpError(409, "CAPTURE_REVISION_UNAVAILABLE", "The capture draft is unavailable.");
      await transaction.update(TABLES.guideRevisions, revisionRow.$id, rowData({ updated_by: credential.identity.userId }, { ...revision, title: current.capture.title, summary: "Captured browser workflow ready for editing.", privacyReviewedAt: timestamp, privacyReviewedBy: credential.identity.userId, updatedAt: timestamp }));
      const guideRow = await transaction.get(TABLES.guides, current.capture.guideId);
      if (!guideRow) throw new HttpError(409, "CAPTURE_GUIDE_UNAVAILABLE", "The capture guide is unavailable.");
      const guide = decodePayload<GuideRecord>(guideRow, null as never);
      await transaction.update(TABLES.guides, guideRow.$id, rowData({ status: "draft", updated_by: credential.identity.userId }, { ...guide, title: current.capture.title, updatedAt: timestamp }));
      await transaction.update(TABLES.captures, captureId, rowData({ status: "finished", updated_by: credential.identity.userId }, { ...current.capture, status: "finished", finishedAt: timestamp, updatedAt: timestamp }));
      await transaction.create(TABLES.usageEvents, resourceId("usage"), rowData({ organization_id: current.capture.organizationId, workspace_id: current.capture.workspaceId, user_id: credential.identity.userId, subject_id: current.capture.guideId, kind: "capture.completed", status: "recorded", occurred_at: timestamp, created_by: credential.identity.userId }, { stepCount: normalizedSteps.length, automaticMaskCount, manualMaskCount }));
      await appendAudit(transaction, credential.identity, current.capture.workspaceId, { action: "capture.finished", targetType: "guide", targetId: current.capture.guideId, targetLabel: current.capture.title, summary: `${current.capture.title} saved as a private redacted draft`, metadata: { revisionId: current.capture.revisionId, stepCount: normalizedSteps.length, automaticMaskCount, manualMaskCount, originalMediaRetained: false } });
    });
    return { guideId: current.capture.guideId, revisionId: current.capture.revisionId, editUrl: await this.editUrl(request, current.capture) };
  }

  private async editUrl(request: Request, capture: CaptureRecord) {
    const workspaceRow = await this.store.get(TABLES.workspaces, capture.workspaceId);
    const workspace = workspaceRow ? decodePayload<WorkspaceRecord>(workspaceRow, null as never) : null;
    if (!workspace) throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    return new URL(`/w/${encodeURIComponent(workspace.slug)}/guides/${encodeURIComponent(capture.guideId)}/edit`, request.url).toString();
  }
}

function constantSessionKey(sessionId: string, idempotency: string) {
  if (sessionId.length !== idempotency.length) return false;
  let mismatch = 0;
  for (let index = 0; index < sessionId.length; index += 1) {
    mismatch |= sessionId.charCodeAt(index) ^ idempotency.charCodeAt(index);
  }
  return mismatch === 0;
}
