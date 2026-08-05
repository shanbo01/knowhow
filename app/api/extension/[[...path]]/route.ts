import { env } from "cloudflare:workers";
import {
  allRows,
  authorize,
  deletePrivateMedia,
  D1RivetRepository,
  hashToken,
  HttpError,
  jsonResponse,
  readJsonObject,
  requireBearerToken,
  requireD1Binding,
  requireR2Binding,
  signDeviceToken,
  storeRedactedScreenshot,
  toErrorResponse,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type DeviceScope,
  type ValidatedDeviceCredential,
} from "../../../../lib/server";
import { parseGuideRevision, type DraftGuideRevision } from "../../../../lib/guide-contracts";

export const runtime = "edge";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path?: string[] }> };

function dbBinding() {
  return requireD1Binding(env.DB);
}

function statement(db: D1DatabaseLike, sql: string, ...values: unknown[]) {
  return db.prepare(sql).bind(...values);
}

async function rows<T>(db: D1DatabaseLike, sql: string, ...values: unknown[]) {
  return allRows<T>(statement(db, sql, ...values));
}

async function first<T>(db: D1DatabaseLike, sql: string, ...values: unknown[]) {
  return statement(db, sql, ...values).first<T>();
}

async function run(db: D1DatabaseLike, sql: string, ...values: unknown[]) {
  const result = await statement(db, sql, ...values).run();
  if (!result.success) {
    throw new HttpError(500, "DATABASE_MUTATION_FAILED", "The capture could not be saved.", {
      expose: false,
    });
  }
  return result;
}

function key() {
  return env.RIVET_TOKEN_SIGNING_KEY;
}

function text(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
) {
  if (typeof value !== "string") throw new HttpError(400, "CAPTURE_PAYLOAD_INVALID", `${label} is required.`);
  const clean = value.trim();
  if (clean.length < (options.min ?? 0) || clean.length > (options.max ?? 500)) {
    throw new HttpError(400, "CAPTURE_PAYLOAD_INVALID", `${label} is invalid.`);
  }
  return clean;
}

function integer(value: unknown, label: string, min: number, max: number) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < min || (parsed as number) > max) {
    throw new HttpError(400, "CAPTURE_PAYLOAD_INVALID", `${label} is invalid.`);
  }
  return parsed as number;
}

function safeId(value: unknown, label: string) {
  const clean = text(value, label, { min: 1, max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(clean)) {
    throw new HttpError(400, "CAPTURE_ID_INVALID", `${label} is invalid.`);
  }
  return clean;
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Capture completion must return the author to the exact tenant and to the
 * draft editor. A guide ID alone is not enough: a user may belong to more than
 * one workspace, and a just-captured guide has no published revision to view.
 */
function captureEditUrl(request: Request, workspaceId: string, guideId: string) {
  const url = new URL("/", request.url);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("guide", guideId);
  url.searchParams.set("edit", "1");
  return url.toString();
}

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOT_PIXELS = 25_000_000;
const MAX_CAPTURE_AGE_MS = 24 * 60 * 60 * 1_000;

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const advertised = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(advertised) && advertised > maximumBytes) {
    throw new HttpError(413, "MEDIA_TOO_LARGE", "The redacted screenshot is too large.");
  }
  if (!request.body) {
    throw new HttpError(400, "MEDIA_EMPTY", "A redacted screenshot is required.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "MEDIA_TOO_LARGE", "The redacted screenshot is too large.");
    }
    chunks.push(value);
  }
  if (total === 0) {
    throw new HttpError(400, "MEDIA_EMPTY", "A redacted screenshot is required.");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function excludedCaptureHosts(db: D1DatabaseLike, workspaceId: string) {
  const settings = await first<{ capture_policy_json: string }>(
    db,
    `SELECT capture_policy_json FROM workspace_settings WHERE workspace_id = ?`,
    workspaceId,
  );
  const policy = safeJson<{ excludedHosts?: unknown }>(settings?.capture_policy_json ?? "{}", {});
  return Array.isArray(policy.excludedHosts)
    ? policy.excludedHosts
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase().replace(/\.$/, ""))
        .filter(Boolean)
    : [];
}

function sanitizedCaptureUrl(value: unknown, excludedHosts: readonly string[], label: string) {
  if (value === undefined || value === null || value === "") return "";
  const raw = text(value, label, { max: 2_000 });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, "CAPTURE_URL_INVALID", `${label} is invalid.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(400, "CAPTURE_URL_INVALID", `${label} must use HTTP or HTTPS.`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    excludedHosts.some(
      (excluded) => hostname === excluded || hostname.endsWith(`.${excluded}`),
    )
  ) {
    throw new HttpError(403, "CAPTURE_ORIGIN_EXCLUDED", "Workspace policy excludes this capture origin.");
  }
  // A path can itself contain email addresses, account IDs, or tokens. Persist
  // only the policy-checked origin; the guide does not need navigation details.
  return parsed.origin;
}

function assertCaptureFresh(startedAt: string) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || Date.now() - started > MAX_CAPTURE_AGE_MS) {
    throw new HttpError(409, "CAPTURE_EXPIRED", "This capture is too old to continue.");
  }
}

function slug(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 52) || "captured-guide";
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function authenticateDevice(
  request: Request,
  db: D1DatabaseLike,
  repository: D1RivetRepository,
  scopes: DeviceScope[],
) {
  const token = requireBearerToken(request);
  const credential = await repository.validateDeviceCredential(token, key());
  for (const scope of scopes) {
    if (!credential.claims.scopes.includes(scope)) {
      throw new HttpError(403, "DEVICE_SCOPE_REQUIRED", "The paired extension lacks the required scope.");
    }
  }
  const access = await repository.getWorkspaceAccess(
    credential.claims.workspaceId,
    credential.claims.userId,
  );
  if (!access) throw new HttpError(403, "MEMBERSHIP_REQUIRED", "The paired account no longer belongs to this workspace.");
  const context = {
    isVerifiedIdentity: true,
    membershipStatus: access.membershipStatus,
    workspaceStatus: access.workspaceStatus,
    roles: access.roles,
    capabilities: access.capabilities,
  } as const;
  if (!authorize("capture.create", context).allowed) {
    throw new HttpError(403, "CAPTURE_NOT_ALLOWED", "This account can no longer create captures.");
  }
  return { credential, access };
}

async function deviceActor(
  db: D1DatabaseLike,
  credential: ValidatedDeviceCredential,
) {
  const member = await first<{ email: string; display_name: string | null }>(
    db,
    `SELECT email, display_name FROM workspace_members
     WHERE workspace_id = ? AND user_id = ?`,
    credential.claims.workspaceId,
    credential.claims.userId,
  );
  return {
    userId: credential.claims.userId,
    email: member?.email,
    name: member?.display_name ?? member?.email,
  };
}

async function pair(request: Request, db: D1DatabaseLike, repository: D1RivetRepository) {
  const payload = await readJsonObject(request, 20_000);
  const code = text(payload.code, "Pairing code", { min: 9, max: 20 }).toUpperCase();
  const deviceId = safeId(payload.deviceId, "Device ID");
  const codeHash = await hashToken(code);
  const pending = await first<{
    id: string;
    workspace_id: string;
    user_id: string;
    expires_at: string;
    scopes_json: string;
  }>(
    db,
    `SELECT id, workspace_id, user_id, expires_at, scopes_json
     FROM device_tokens
     WHERE token_hash = ? AND device_id LIKE 'pair:%' AND revoked_at IS NULL
       AND unixepoch(expires_at) > unixepoch('now') LIMIT 1`,
    codeHash,
  );
  if (!pending) throw new HttpError(401, "PAIRING_CODE_INVALID", "The pairing code is invalid or expired.");
  const access = await repository.getWorkspaceAccess(pending.workspace_id, pending.user_id);
  if (!access || !authorize("capture.create", {
    isVerifiedIdentity: true,
    membershipStatus: access.membershipStatus,
    workspaceStatus: access.workspaceStatus,
    roles: access.roles,
    capabilities: access.capabilities,
  }).allowed) {
    throw new HttpError(403, "PAIRING_NOT_ALLOWED", "This account can no longer pair a capture device.");
  }
  const scopes = safeJson<DeviceScope[]>(pending.scopes_json, []);
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
  const accessToken = await signDeviceToken(
    {
      jti: pending.id,
      workspaceId: pending.workspace_id,
      userId: pending.user_id,
      deviceId,
      scopes,
      expiresAt: expiresAtSeconds,
    },
    key(),
  );
  const tokenHash = await hashToken(accessToken);
  const expiresAt = new Date(expiresAtSeconds * 1000).toISOString();
  const member = await first<{ email: string; display_name: string | null }>(
    db,
    `SELECT email, display_name FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    pending.workspace_id,
    pending.user_id,
  );
  await repository.executeAuditedMutation({
    workspaceId: pending.workspace_id,
    actor: {
      userId: pending.user_id,
      email: member?.email,
      name: member?.display_name ?? member?.email,
    },
    event: {
      action: "capture.device-paired",
      targetType: "device-token",
      targetId: pending.id,
      summary: "Browser capture extension paired",
      metadata: { deviceId },
    },
    statements: [
      statement(
        db,
        `UPDATE device_tokens SET device_id = ?, token_hash = ?, expires_at = ?,
          last_used_at = CURRENT_TIMESTAMP WHERE id = ?`,
        deviceId,
        tokenHash,
        expiresAt,
        pending.id,
      ),
    ],
  });
  return jsonResponse({
    accessToken,
    refreshToken: accessToken,
    expiresAt,
    workspaceId: pending.workspace_id,
  });
}

async function refresh(request: Request, db: D1DatabaseLike, repository: D1RivetRepository) {
  const payload = await readJsonObject(request, 20_000);
  const refreshToken = text(payload.refreshToken, "Device credential", { min: 20, max: 8192 });
  const credential = await repository.validateDeviceCredential(refreshToken, key());
  await run(
    db,
    `UPDATE device_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`,
    credential.claims.jti,
  );
  return jsonResponse({
    accessToken: refreshToken,
    refreshToken,
    expiresAt: new Date(credential.claims.expiresAt * 1000).toISOString(),
    workspaceId: credential.claims.workspaceId,
  });
}

async function contextResponse(request: Request, db: D1DatabaseLike, repository: D1RivetRepository) {
  const { credential, access } = await authenticateDevice(request, db, repository, ["capture:write"]);
  const workspace = await first<{
    name: string;
    capture_policy_json: string;
    click_target_color: string;
  }>(
    db,
    `SELECT w.name, s.capture_policy_json, s.click_target_color
     FROM workspaces w JOIN workspace_settings s ON s.workspace_id = w.id
     WHERE w.id = ?`,
    credential.claims.workspaceId,
  );
  const policy = safeJson<{ excludedHosts?: string[] }>(workspace?.capture_policy_json ?? "{}", {});
  return jsonResponse({
    workspaceId: credential.claims.workspaceId,
    workspaceName: workspace?.name ?? access.workspaceName,
    policyVersion: "privacy-v1",
    excludedOrigins: (policy.excludedHosts ?? []).map((host) => `https://${host}`),
    clickTargetColor: workspace?.click_target_color ?? "#ef6f47",
    privacy: {
      excludePasswordFields: true,
      captureClipboard: false,
      captureRawKeystrokes: false,
      captureIncognito: false,
      retainUnredactedScreenshots: false,
      automatic: ["email", "phone-number", "financial-number", "identifier", "form-field"],
      assisted: ["common-name", "long-text"],
    },
  });
}

async function startCapture(request: Request, db: D1DatabaseLike, repository: D1RivetRepository) {
  const { credential } = await authenticateDevice(request, db, repository, ["capture:write"]);
  const payload = await readJsonObject(request, 100_000);
  const sessionId = safeId(payload.sessionId, "Capture session");
  const title = text(payload.title ?? "Captured workflow", "Guide title", { min: 2, max: 500 });
  const stepCount = integer(payload.stepCount, "Step count", 0, 100);
  const policyVersion = text(payload.policyVersion ?? "privacy-v1", "Policy version", {
    min: 1,
    max: 100,
  });
  if (policyVersion !== "privacy-v1") {
    throw new HttpError(409, "CAPTURE_POLICY_STALE", "Refresh the workspace capture policy before recording.");
  }
  if (typeof payload.workspaceId === "string" && payload.workspaceId !== credential.claims.workspaceId) {
    throw new HttpError(403, "WORKSPACE_TOKEN_MISMATCH", "The capture belongs to another workspace.");
  }
  const excludedHosts = await excludedCaptureHosts(db, credential.claims.workspaceId);
  const startedUrl = sanitizedCaptureUrl(
    payload.sanitizedUrl ?? payload.origin,
    excludedHosts,
    "Capture URL",
  );
  const existing = await first<{
    capture_scope: string;
    status: "recording" | "paused" | "finished" | "discarded";
  }>(
    db,
    `SELECT capture_scope, status FROM capture_sessions
     WHERE id = ? AND workspace_id = ? AND user_id = ?`,
    sessionId,
    credential.claims.workspaceId,
    credential.claims.userId,
  );
  if (existing) {
    const scope = safeJson<{
      guideId: string;
      revisionId: string;
      expectedSteps: number;
    }>(existing.capture_scope, {
      guideId: "",
      revisionId: "",
      expectedSteps: 0,
    });
    return jsonResponse({
      captureId: sessionId,
      ...scope,
      status: existing.status,
      expectedSteps: Number(scope.expectedSteps ?? 0),
    });
  }
  const guideId = newId("guide");
  const revisionId = newId("revision");
  const workspaceId = credential.claims.workspaceId;
  const captureScope = JSON.stringify({
    guideId,
    revisionId,
    title,
    expectedSteps: stepCount,
    policyVersion,
    ...(startedUrl ? { startedUrl } : {}),
  });
  const deviceActorValue = await deviceActor(db, credential);
  await repository.executeAuditedMutation({
    workspaceId,
    actor: deviceActorValue,
    event: {
      action: "capture.started",
      targetType: "capture",
      targetId: sessionId,
      targetLabel: title,
      summary: `${title} private capture upload started`,
      metadata: { expectedSteps: stepCount },
    },
    statements: [
      statement(
        db,
        `INSERT INTO guides (id, workspace_id, title, slug, author_user_id,
          working_draft_revision_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        guideId,
        workspaceId,
        title,
        `${slug(title)}-${guideId.slice(-6)}`,
        credential.claims.userId,
        revisionId,
      ),
      statement(
        db,
        `INSERT INTO guide_revisions (id, guide_id, workspace_id, version, status,
          source_type, title, summary, tags_json, system_references_json,
          created_by, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'draft', 'capture', ?, '', '[]', '[]', ?,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        revisionId,
        guideId,
        workspaceId,
        title,
        credential.claims.userId,
      ),
      statement(
        db,
        `INSERT INTO guide_audiences
          (revision_id, subject_type, subject_id, granted_by, granted_at)
         VALUES (?, 'user', ?, ?, CURRENT_TIMESTAMP)`,
        revisionId,
        credential.claims.userId,
        credential.claims.userId,
      ),
      statement(
        db,
        `INSERT INTO capture_sessions (id, workspace_id, user_id, device_token_id,
          status, last_sequence, capture_scope, started_at, updated_at)
         VALUES (?, ?, ?, ?, 'recording', 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        sessionId,
        workspaceId,
        credential.claims.userId,
        credential.claims.jti,
        captureScope,
      ),
    ],
  });
  return jsonResponse({
    captureId: sessionId,
    guideId,
    revisionId,
    status: "recording",
    expectedSteps: stepCount,
  });
}

async function captureRecord(
  db: D1DatabaseLike,
  captureId: string,
  credential: ValidatedDeviceCredential,
) {
  const capture = await first<{
    status: "recording" | "paused" | "finished" | "discarded";
    capture_scope: string;
    started_at: string;
    paused_at: string | null;
  }>(
    db,
    `SELECT status, capture_scope, started_at, paused_at FROM capture_sessions
     WHERE id = ? AND workspace_id = ? AND user_id = ?`,
    captureId,
    credential.claims.workspaceId,
    credential.claims.userId,
  );
  if (!capture) throw new HttpError(404, "CAPTURE_NOT_FOUND", "Capture not found.");
  return {
    ...capture,
    scope: safeJson<{
      guideId: string;
      revisionId: string;
      title: string;
      expectedSteps: number;
      policyVersion: string;
      startedUrl?: string;
    }>(capture.capture_scope, {
      guideId: "",
      revisionId: "",
      title: "Captured guide",
      expectedSteps: 0,
      policyVersion: "privacy-v1",
    }),
  };
}

async function mediaIdFor(captureId: string, stepId: string) {
  return `media_${(await hashToken(`${captureId}:${stepId}`)).slice(0, 48)}`;
}

async function updateExpectedSteps(
  request: Request,
  db: D1DatabaseLike,
  repository: D1RivetRepository,
  captureId: string,
) {
  const { credential } = await authenticateDevice(request, db, repository, ["capture:write"]);
  const capture = await captureRecord(db, captureId, credential);
  if (capture.status !== "recording" && capture.status !== "paused") {
    throw new HttpError(409, "CAPTURE_TERMINAL", "This capture can no longer be changed.");
  }
  assertCaptureFresh(capture.started_at);
  const payload = await readJsonObject(request, 20_000);
  const expectedSteps = integer(payload.expectedSteps, "Expected step count", 0, 100);
  const mediaCount = Number(
    (
      await first<{ count: number }>(
        db,
        `SELECT COUNT(*) AS count FROM guide_media
         WHERE workspace_id = ? AND revision_id = ? AND capture_session_id = ?`,
        credential.claims.workspaceId,
        capture.scope.revisionId,
        captureId,
      )
    )?.count ?? 0,
  );
  if (mediaCount > 0 && expectedSteps !== capture.scope.expectedSteps) {
    throw new HttpError(
      409,
      "CAPTURE_SCOPE_LOCKED",
      "The expected step count cannot change after screenshot upload begins.",
    );
  }
  if (expectedSteps === capture.scope.expectedSteps) {
    return jsonResponse({ captureId, status: capture.status, expectedSteps });
  }
  const updatedScope = JSON.stringify({ ...capture.scope, expectedSteps });
  await repository.executeAuditedMutation({
    workspaceId: credential.claims.workspaceId,
    actor: await deviceActor(db, credential),
    event: {
      action: "capture.expected-steps-updated",
      targetType: "capture",
      targetId: captureId,
      targetLabel: capture.scope.title,
      summary: `${capture.scope.title} expected step count updated`,
      metadata: { previousExpectedSteps: capture.scope.expectedSteps, expectedSteps },
    },
    statements: [
      statement(
        db,
        `UPDATE capture_sessions SET capture_scope = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND workspace_id = ? AND user_id = ?`,
        updatedScope,
        captureId,
        credential.claims.workspaceId,
        credential.claims.userId,
      ),
    ],
  });
  return jsonResponse({ captureId, status: capture.status, expectedSteps });
}

async function transitionCapture(
  request: Request,
  db: D1DatabaseLike,
  repository: D1RivetRepository,
  captureId: string,
  transition: "pause" | "resume",
) {
  const { credential } = await authenticateDevice(request, db, repository, ["capture:write"]);
  const capture = await captureRecord(db, captureId, credential);
  const targetStatus = transition === "pause" ? "paused" : "recording";
  if (capture.status === targetStatus) {
    return jsonResponse({ captureId, status: targetStatus });
  }
  const requiredStatus = transition === "pause" ? "recording" : "paused";
  if (capture.status !== requiredStatus) {
    throw new HttpError(409, "CAPTURE_TRANSITION_INVALID", `This capture cannot ${transition}.`);
  }
  assertCaptureFresh(capture.started_at);
  await repository.executeAuditedMutation({
    workspaceId: credential.claims.workspaceId,
    actor: await deviceActor(db, credential),
    event: {
      action: `capture.${transition}d`,
      targetType: "capture",
      targetId: captureId,
      targetLabel: capture.scope.title,
      summary: `${capture.scope.title} capture ${transition}d`,
    },
    statements: [
      statement(
        db,
        `UPDATE capture_sessions SET status = ?,
           paused_at = CASE WHEN ? = 'paused' THEN CURRENT_TIMESTAMP ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND workspace_id = ? AND user_id = ?`,
        targetStatus,
        targetStatus,
        captureId,
        credential.claims.workspaceId,
        credential.claims.userId,
      ),
    ],
  });
  return jsonResponse({ captureId, status: targetStatus });
}

async function discardCapture(
  request: Request,
  db: D1DatabaseLike,
  repository: D1RivetRepository,
  captureId: string,
) {
  const { credential } = await authenticateDevice(request, db, repository, ["capture:write"]);
  let capture: Awaited<ReturnType<typeof captureRecord>>;
  try {
    capture = await captureRecord(db, captureId, credential);
  } catch (error) {
    if (error instanceof HttpError && error.code === "CAPTURE_NOT_FOUND") {
      return jsonResponse({ captureId, status: "discarded", deleted: true });
    }
    throw error;
  }
  if (capture.status === "discarded") {
    return jsonResponse({ captureId, status: "discarded", deleted: true });
  }
  if (capture.status === "finished") {
    throw new HttpError(409, "CAPTURE_TERMINAL", "A finished guide must be managed from its workspace.");
  }
  // Pause first to close the media-insert gate. An upload already in flight
  // either committed before this transition (and is listed below) or its DB
  // insert is rejected and its newly written R2 object is deleted by upload.
  if (capture.status === "recording") {
    await repository.executeAuditedMutation({
      workspaceId: credential.claims.workspaceId,
      actor: await deviceActor(db, credential),
      event: {
        action: "capture.discard-requested",
        targetType: "capture",
        targetId: captureId,
        targetLabel: capture.scope.title,
        summary: `${capture.scope.title} private capture discard requested`,
      },
      statements: [
        statement(
          db,
          `UPDATE capture_sessions SET status = 'paused', paused_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND workspace_id = ? AND user_id = ?`,
          captureId,
          credential.claims.workspaceId,
          credential.claims.userId,
        ),
      ],
    });
  }
  const media = await rows<{ object_key: string }>(
    db,
    `SELECT object_key FROM guide_media
     WHERE workspace_id = ? AND revision_id = ? AND capture_session_id = ?`,
    credential.claims.workspaceId,
    capture.scope.revisionId,
    captureId,
  );
  const bucket = requireR2Binding(env.MEDIA);
  for (const item of media) {
    await deletePrivateMedia(bucket, item.object_key, credential.claims.workspaceId);
  }
  await repository.executeAuditedMutation({
    workspaceId: credential.claims.workspaceId,
    actor: await deviceActor(db, credential),
    event: {
      action: "capture.discarded",
      targetType: "capture",
      targetId: captureId,
      targetLabel: capture.scope.title,
      summary: `${capture.scope.title} private capture discarded`,
      metadata: { deletedMediaCount: media.length },
    },
    statements: [
      statement(
        db,
        `DELETE FROM guide_media
         WHERE workspace_id = ? AND revision_id = ? AND capture_session_id = ?`,
        credential.claims.workspaceId,
        capture.scope.revisionId,
        captureId,
      ),
      statement(
        db,
        `DELETE FROM guides WHERE id = ? AND workspace_id = ?
           AND working_draft_revision_id = ? AND current_published_revision_id IS NULL`,
        capture.scope.guideId,
        credential.claims.workspaceId,
        capture.scope.revisionId,
      ),
      statement(
        db,
        `UPDATE capture_sessions SET status = 'discarded', finished_at = CURRENT_TIMESTAMP,
           paused_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND workspace_id = ? AND user_id = ?`,
        captureId,
        credential.claims.workspaceId,
        credential.claims.userId,
      ),
    ],
  });
  return jsonResponse({ captureId, status: "discarded", deleted: true });
}

async function uploadScreenshot(
  request: Request,
  db: D1DatabaseLike,
  repository: D1RivetRepository,
  captureId: string,
  stepId: string,
) {
  const { credential } = await authenticateDevice(request, db, repository, ["capture:write", "media:write"]);
  const capture = await captureRecord(db, captureId, credential);
  if (capture.status !== "recording") {
    throw new HttpError(409, "CAPTURE_NOT_RECORDING", "This capture no longer accepts screenshots.");
  }
  assertCaptureFresh(capture.started_at);
  if (
    request.headers.get("x-rivet-redacted") !== "true" ||
    request.headers.get("x-rivet-source-rasterized") !== "true"
  ) {
    throw new HttpError(400, "REDACTION_ATTESTATION_REQUIRED", "Only locally redacted, rasterized screenshots are accepted.");
  }
  const mediaId = await mediaIdFor(captureId, stepId);
  const existing = await first<{ id: string }>(
    db,
    `SELECT id FROM guide_media WHERE id = ? AND workspace_id = ?`,
    mediaId,
    credential.claims.workspaceId,
  );
  if (existing) return jsonResponse({ mediaId, redactionState: "redacted" });
  const uploadedCount = await first<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM guide_media
     WHERE workspace_id = ? AND revision_id = ? AND capture_session_id = ?`,
    credential.claims.workspaceId,
    capture.scope.revisionId,
    captureId,
  );
  if (Number(uploadedCount?.count ?? 0) >= capture.scope.expectedSteps) {
    throw new HttpError(409, "CAPTURE_MEDIA_LIMIT", "This capture already has all expected screenshots.");
  }
  const contentType = request.headers.get("content-type")?.split(";")[0];
  if (contentType !== "image/png" && contentType !== "image/jpeg") {
    throw new HttpError(415, "MEDIA_TYPE_INVALID", "The screenshot file type is not allowed.");
  }
  const bytes = await readBoundedBody(request, MAX_SCREENSHOT_BYTES);
  const width = integer(request.headers.get("x-rivet-image-width"), "Image width", 1, 16_384);
  const height = integer(request.headers.get("x-rivet-image-height"), "Image height", 1, 16_384);
  if (width * height > MAX_SCREENSHOT_PIXELS) {
    throw new HttpError(413, "MEDIA_DIMENSIONS_INVALID", "The redacted screenshot dimensions are too large.");
  }
  const bucket = requireR2Binding(env.MEDIA);
  const stored = await storeRedactedScreenshot(bucket, {
    workspaceId: credential.claims.workspaceId,
    revisionId: capture.scope.revisionId,
    captureId,
    uploadedBy: credential.claims.userId,
    contentType,
    bytes,
    width,
    height,
    redactionAttested: true,
    sourceRasterized: true,
  });
  try {
    await run(
      db,
      `INSERT INTO guide_media (id, workspace_id, revision_id, capture_session_id,
        object_key, content_type, byte_size, width, height, sha256,
        redaction_state, source_rasterized, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'redacted', 1, ?, CURRENT_TIMESTAMP)`,
      mediaId,
      credential.claims.workspaceId,
      capture.scope.revisionId,
      captureId,
      stored.objectKey,
      stored.contentType,
      stored.byteSize,
      stored.width,
      stored.height,
      stored.sha256,
      credential.claims.userId,
    );
  } catch (error) {
    await bucket.delete(stored.objectKey).catch(() => undefined);
    throw error;
  }
  return jsonResponse({ mediaId, redactionState: "redacted", sha256: stored.sha256 });
}

async function commitCapture(
  request: Request,
  db: D1DatabaseLike,
  repository: D1RivetRepository,
  captureId: string,
) {
  const { credential, access } = await authenticateDevice(request, db, repository, ["capture:write"]);
  const capture = await captureRecord(db, captureId, credential);
  if (capture.status === "finished") {
    return jsonResponse({
      guideId: capture.scope.guideId,
      editUrl: captureEditUrl(request, credential.claims.workspaceId, capture.scope.guideId),
    });
  }
  if (capture.status !== "recording") throw new HttpError(409, "CAPTURE_NOT_RECORDING", "This capture cannot be committed.");
  assertCaptureFresh(capture.started_at);
  const payload = await readJsonObject(request, 500_000);
  if (!Array.isArray(payload.steps) || payload.steps.length < 1 || payload.steps.length > 100) {
    throw new HttpError(400, "CAPTURE_STEPS_INVALID", "A capture needs between 1 and 100 steps.");
  }
  if (payload.steps.length !== capture.scope.expectedSteps) {
    throw new HttpError(409, "CAPTURE_STEP_COUNT_MISMATCH", "The reviewed step count does not match this capture.");
  }
  const privacy = payload.privacyReview && typeof payload.privacyReview === "object"
    ? (payload.privacyReview as Record<string, unknown>)
    : {};
  if (
    privacy.attestation !== "all-screenshots-reviewed" ||
    typeof privacy.completedAt !== "string" ||
    Number.isNaN(Date.parse(privacy.completedAt))
  ) {
    throw new HttpError(400, "PRIVACY_REVIEW_REQUIRED", "Complete the mandatory local privacy review first.");
  }
  const reviewedMilliseconds = Date.parse(privacy.completedAt);
  const startedMilliseconds = Date.parse(capture.started_at);
  if (
    reviewedMilliseconds < startedMilliseconds ||
    reviewedMilliseconds > Date.now() + 5 * 60_000
  ) {
    throw new HttpError(400, "PRIVACY_REVIEW_INVALID", "The privacy review timestamp is outside this capture.");
  }
  const automaticMaskCount = integer(
    privacy.automaticMaskCount ?? 0,
    "Automatic mask count",
    0,
    1_000_000,
  );
  const manualMaskCount = integer(
    privacy.manualMaskCount ?? 0,
    "Manual mask count",
    0,
    1_000_000,
  );
  const excludedHosts = await excludedCaptureHosts(db, credential.claims.workspaceId);
  const seen = new Set<string>();
  const steps = payload.steps.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new HttpError(400, "CAPTURE_STEPS_INVALID", `Step ${index + 1} is invalid.`);
    }
    const item = candidate as Record<string, unknown>;
    const sourceId = safeId(item.id, `Step ${index + 1} ID`);
    if (seen.has(sourceId)) throw new HttpError(400, "CAPTURE_STEPS_INVALID", "Step IDs must be unique.");
    seen.add(sourceId);
    return {
      sourceId,
      id: `step_${capture.scope.revisionId}_${index}`,
      title: text(item.title, `Step ${index + 1} title`, { min: 1, max: 500 }),
      instructions: text(item.instructions, `Step ${index + 1} instructions`, { min: 1, max: 50_000 }),
      sanitizedUrl: sanitizedCaptureUrl(
        item.sanitizedUrl,
        excludedHosts,
        `Step ${index + 1} URL`,
      ),
      automaticMaskCount: integer(item.automaticMaskCount ?? 0, "Automatic masks", 0, 10_000),
      manualMaskCount: integer(item.manualMaskCount ?? 0, "Manual masks", 0, 10_000),
    };
  });
  const mediaIds = await Promise.all(steps.map((step) => mediaIdFor(captureId, step.sourceId)));
  const uploaded = await rows<{ id: string; content_type: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number; sha256: string; created_at: string }>(
    db,
     `SELECT id, content_type, width, height, sha256, created_at FROM guide_media
      WHERE workspace_id = ? AND revision_id = ? AND capture_session_id = ?`,
    credential.claims.workspaceId,
    capture.scope.revisionId,
    captureId,
  );
  if (
    uploaded.length !== steps.length ||
    mediaIds.some((mediaId) => !uploaded.some((item) => item.id === mediaId))
  ) {
    throw new HttpError(409, "CAPTURE_MEDIA_INCOMPLETE", "Every reviewed step must have a redacted screenshot.");
  }
  const settings = await first<{
    logo_object_key: string | null;
    accent_color: string;
    click_target_color: string;
    remove_branding: number;
    restricted_exports_enabled: number;
    watermark_restricted_exports: number;
  }>(
    db,
    `SELECT logo_object_key, accent_color, click_target_color, remove_branding,
            restricted_exports_enabled, watermark_restricted_exports
     FROM workspace_settings WHERE workspace_id = ?`,
    credential.claims.workspaceId,
  );
  const member = await first<{ display_name: string | null; email: string }>(
    db,
    `SELECT display_name, email FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    credential.claims.workspaceId,
    credential.claims.userId,
  );
  const reviewedAt = new Date(reviewedMilliseconds).toISOString();
  const canonical: DraftGuideRevision = {
    schemaVersion: 1,
    guideId: capture.scope.guideId,
    revisionId: capture.scope.revisionId,
    workspaceId: credential.claims.workspaceId,
    revisionNumber: 1,
    source: "browser-capture",
    title: capture.scope.title,
    summary: `Captured browser workflow with ${steps.length} reviewed steps.`,
    createdAt: reviewedAt,
    createdBy: {
      userId: credential.claims.userId,
      displayName: member?.display_name ?? member?.email,
    },
    blocks: steps.map((step, index) => {
      const media = uploaded.find((item) => item.id === mediaIds[index])!;
      return {
        id: step.id,
        type: "action" as const,
        title: step.title,
        instructions: step.instructions,
        media:
          media.content_type === "image/webp"
            ? undefined
            : {
                mediaId: media.id,
                fileName: `${media.id}.${media.content_type === "image/png" ? "png" : "jpg"}`,
                mimeType: media.content_type,
                width: media.width,
                height: media.height,
                altText: `Locally redacted screenshot for ${step.title}`,
                sanitized: true as const,
                sanitizedAt: media.created_at,
                contentHash: media.sha256,
                annotations: [],
                redactions: [],
              },
      };
    }),
    audience: {
      mode: "restricted",
      workspaceId: credential.claims.workspaceId,
      targets: [{ type: "user", id: credential.claims.userId, label: member?.display_name ?? member?.email }],
    },
    privacyReview: {
      required: true,
      status: "approved",
      originalMediaRetained: false,
      reviewedAt,
      reviewedBy: {
        userId: credential.claims.userId,
        displayName: member?.display_name ?? member?.email,
      },
      findingsResolved: true,
      note: `${automaticMaskCount} automatic and ${manualMaskCount} manual masks reviewed locally.`,
    },
    branding: {
      workspaceId: credential.claims.workspaceId,
      workspaceName: access.workspaceName,
      ...(settings?.logo_object_key ? { logoMediaId: settings.logo_object_key } : {}),
      accentColor: settings?.accent_color ?? "#356fe5",
      clickTargetColor: settings?.click_target_color ?? "#ef6f47",
      showRivetBranding: settings?.remove_branding !== 1,
    },
    exportPolicy: {
      allowedFormats: ["live-link", "pdf", "html", "markdown"],
      restrictedGuideExports:
        settings?.restricted_exports_enabled === 1 ? "allowed" : "disabled",
      watermark: {
        mode: settings?.watermark_restricted_exports === 1 ? "required" : "optional",
        includeViewer: true,
        includeWorkspace: true,
        includeDate: true,
      },
    },
    lifecycle: "draft",
  };
  parseGuideRevision(canonical);
  const statements: D1PreparedStatementLike[] = [
    statement(
      db,
      `UPDATE guide_revisions SET summary = ?, privacy_reviewed_at = ?,
        privacy_reviewed_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND workspace_id = ? AND status = 'draft'`,
      canonical.summary,
      reviewedAt,
      credential.claims.userId,
      capture.scope.revisionId,
      credential.claims.workspaceId,
    ),
    statement(
      db,
      `UPDATE capture_sessions SET status = 'finished', last_sequence = ?,
        finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND workspace_id = ? AND status = 'recording'`,
      steps.length,
      captureId,
      credential.claims.workspaceId,
    ),
    statement(
      db,
      `INSERT INTO workspace_metrics_daily
        (workspace_id, metric_date, captures, updated_at)
       VALUES (?, date('now'), 1, CURRENT_TIMESTAMP)
       ON CONFLICT(workspace_id, metric_date) DO UPDATE SET
         captures = captures + 1, updated_at = CURRENT_TIMESTAMP`,
      credential.claims.workspaceId,
    ),
  ];
  const stepWritesJson = JSON.stringify(
    steps.map((step, index) => ({
      stepId: step.id,
      position: index,
      title: step.title,
      body: step.instructions,
      mediaId: mediaIds[index],
      annotationJson: JSON.stringify({
        screenshotMediaId: mediaIds[index],
        sanitizedUrl: step.sanitizedUrl,
        automaticMaskCount: step.automaticMaskCount,
        manualMaskCount: step.manualMaskCount,
      }),
    })),
  );
  statements.push(
    statement(
      db,
      `INSERT INTO guide_steps
         (id, revision_id, position, kind, title, body, annotation_json,
          created_at, updated_at)
       SELECT json_extract(value, '$.stepId'), ?, json_extract(value, '$.position'),
              'action', json_extract(value, '$.title'), json_extract(value, '$.body'),
              json_extract(value, '$.annotationJson'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       FROM json_each(?)`,
      capture.scope.revisionId,
      stepWritesJson,
    ),
    statement(
      db,
      `UPDATE guide_media
       SET step_id = (
         SELECT json_extract(value, '$.stepId') FROM json_each(?) writes
         WHERE json_extract(writes.value, '$.mediaId') = guide_media.id
       )
       WHERE workspace_id = ? AND revision_id = ? AND capture_session_id = ?
         AND id IN (
           SELECT json_extract(value, '$.mediaId') FROM json_each(?)
         )`,
      stepWritesJson,
      credential.claims.workspaceId,
      capture.scope.revisionId,
      captureId,
      stepWritesJson,
    ),
  );
  const actorValue = await deviceActor(db, credential);
  await repository.executeAuditedMutation({
    workspaceId: credential.claims.workspaceId,
    actor: actorValue,
    event: {
      action: "capture.finished",
      targetType: "guide",
      targetId: capture.scope.guideId,
      targetLabel: capture.scope.title,
      summary: `${capture.scope.title} saved as a privacy-reviewed private draft`,
      metadata: {
        revisionId: capture.scope.revisionId,
        stepCount: steps.length,
        automaticMaskCount,
        manualMaskCount,
        originalMediaRetained: false,
      },
    },
    statements,
  });
  return jsonResponse({
    guideId: capture.scope.guideId,
    revisionId: capture.scope.revisionId,
    editUrl: captureEditUrl(request, credential.claims.workspaceId, capture.scope.guideId),
  });
}

async function dispatch(request: Request, context: RouteContext) {
  const db = dbBinding();
  const repository = new D1RivetRepository(db);
  await repository.ensureSecurityGuards();
  const path = (await context.params).path ?? [];

  if (request.method === "POST" && path.length === 1 && path[0] === "pair") {
    return pair(request, db, repository);
  }
  if (
    request.method === "POST" &&
    path.length === 2 &&
    path[0] === "token" &&
    path[1] === "refresh"
  ) {
    return refresh(request, db, repository);
  }
  if (request.method === "GET" && path.length === 1 && path[0] === "context") {
    return contextResponse(request, db, repository);
  }
  if (request.method === "POST" && path.length === 1 && path[0] === "captures") {
    return startCapture(request, db, repository);
  }
  if (
    request.method === "PATCH" &&
    path.length === 2 &&
    path[0] === "captures"
  ) {
    return updateExpectedSteps(
      request,
      db,
      repository,
      safeId(path[1], "Capture ID"),
    );
  }
  if (
    request.method === "POST" &&
    path.length === 3 &&
    path[0] === "captures" &&
    (path[2] === "pause" || path[2] === "resume")
  ) {
    return transitionCapture(
      request,
      db,
      repository,
      safeId(path[1], "Capture ID"),
      path[2],
    );
  }
  if (
    request.method === "DELETE" &&
    path.length === 2 &&
    path[0] === "captures"
  ) {
    return discardCapture(
      request,
      db,
      repository,
      safeId(path[1], "Capture ID"),
    );
  }
  if (
    request.method === "PUT" &&
    path.length === 5 &&
    path[0] === "captures" &&
    path[2] === "steps" &&
    path[4] === "screenshot"
  ) {
    return uploadScreenshot(
      request,
      db,
      repository,
      safeId(path[1], "Capture ID"),
      safeId(path[3], "Step ID"),
    );
  }
  if (
    request.method === "POST" &&
    path.length === 3 &&
    path[0] === "captures" &&
    path[2] === "commit"
  ) {
    return commitCapture(
      request,
      db,
      repository,
      safeId(path[1], "Capture ID"),
    );
  }
  throw new HttpError(404, "EXTENSION_ROUTE_NOT_FOUND", "This extension endpoint is unavailable.");
}

async function handle(request: Request, context: RouteContext) {
  try {
    return await dispatch(request, context);
  } catch (error) {
    return toErrorResponse(error, crypto.randomUUID());
  }
}

export function GET(request: Request, context: RouteContext) {
  return handle(request, context);
}

export function POST(request: Request, context: RouteContext) {
  return handle(request, context);
}

export function PUT(request: Request, context: RouteContext) {
  return handle(request, context);
}

export function PATCH(request: Request, context: RouteContext) {
  return handle(request, context);
}

export function DELETE(request: Request, context: RouteContext) {
  return handle(request, context);
}
