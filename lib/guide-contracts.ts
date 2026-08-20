export const WORKSPACE_ROLES = [
  "administrator",
  "creator",
  "reviewer",
  "publisher",
  "viewer",
] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_CAPABILITIES = ["vault"] as const;

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

export type GuideLifecycleState =
  | "draft"
  | "review"
  | "published"
  | "archived";

export const GUIDE_SOURCES = [
  "manual",
  "browser-capture",
  "desktop-capture",
] as const;

export type GuideSource = (typeof GUIDE_SOURCES)[number];

export function isCapturedGuideSource(
  source: unknown,
): source is Extract<GuideSource, `${string}-capture`> {
  return source === "browser-capture" || source === "desktop-capture";
}

export interface GuideActor {
  readonly userId: string;
  readonly displayName?: string;
}

export interface WorkspaceAudience {
  readonly mode: "workspace";
  readonly workspaceId: string;
}

export interface RestrictedAudienceTarget {
  readonly type: "group" | "user";
  readonly id: string;
  readonly label?: string;
}

export interface RestrictedAudience {
  readonly mode: "restricted";
  readonly workspaceId: string;
  readonly targets: readonly RestrictedAudienceTarget[];
}

export type GuideAudience = WorkspaceAudience | RestrictedAudience;

export interface NormalizedRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export type RedactionCategory =
  | "email"
  | "phone-number"
  | "financial-number"
  | "identifier"
  | "all-numbers"
  | "common-name"
  | "long-text"
  | "form-field"
  | "table-row"
  | "image"
  | "manual-region"
  | "similar-element"
  | "other";

export interface GuideRedaction {
  readonly id: string;
  readonly category: RedactionCategory;
  readonly mode: "blur" | "solid";
  readonly region: NormalizedRectangle;
  readonly detection: "automatic" | "assisted" | "manual";
  /**
   * False while the redaction is still a reversible, on-image blur overlay
   * that the author can add/remove during editing. Becomes true forever the
   * moment the guide's first review is submitted, at which point the region
   * has been flattened into the stored pixels and can never be undone.
   */
  readonly applied: boolean;
}

export interface GuideAnnotation {
  readonly id: string;
  readonly type: "arrow" | "rectangle" | "highlight" | "text";
  readonly region: NormalizedRectangle;
  readonly color: string;
  readonly text?: string;
}

export interface GuideClickTarget {
  readonly point: NormalizedPoint;
  readonly color: string;
  readonly radius: number;
}

export interface GuideActionMedia {
  readonly mediaId: string;
  readonly fileName: string;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly altText: string;
  readonly sanitized: true;
  readonly sanitizedAt: string;
  readonly contentHash?: string;
  readonly crop?: NormalizedRectangle;
  readonly clickTarget?: GuideClickTarget;
  readonly annotations: readonly GuideAnnotation[];
  readonly redactions: readonly GuideRedaction[];
}

export interface GuideSystemReference {
  readonly name: string;
  readonly url?: string;
}

export interface GuideHeadingBlock {
  readonly id: string;
  readonly type: "heading";
  readonly level: 2 | 3;
  readonly text: string;
}

export interface GuideParagraphBlock {
  readonly id: string;
  readonly type: "paragraph";
  readonly text: string;
}

export interface GuideCalloutBlock {
  readonly id: string;
  readonly type: "callout";
  readonly tone: "note" | "warning" | "success";
  readonly title?: string;
  readonly text: string;
}

export interface GuideActionBlock {
  readonly id: string;
  readonly type: "action";
  readonly title: string;
  readonly instructions: string;
  readonly expectedResult?: string;
  readonly requiresConfirmation?: boolean;
  readonly systemReference?: GuideSystemReference;
  readonly media?: GuideActionMedia;
}

export type GuideBlock =
  | GuideHeadingBlock
  | GuideParagraphBlock
  | GuideCalloutBlock
  | GuideActionBlock;

export type PrivacyReviewStatus =
  | "not-required"
  | "pending"
  | "changes-requested"
  | "approved";

export interface PrivacyReview {
  readonly required: boolean;
  readonly status: PrivacyReviewStatus;
  readonly originalMediaRetained: false;
  readonly reviewedAt?: string;
  readonly reviewedBy?: GuideActor;
  readonly note?: string;
  readonly findingsResolved?: boolean;
}

export interface WorkspaceBranding {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly logoMediaId?: string;
  readonly accentColor: string;
  readonly clickTargetColor: string;
  readonly showKnowHowBranding: boolean;
}

export const GUIDE_EXPORT_FORMATS = [
  "live-link",
  "pdf",
  "html",
  "markdown",
  "pptx",
] as const;

export type GuideExportFormat = (typeof GUIDE_EXPORT_FORMATS)[number];

export interface GuideWatermarkPolicy {
  readonly mode: "none" | "optional" | "required";
  readonly includeViewer: boolean;
  readonly includeWorkspace: boolean;
  readonly includeDate: boolean;
}

export interface GuideExportPolicy {
  readonly allowedFormats: readonly GuideExportFormat[];
  readonly restrictedGuideExports: "allowed" | "disabled";
  readonly watermark: GuideWatermarkPolicy;
}

interface GuideRevisionBase {
  readonly schemaVersion: 1;
  readonly guideId: string;
  readonly revisionId: string;
  readonly workspaceId: string;
  readonly entityId?: string;
  readonly revisionNumber: number;
  readonly source: GuideSource;
  readonly title: string;
  readonly summary?: string;
  readonly createdAt: string;
  readonly createdBy: GuideActor;
  readonly blocks: readonly GuideBlock[];
  readonly audience: GuideAudience;
  readonly privacyReview: PrivacyReview;
  readonly branding: WorkspaceBranding;
  readonly exportPolicy: GuideExportPolicy;
}

export interface DraftGuideRevision extends GuideRevisionBase {
  readonly lifecycle: "draft";
}

export interface ReviewGuideRevision extends GuideRevisionBase {
  readonly lifecycle: "review";
  readonly submittedAt: string;
  readonly submittedBy: GuideActor;
}

export interface PublishedGuideRevision extends GuideRevisionBase {
  readonly lifecycle: "published";
  readonly submittedAt: string;
  readonly submittedBy: GuideActor;
  readonly reviewedAt: string;
  readonly reviewedBy: GuideActor;
  readonly publishedAt: string;
  readonly publishedBy: GuideActor;
}

export interface ArchivedGuideRevision extends GuideRevisionBase {
  readonly lifecycle: "archived";
  readonly archivedFrom: Exclude<GuideLifecycleState, "archived">;
  readonly archivedAt: string;
  readonly archivedBy: GuideActor;
  readonly submittedAt?: string;
  readonly submittedBy?: GuideActor;
  readonly reviewedAt?: string;
  readonly reviewedBy?: GuideActor;
  readonly publishedAt?: string;
  readonly publishedBy?: GuideActor;
}

export type GuideRevision =
  | DraftGuideRevision
  | ReviewGuideRevision
  | PublishedGuideRevision
  | ArchivedGuideRevision;

export interface CapturePrivacyPolicy {
  readonly excludePasswordFields: true;
  readonly captureRawKeystrokes: false;
  readonly captureClipboard: false;
  readonly captureIncognito: false;
  readonly retainUnredactedScreenshots: false;
  /**
   * Contract v2 declares whether a recorder may derive an exact value from
   * before/after accessibility state. It never permits raw key or clipboard
   * capture and password controls remain fail-closed.
   */
  readonly textInputCapture?: "none" | "exact-non-password";
  readonly autoRedactionCategories: readonly Exclude<
    RedactionCategory,
    "common-name" | "long-text"
  >[];
  readonly assistedRedactionCategories: readonly (
    | "common-name"
    | "long-text"
  )[];
}

export interface CaptureScope {
  readonly origin: string;
  readonly startedUrl: string;
  readonly excludedOrigins: readonly string[];
}

export interface DesktopCoordinateRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopCoordinatePoint {
  readonly x: number;
  readonly y: number;
}

interface DesktopCaptureScopeBase {
  readonly excludedWindowIds: readonly string[];
}

export interface DesktopApplicationScope extends DesktopCaptureScopeBase {
  readonly kind: "application";
  readonly applicationName: string;
  readonly processId: number;
}

export interface DesktopWindowScope extends DesktopCaptureScopeBase {
  readonly kind: "window";
  readonly windowId: string;
  readonly applicationName: string;
  readonly windowTitle?: string;
  readonly includeOwnedDialogs: true;
}

export interface DesktopMonitorScope extends DesktopCaptureScopeBase {
  readonly kind: "monitor";
  readonly monitorId: string;
  readonly monitorName?: string;
  readonly bounds: DesktopCoordinateRectangle;
}

export interface DesktopAllDisplaysScope extends DesktopCaptureScopeBase {
  readonly kind: "all-displays";
  readonly monitorIds: readonly string[];
}

export type DesktopCaptureScope =
  | DesktopApplicationScope
  | DesktopWindowScope
  | DesktopMonitorScope
  | DesktopAllDisplaysScope;

export interface CapturePauseInterval {
  readonly pausedAt: string;
  readonly resumedAt?: string;
}

export interface CaptureNavigationEvent {
  readonly id: string;
  readonly type: "navigation";
  readonly occurredAt: string;
  readonly sanitizedUrl: string;
  readonly title?: string;
}

export interface CaptureClickEvent {
  readonly id: string;
  readonly type: "click";
  readonly occurredAt: string;
  readonly targetLabel: string;
  readonly targetRole?: string;
  readonly media?: GuideActionMedia;
}

export interface CaptureFormInteractionEvent {
  readonly id: string;
  readonly type: "form-interaction";
  readonly occurredAt: string;
  readonly fieldLabel?: string;
  readonly fieldType: "text" | "email" | "number" | "search" | "select" | "textarea";
}

export type CaptureEvent =
  | CaptureNavigationEvent
  | CaptureClickEvent
  | CaptureFormInteractionEvent;

export type DesktopInteractionKind =
  | "left-click"
  | "right-click"
  | "double-click"
  | "drag"
  | "text-entry"
  | "enter"
  | "tab"
  | "shortcut"
  | "app-switch";

export interface DesktopInteractionTarget {
  readonly applicationName: string;
  readonly windowTitle?: string;
  readonly controlRole?: string;
  readonly controlLabel?: string;
  readonly bounds?: DesktopCoordinateRectangle;
  readonly passwordStatus: "not-password" | "password" | "unknown";
}

export interface DesktopCaptureInteraction {
  readonly id: string;
  readonly type: "desktop-interaction";
  readonly kind: DesktopInteractionKind;
  readonly occurredAt: string;
  readonly target: DesktopInteractionTarget;
  readonly displayId?: string;
  readonly windowId?: string;
  readonly point?: DesktopCoordinatePoint;
  readonly destination?: DesktopCoordinatePoint;
  readonly shortcut?: string;
  /** Present only for exact, non-password UIA value changes. */
  readonly text?: string;
  readonly instruction: string;
  readonly media?: GuideActionMedia;
}

export interface CaptureSessionV1 {
  readonly schemaVersion: 1;
  readonly captureId: string;
  readonly workspaceId: string;
  readonly entityId?: string;
  readonly state: "recording" | "paused" | "finished" | "discarded";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly discardedAt?: string;
  readonly scope: CaptureScope;
  readonly privacyPolicy: CapturePrivacyPolicy;
  readonly pauses: readonly CapturePauseInterval[];
  readonly events: readonly CaptureEvent[];
  readonly draftBlocks: readonly GuideBlock[];
}

export interface CaptureSessionV2 {
  readonly schemaVersion: 2;
  readonly source: "desktop-capture";
  readonly captureId: string;
  readonly workspaceId: string;
  readonly entityId?: string;
  readonly state: "recording" | "paused" | "finished" | "discarded";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly discardedAt?: string;
  readonly scope: DesktopCaptureScope;
  readonly privacyPolicy: CapturePrivacyPolicy & {
    readonly textInputCapture: "none" | "exact-non-password";
  };
  readonly pauses: readonly CapturePauseInterval[];
  readonly events: readonly DesktopCaptureInteraction[];
  readonly draftBlocks: readonly GuideBlock[];
}

export type CaptureSession = CaptureSessionV1 | CaptureSessionV2;

export interface GuideExportViewer {
  readonly userId: string;
  readonly displayName?: string;
}

export interface GuideExportRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly workspaceId: string;
  readonly guideId: string;
  readonly revisionId: string;
  readonly format: GuideExportFormat;
  readonly requestedAt: string;
  readonly requestedBy: GuideActor;
  readonly viewer?: GuideExportViewer;
}

export interface GuideExportReceipt {
  readonly schemaVersion: 1;
  readonly exportId: string;
  readonly requestId: string;
  readonly workspaceId: string;
  readonly guideId: string;
  readonly revisionId: string;
  readonly format: GuideExportFormat;
  readonly status: "completed" | "failed";
  readonly occurredAt: string;
  readonly byteLength?: number;
  readonly failureCode?: string;
}

export const GUIDE_AUDIT_ACTIONS = [
  "guide.created",
  "guide.updated",
  "guide.submitted",
  "guide.review-approved",
  "guide.review-changes-requested",
  "guide.published",
  "guide.archived",
  "guide.restored",
  "guide.viewed",
  "guide.audience-changed",
  "guide.exported",
  "guide.export-failed",
  "capture.started",
  "capture.paused",
  "capture.resumed",
  "capture.finished",
  "capture.discarded",
  "privacy-review.approved",
  "privacy-review.changes-requested",
  "invitation.created",
  "invitation.revoked",
  "invitation.accepted",
  "membership.changed",
  "group.created",
  "group.updated",
  "group.membership-changed",
  "workspace.permission-changed",
] as const;

export type GuideAuditAction = (typeof GUIDE_AUDIT_ACTIONS)[number];

export type AuditMetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly AuditMetadataValue[]
  | { readonly [key: string]: AuditMetadataValue };

export interface GuideAuditEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly workspaceId: string;
  readonly occurredAt: string;
  readonly actor: GuideActor;
  readonly action: GuideAuditAction;
  readonly guideId?: string;
  readonly revisionId?: string;
  readonly targetId?: string;
  readonly summary: string;
  readonly metadata?: Readonly<Record<string, AuditMetadataValue>>;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly issues: readonly ValidationIssue[] };

export class GuideContractError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "GuideContractError";
    this.issues = issues;
  }
}

type UnknownRecord = Record<string, unknown>;

const ID_MAX = 256;
const SHORT_TEXT_MAX = 500;
const LONG_TEXT_MAX = 50_000;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SHA_256 = /^[0-9a-f]{64}$/i;
const SENSITIVE_KEY =
  /(?:secret|vault|password|passphrase|credential|authorization|cookie|clipboard|raw.?key|raw.?screenshot|unredacted|api.?key|access.?token|refresh.?token)/i;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  issues: ValidationIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}

function exactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issue(issues, `${path}.${key}`, "Unknown field.");
    }
  }
}

function text(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  options: { optional?: boolean; max?: number; nonEmpty?: boolean } = {},
): value is string | undefined {
  if (value === undefined && options.optional) return true;
  if (typeof value !== "string") {
    issue(issues, path, "Expected a string.");
    return false;
  }
  if ((options.nonEmpty ?? true) && !value.trim()) {
    issue(issues, path, "Expected a non-empty string.");
  }
  if (value.length > (options.max ?? SHORT_TEXT_MAX)) {
    issue(issues, path, `Must not exceed ${options.max ?? SHORT_TEXT_MAX} characters.`);
  }
  return true;
}

function identifier(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  optional = false,
): value is string | undefined {
  return text(value, path, issues, {
    optional,
    max: ID_MAX,
    nonEmpty: true,
  });
}

function isoDate(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  optional = false,
): value is string | undefined {
  if (!text(value, path, issues, { optional, max: 64 })) return false;
  if (value === undefined) return true;
  if (Number.isNaN(Date.parse(value))) {
    issue(issues, path, "Expected an ISO date or date-time string.");
    return false;
  }
  return true;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function chronological(
  entries: readonly { readonly path: string; readonly value: unknown }[],
  issues: ValidationIssue[],
): void {
  let previous: { path: string; value: number } | undefined;
  for (const entry of entries) {
    const current = timestamp(entry.value);
    if (current === undefined) continue;
    if (previous && current < previous.value) {
      issue(
        issues,
        entry.path,
        `Must not be earlier than ${previous.path}.`,
      );
    }
    previous = { path: entry.path, value: current };
  }
}

function enumeration<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
  issues: ValidationIssue[],
): value is T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    issue(issues, path, `Expected one of: ${values.join(", ")}.`);
    return false;
  }
  return true;
}

function finiteNumber(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  options: { min?: number; max?: number; integer?: boolean } = {},
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issue(issues, path, "Expected a finite number.");
    return false;
  }
  if (options.integer && !Number.isSafeInteger(value)) {
    issue(issues, path, "Expected an integer.");
  }
  if (options.min !== undefined && value < options.min) {
    issue(issues, path, `Must be at least ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) {
    issue(issues, path, `Must be at most ${options.max}.`);
  }
  return true;
}

function actor(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  optional = false,
): value is GuideActor | undefined {
  if (value === undefined && optional) return true;
  if (!isRecord(value)) {
    issue(issues, path, "Expected an actor object.");
    return false;
  }
  exactKeys(value, ["userId", "displayName"], path, issues);
  identifier(value.userId, `${path}.userId`, issues);
  text(value.displayName, `${path}.displayName`, issues, {
    optional: true,
    max: SHORT_TEXT_MAX,
  });
  return true;
}

function rectangle(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is NormalizedRectangle {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a normalized rectangle.");
    return false;
  }
  exactKeys(value, ["x", "y", "width", "height"], path, issues);
  finiteNumber(value.x, `${path}.x`, issues, { min: 0, max: 1 });
  finiteNumber(value.y, `${path}.y`, issues, { min: 0, max: 1 });
  finiteNumber(value.width, `${path}.width`, issues, { min: 0.000001, max: 1 });
  finiteNumber(value.height, `${path}.height`, issues, { min: 0.000001, max: 1 });
  if (
    typeof value.x === "number" &&
    typeof value.width === "number" &&
    value.x + value.width > 1.000001
  ) {
    issue(issues, path, "Rectangle exceeds the horizontal image boundary.");
  }
  if (
    typeof value.y === "number" &&
    typeof value.height === "number" &&
    value.y + value.height > 1.000001
  ) {
    issue(issues, path, "Rectangle exceeds the vertical image boundary.");
  }
  return true;
}

function point(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is NormalizedPoint {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a normalized point.");
    return false;
  }
  exactKeys(value, ["x", "y"], path, issues);
  finiteNumber(value.x, `${path}.x`, issues, { min: 0, max: 1 });
  finiteNumber(value.y, `${path}.y`, issues, { min: 0, max: 1 });
  return true;
}

function color(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is string {
  if (!text(value, path, issues, { max: 7 })) return false;
  if (typeof value === "string" && !HEX_COLOR.test(value)) {
    issue(issues, path, "Expected a six-digit hexadecimal color.");
    return false;
  }
  return true;
}

function annotation(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is GuideAnnotation {
  if (!isRecord(value)) {
    issue(issues, path, "Expected an annotation object.");
    return false;
  }
  exactKeys(value, ["id", "type", "region", "color", "text"], path, issues);
  identifier(value.id, `${path}.id`, issues);
  enumeration(
    value.type,
    ["arrow", "rectangle", "highlight", "text"] as const,
    `${path}.type`,
    issues,
  );
  rectangle(value.region, `${path}.region`, issues);
  color(value.color, `${path}.color`, issues);
  text(value.text, `${path}.text`, issues, {
    optional: true,
    max: 2_000,
  });
  if (value.type === "text" && !value.text) {
    issue(issues, `${path}.text`, "Text annotations require text.");
  }
  return true;
}

function redaction(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is GuideRedaction {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a redaction object.");
    return false;
  }
  exactKeys(
    value,
    ["id", "category", "mode", "region", "detection", "applied"],
    path,
    issues,
  );
  identifier(value.id, `${path}.id`, issues);
  enumeration(
    value.category,
    [
      "email",
      "phone-number",
      "financial-number",
      "identifier",
      "all-numbers",
      "common-name",
      "long-text",
      "form-field",
      "table-row",
      "image",
      "manual-region",
      "similar-element",
      "other",
    ] as const,
    `${path}.category`,
    issues,
  );
  enumeration(value.mode, ["blur", "solid"] as const, `${path}.mode`, issues);
  rectangle(value.region, `${path}.region`, issues);
  enumeration(
    value.detection,
    ["automatic", "assisted", "manual"] as const,
    `${path}.detection`,
    issues,
  );
  if (typeof value.applied !== "boolean") {
    issue(issues, `${path}.applied`, "Expected a boolean.");
  }
  if (
    (value.category === "common-name" || value.category === "long-text") &&
    value.detection !== "assisted"
  ) {
    issue(
      issues,
      `${path}.detection`,
      "Common-name and long-text detection must remain assisted.",
    );
  }
  return true;
}

function media(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  optional = false,
): value is GuideActionMedia | undefined {
  if (value === undefined && optional) return true;
  if (!isRecord(value)) {
    issue(issues, path, "Expected a sanitized media object.");
    return false;
  }
  exactKeys(
    value,
    [
      "mediaId",
      "fileName",
      "mimeType",
      "width",
      "height",
      "altText",
      "sanitized",
      "sanitizedAt",
      "contentHash",
      "crop",
      "clickTarget",
      "annotations",
      "redactions",
    ],
    path,
    issues,
  );
  identifier(value.mediaId, `${path}.mediaId`, issues);
  text(value.fileName, `${path}.fileName`, issues, { max: SHORT_TEXT_MAX });
  enumeration(
    value.mimeType,
    ["image/png", "image/jpeg"] as const,
    `${path}.mimeType`,
    issues,
  );
  finiteNumber(value.width, `${path}.width`, issues, { min: 1, integer: true });
  finiteNumber(value.height, `${path}.height`, issues, { min: 1, integer: true });
  text(value.altText, `${path}.altText`, issues, { max: 2_000 });
  if (value.sanitized !== true) {
    issue(issues, `${path}.sanitized`, "Only sanitized media may enter a guide revision.");
  }
  isoDate(value.sanitizedAt, `${path}.sanitizedAt`, issues);
  if (value.contentHash !== undefined) {
    if (typeof value.contentHash !== "string" || !SHA_256.test(value.contentHash)) {
      issue(issues, `${path}.contentHash`, "Expected a SHA-256 hexadecimal digest.");
    }
  }
  if (value.crop !== undefined) rectangle(value.crop, `${path}.crop`, issues);
  if (value.clickTarget !== undefined) {
    if (!isRecord(value.clickTarget)) {
      issue(issues, `${path}.clickTarget`, "Expected a click target object.");
    } else {
      exactKeys(value.clickTarget, ["point", "color", "radius"], `${path}.clickTarget`, issues);
      point(value.clickTarget.point, `${path}.clickTarget.point`, issues);
      color(value.clickTarget.color, `${path}.clickTarget.color`, issues);
      finiteNumber(value.clickTarget.radius, `${path}.clickTarget.radius`, issues, {
        min: 0.001,
        max: 0.25,
      });
    }
  }
  if (!Array.isArray(value.annotations)) {
    issue(issues, `${path}.annotations`, "Expected an annotation array.");
  } else {
    value.annotations.forEach((item, index) =>
      annotation(item, `${path}.annotations[${index}]`, issues),
    );
  }
  if (!Array.isArray(value.redactions)) {
    issue(issues, `${path}.redactions`, "Expected a redaction array.");
  } else {
    value.redactions.forEach((item, index) =>
      redaction(item, `${path}.redactions[${index}]`, issues),
    );
  }
  return true;
}

function systemReference(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is GuideSystemReference {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a system reference object.");
    return false;
  }
  exactKeys(value, ["name", "url"], path, issues);
  text(value.name, `${path}.name`, issues, { max: SHORT_TEXT_MAX });
  text(value.url, `${path}.url`, issues, { optional: true, max: 2_000 });
  return true;
}

function guideBlock(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is GuideBlock {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a guide block object.");
    return false;
  }
  identifier(value.id, `${path}.id`, issues);
  if (value.type === "heading") {
    exactKeys(value, ["id", "type", "level", "text"], path, issues);
    if (value.level !== 2 && value.level !== 3) {
      issue(issues, `${path}.level`, "Heading level must be 2 or 3.");
    }
    text(value.text, `${path}.text`, issues, { max: 5_000 });
  } else if (value.type === "paragraph") {
    exactKeys(value, ["id", "type", "text"], path, issues);
    text(value.text, `${path}.text`, issues, { max: LONG_TEXT_MAX });
  } else if (value.type === "callout") {
    exactKeys(value, ["id", "type", "tone", "title", "text"], path, issues);
    enumeration(
      value.tone,
      ["note", "warning", "success"] as const,
      `${path}.tone`,
      issues,
    );
    text(value.title, `${path}.title`, issues, {
      optional: true,
      max: SHORT_TEXT_MAX,
    });
    text(value.text, `${path}.text`, issues, { max: LONG_TEXT_MAX });
  } else if (value.type === "action") {
    exactKeys(
      value,
      [
        "id",
        "type",
        "title",
        "instructions",
        "expectedResult",
        "requiresConfirmation",
        "systemReference",
        "media",
      ],
      path,
      issues,
    );
    text(value.title, `${path}.title`, issues, { max: 5_000 });
    text(value.instructions, `${path}.instructions`, issues, { max: LONG_TEXT_MAX });
    text(value.expectedResult, `${path}.expectedResult`, issues, {
      optional: true,
      max: LONG_TEXT_MAX,
    });
    if (
      value.requiresConfirmation !== undefined &&
      typeof value.requiresConfirmation !== "boolean"
    ) {
      issue(issues, `${path}.requiresConfirmation`, "Expected a boolean.");
    }
    if (value.systemReference !== undefined) {
      systemReference(value.systemReference, `${path}.systemReference`, issues);
    }
    media(value.media, `${path}.media`, issues, true);
  } else {
    issue(issues, `${path}.type`, "Unknown guide block type.");
  }
  return true;
}

function audience(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is GuideAudience {
  if (!isRecord(value)) {
    issue(issues, path, "Expected an audience object.");
    return false;
  }
  identifier(value.workspaceId, `${path}.workspaceId`, issues);
  if (value.mode === "workspace") {
    exactKeys(value, ["mode", "workspaceId"], path, issues);
  } else if (value.mode === "restricted") {
    exactKeys(value, ["mode", "workspaceId", "targets"], path, issues);
    if (!Array.isArray(value.targets) || value.targets.length === 0) {
      issue(issues, `${path}.targets`, "Restricted audiences require at least one target.");
    } else {
      const unique = new Set<string>();
      value.targets.forEach((target, index) => {
        const targetPath = `${path}.targets[${index}]`;
        if (!isRecord(target)) {
          issue(issues, targetPath, "Expected an audience target.");
          return;
        }
        exactKeys(target, ["type", "id", "label"], targetPath, issues);
        enumeration(target.type, ["group", "user"] as const, `${targetPath}.type`, issues);
        identifier(target.id, `${targetPath}.id`, issues);
        text(target.label, `${targetPath}.label`, issues, {
          optional: true,
          max: SHORT_TEXT_MAX,
        });
        if (typeof target.type === "string" && typeof target.id === "string") {
          const key = `${target.type}:${target.id}`;
          if (unique.has(key)) issue(issues, targetPath, "Duplicate audience target.");
          unique.add(key);
        }
      });
    }
  } else {
    issue(issues, `${path}.mode`, "Audience mode must be workspace or restricted.");
  }
  return true;
}

function privacyReview(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is PrivacyReview {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a privacy review object.");
    return false;
  }
  exactKeys(
    value,
    [
      "required",
      "status",
      "originalMediaRetained",
      "reviewedAt",
      "reviewedBy",
      "note",
      "findingsResolved",
    ],
    path,
    issues,
  );
  if (typeof value.required !== "boolean") {
    issue(issues, `${path}.required`, "Expected a boolean.");
  }
  enumeration(
    value.status,
    ["not-required", "pending", "changes-requested", "approved"] as const,
    `${path}.status`,
    issues,
  );
  if (value.originalMediaRetained !== false) {
    issue(
      issues,
      `${path}.originalMediaRetained`,
      "Unredacted original media must not be retained.",
    );
  }
  isoDate(value.reviewedAt, `${path}.reviewedAt`, issues, true);
  actor(value.reviewedBy, `${path}.reviewedBy`, issues, true);
  text(value.note, `${path}.note`, issues, { optional: true, max: 5_000 });
  if (
    value.findingsResolved !== undefined &&
    typeof value.findingsResolved !== "boolean"
  ) {
    issue(issues, `${path}.findingsResolved`, "Expected a boolean.");
  }
  if (value.required === false && value.status !== "not-required") {
    issue(issues, `${path}.status`, "A non-required review must use not-required status.");
  }
  if (value.required === true && value.status === "not-required") {
    issue(issues, `${path}.status`, "A required review cannot be marked not-required.");
  }
  if (value.status === "approved") {
    if (!value.reviewedAt) issue(issues, `${path}.reviewedAt`, "Approval requires a review time.");
    if (!value.reviewedBy) issue(issues, `${path}.reviewedBy`, "Approval requires a reviewer.");
    if (value.findingsResolved !== true) {
      issue(issues, `${path}.findingsResolved`, "Approval requires all findings to be resolved.");
    }
  }
  return true;
}

function branding(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is WorkspaceBranding {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a branding object.");
    return false;
  }
  exactKeys(
    value,
    [
      "workspaceId",
      "workspaceName",
      "logoMediaId",
      "accentColor",
      "clickTargetColor",
      "showKnowHowBranding",
    ],
    path,
    issues,
  );
  identifier(value.workspaceId, `${path}.workspaceId`, issues);
  text(value.workspaceName, `${path}.workspaceName`, issues, { max: SHORT_TEXT_MAX });
  identifier(value.logoMediaId, `${path}.logoMediaId`, issues, true);
  color(value.accentColor, `${path}.accentColor`, issues);
  color(value.clickTargetColor, `${path}.clickTargetColor`, issues);
  if (typeof value.showKnowHowBranding !== "boolean") {
    issue(issues, `${path}.showKnowHowBranding`, "Expected a boolean.");
  }
  return true;
}

function watermarkPolicy(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is GuideWatermarkPolicy {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a watermark policy object.");
    return false;
  }
  exactKeys(
    value,
    ["mode", "includeViewer", "includeWorkspace", "includeDate"],
    path,
    issues,
  );
  enumeration(value.mode, ["none", "optional", "required"] as const, `${path}.mode`, issues);
  for (const key of ["includeViewer", "includeWorkspace", "includeDate"] as const) {
    if (typeof value[key] !== "boolean") issue(issues, `${path}.${key}`, "Expected a boolean.");
  }
  if (
    value.mode === "none" &&
    (value.includeViewer || value.includeWorkspace || value.includeDate)
  ) {
    issue(issues, path, "A disabled watermark cannot request watermark fields.");
  }
  if (
    value.mode === "required" &&
    !value.includeViewer &&
    !value.includeWorkspace &&
    !value.includeDate
  ) {
    issue(issues, path, "A required watermark must include at least one field.");
  }
  return true;
}

function exportPolicy(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is GuideExportPolicy {
  if (!isRecord(value)) {
    issue(issues, path, "Expected an export policy object.");
    return false;
  }
  exactKeys(value, ["allowedFormats", "restrictedGuideExports", "watermark"], path, issues);
  if (!Array.isArray(value.allowedFormats) || value.allowedFormats.length === 0) {
    issue(issues, `${path}.allowedFormats`, "At least one export format is required.");
  } else {
    const unique = new Set<string>();
    value.allowedFormats.forEach((format, index) => {
      enumeration(format, GUIDE_EXPORT_FORMATS, `${path}.allowedFormats[${index}]`, issues);
      if (typeof format === "string") {
        if (unique.has(format)) issue(issues, `${path}.allowedFormats[${index}]`, "Duplicate format.");
        unique.add(format);
      }
    });
  }
  enumeration(
    value.restrictedGuideExports,
    ["allowed", "disabled"] as const,
    `${path}.restrictedGuideExports`,
    issues,
  );
  watermarkPolicy(value.watermark, `${path}.watermark`, issues);
  return true;
}

const REVISION_BASE_KEYS = [
  "schemaVersion",
  "guideId",
  "revisionId",
  "workspaceId",
  "entityId",
  "revisionNumber",
  "source",
  "lifecycle",
  "title",
  "summary",
  "createdAt",
  "createdBy",
  "blocks",
  "audience",
  "privacyReview",
  "branding",
  "exportPolicy",
] as const;

function revision(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is GuideRevision {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a guide revision object.");
    return false;
  }

  const lifecycle = value.lifecycle;
  if (lifecycle === "draft") {
    exactKeys(value, REVISION_BASE_KEYS, path, issues);
  } else if (lifecycle === "review") {
    exactKeys(value, [...REVISION_BASE_KEYS, "submittedAt", "submittedBy"], path, issues);
  } else if (lifecycle === "published") {
    exactKeys(
      value,
      [
        ...REVISION_BASE_KEYS,
        "submittedAt",
        "submittedBy",
        "reviewedAt",
        "reviewedBy",
        "publishedAt",
        "publishedBy",
      ],
      path,
      issues,
    );
  } else if (lifecycle === "archived") {
    exactKeys(
      value,
      [
        ...REVISION_BASE_KEYS,
        "archivedFrom",
        "archivedAt",
        "archivedBy",
        "submittedAt",
        "submittedBy",
        "reviewedAt",
        "reviewedBy",
        "publishedAt",
        "publishedBy",
      ],
      path,
      issues,
    );
  } else {
    issue(issues, `${path}.lifecycle`, "Unknown guide lifecycle state.");
  }

  if (value.schemaVersion !== 1) issue(issues, `${path}.schemaVersion`, "Schema version must be 1.");
  identifier(value.guideId, `${path}.guideId`, issues);
  identifier(value.revisionId, `${path}.revisionId`, issues);
  identifier(value.workspaceId, `${path}.workspaceId`, issues);
  identifier(value.entityId, `${path}.entityId`, issues, true);
  finiteNumber(value.revisionNumber, `${path}.revisionNumber`, issues, {
    min: 1,
    integer: true,
  });
  enumeration(value.source, GUIDE_SOURCES, `${path}.source`, issues);
  text(value.title, `${path}.title`, issues, { max: SHORT_TEXT_MAX });
  text(value.summary, `${path}.summary`, issues, { optional: true, max: LONG_TEXT_MAX });
  isoDate(value.createdAt, `${path}.createdAt`, issues);
  actor(value.createdBy, `${path}.createdBy`, issues);

  if (!Array.isArray(value.blocks) || value.blocks.length === 0) {
    issue(issues, `${path}.blocks`, "A guide revision requires at least one block.");
  } else {
    const ids = new Set<string>();
    value.blocks.forEach((block, index) => {
      guideBlock(block, `${path}.blocks[${index}]`, issues);
      if (isRecord(block) && typeof block.id === "string") {
        if (ids.has(block.id)) issue(issues, `${path}.blocks[${index}].id`, "Duplicate block ID.");
        ids.add(block.id);
      }
    });
  }

  audience(value.audience, `${path}.audience`, issues);
  privacyReview(value.privacyReview, `${path}.privacyReview`, issues);
  branding(value.branding, `${path}.branding`, issues);
  exportPolicy(value.exportPolicy, `${path}.exportPolicy`, issues);

  if (isRecord(value.audience) && value.audience.workspaceId !== value.workspaceId) {
    issue(issues, `${path}.audience.workspaceId`, "Audience workspace must match the revision.");
  }
  if (isRecord(value.branding) && value.branding.workspaceId !== value.workspaceId) {
    issue(issues, `${path}.branding.workspaceId`, "Branding workspace must match the revision.");
  }

  if (lifecycle === "review" || lifecycle === "published") {
    isoDate(value.submittedAt, `${path}.submittedAt`, issues);
    actor(value.submittedBy, `${path}.submittedBy`, issues);
  }
  if (lifecycle === "published") {
    isoDate(value.reviewedAt, `${path}.reviewedAt`, issues);
    actor(value.reviewedBy, `${path}.reviewedBy`, issues);
    isoDate(value.publishedAt, `${path}.publishedAt`, issues);
    actor(value.publishedBy, `${path}.publishedBy`, issues);
    if (
      isCapturedGuideSource(value.source) &&
      (!isRecord(value.privacyReview) ||
        value.privacyReview.required !== true ||
        value.privacyReview.status !== "approved")
    ) {
      issue(
        issues,
        `${path}.privacyReview`,
        "Captured revisions require an approved privacy review before publication.",
      );
    }
    chronological(
      [
        { path: `${path}.createdAt`, value: value.createdAt },
        { path: `${path}.submittedAt`, value: value.submittedAt },
        { path: `${path}.reviewedAt`, value: value.reviewedAt },
        { path: `${path}.publishedAt`, value: value.publishedAt },
      ],
      issues,
    );
    const publishedAt = timestamp(value.publishedAt);
    if (publishedAt !== undefined && isRecord(value.privacyReview)) {
      const privacyReviewedAt = timestamp(value.privacyReview.reviewedAt);
      if (privacyReviewedAt !== undefined && privacyReviewedAt > publishedAt) {
        issue(
          issues,
          `${path}.privacyReview.reviewedAt`,
          "Privacy review must be completed before publication.",
        );
      }
    }
    if (publishedAt !== undefined && Array.isArray(value.blocks)) {
      value.blocks.forEach((block, index) => {
        if (!isRecord(block) || block.type !== "action" || !isRecord(block.media)) {
          return;
        }
        const sanitizedAt = timestamp(block.media.sanitizedAt);
        if (sanitizedAt !== undefined && sanitizedAt > publishedAt) {
          issue(
            issues,
            `${path}.blocks[${index}].media.sanitizedAt`,
            "Media must be sanitized before publication.",
          );
        }
        if (Array.isArray(block.media.redactions)) {
          block.media.redactions.forEach((entry, redactionIndex) => {
            if (isRecord(entry) && entry.applied !== true) {
              issue(
                issues,
                `${path}.blocks[${index}].media.redactions[${redactionIndex}].applied`,
                "Published redactions must already be flattened into the image.",
              );
            }
          });
        }
      });
    }
  }
  if (lifecycle === "archived") {
    enumeration(
      value.archivedFrom,
      ["draft", "review", "published"] as const,
      `${path}.archivedFrom`,
      issues,
    );
    isoDate(value.archivedAt, `${path}.archivedAt`, issues);
    actor(value.archivedBy, `${path}.archivedBy`, issues);
    isoDate(value.submittedAt, `${path}.submittedAt`, issues, true);
    actor(value.submittedBy, `${path}.submittedBy`, issues, true);
    isoDate(value.reviewedAt, `${path}.reviewedAt`, issues, true);
    actor(value.reviewedBy, `${path}.reviewedBy`, issues, true);
    isoDate(value.publishedAt, `${path}.publishedAt`, issues, true);
    actor(value.publishedBy, `${path}.publishedBy`, issues, true);
    if (value.archivedFrom === "published" && (!value.publishedAt || !value.publishedBy)) {
      issue(issues, path, "A published archived revision must retain publication metadata.");
    }
    chronological(
      [
        { path: `${path}.createdAt`, value: value.createdAt },
        { path: `${path}.submittedAt`, value: value.submittedAt },
        { path: `${path}.reviewedAt`, value: value.reviewedAt },
        { path: `${path}.publishedAt`, value: value.publishedAt },
        { path: `${path}.archivedAt`, value: value.archivedAt },
      ],
      issues,
    );
  }

  if (lifecycle === "review") {
    chronological(
      [
        { path: `${path}.createdAt`, value: value.createdAt },
        { path: `${path}.submittedAt`, value: value.submittedAt },
      ],
      issues,
    );
  }

  return true;
}

function privacyPolicy(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is CapturePrivacyPolicy {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a capture privacy policy.");
    return false;
  }
  exactKeys(
    value,
    [
      "excludePasswordFields",
      "captureRawKeystrokes",
      "captureClipboard",
      "captureIncognito",
      "retainUnredactedScreenshots",
      "textInputCapture",
      "autoRedactionCategories",
      "assistedRedactionCategories",
    ],
    path,
    issues,
  );
  if (value.excludePasswordFields !== true) issue(issues, `${path}.excludePasswordFields`, "Password fields must be excluded.");
  if (value.captureRawKeystrokes !== false) issue(issues, `${path}.captureRawKeystrokes`, "Raw keystrokes must never be captured.");
  if (value.captureClipboard !== false) issue(issues, `${path}.captureClipboard`, "Clipboard contents must never be captured.");
  if (value.captureIncognito !== false) issue(issues, `${path}.captureIncognito`, "Incognito capture must remain disabled.");
  if (value.retainUnredactedScreenshots !== false) issue(issues, `${path}.retainUnredactedScreenshots`, "Unredacted screenshots must not be retained.");
  if (value.textInputCapture !== undefined) {
    enumeration(
      value.textInputCapture,
      ["none", "exact-non-password"] as const,
      `${path}.textInputCapture`,
      issues,
    );
  }
  if (!Array.isArray(value.autoRedactionCategories)) {
    issue(issues, `${path}.autoRedactionCategories`, "Expected a redaction category array.");
  } else {
    value.autoRedactionCategories.forEach((category, index) =>
      enumeration(
        category,
        [
          "email",
          "phone-number",
          "financial-number",
          "identifier",
          "all-numbers",
          "form-field",
          "table-row",
          "image",
          "manual-region",
          "similar-element",
          "other",
        ] as const,
        `${path}.autoRedactionCategories[${index}]`,
        issues,
      ),
    );
  }
  if (!Array.isArray(value.assistedRedactionCategories)) {
    issue(
      issues,
      `${path}.assistedRedactionCategories`,
      "Expected an assisted redaction category array.",
    );
  } else {
    value.assistedRedactionCategories.forEach((category, index) =>
      enumeration(
        category,
        ["common-name", "long-text"] as const,
        `${path}.assistedRedactionCategories[${index}]`,
        issues,
      ),
    );
  }
  return true;
}

function captureEvent(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is CaptureEvent {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a capture event.");
    return false;
  }
  identifier(value.id, `${path}.id`, issues);
  isoDate(value.occurredAt, `${path}.occurredAt`, issues);
  if (value.type === "navigation") {
    exactKeys(value, ["id", "type", "occurredAt", "sanitizedUrl", "title"], path, issues);
    text(value.sanitizedUrl, `${path}.sanitizedUrl`, issues, { max: 4_000 });
    text(value.title, `${path}.title`, issues, { optional: true, max: 2_000 });
  } else if (value.type === "click") {
    exactKeys(value, ["id", "type", "occurredAt", "targetLabel", "targetRole", "media"], path, issues);
    text(value.targetLabel, `${path}.targetLabel`, issues, { max: 2_000 });
    text(value.targetRole, `${path}.targetRole`, issues, { optional: true, max: 200 });
    media(value.media, `${path}.media`, issues, true);
  } else if (value.type === "form-interaction") {
    exactKeys(value, ["id", "type", "occurredAt", "fieldLabel", "fieldType"], path, issues);
    text(value.fieldLabel, `${path}.fieldLabel`, issues, { optional: true, max: 2_000 });
    enumeration(
      value.fieldType,
      ["text", "email", "number", "search", "select", "textarea"] as const,
      `${path}.fieldType`,
      issues,
    );
  } else {
    issue(issues, `${path}.type`, "Unknown capture event type.");
  }
  return true;
}

function captureSessionV1(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is CaptureSessionV1 {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a capture session object.");
    return false;
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "captureId",
      "workspaceId",
      "entityId",
      "state",
      "startedAt",
      "finishedAt",
      "discardedAt",
      "scope",
      "privacyPolicy",
      "pauses",
      "events",
      "draftBlocks",
    ],
    path,
    issues,
  );
  if (value.schemaVersion !== 1) issue(issues, `${path}.schemaVersion`, "Schema version must be 1.");
  identifier(value.captureId, `${path}.captureId`, issues);
  identifier(value.workspaceId, `${path}.workspaceId`, issues);
  identifier(value.entityId, `${path}.entityId`, issues, true);
  enumeration(
    value.state,
    ["recording", "paused", "finished", "discarded"] as const,
    `${path}.state`,
    issues,
  );
  isoDate(value.startedAt, `${path}.startedAt`, issues);
  isoDate(value.finishedAt, `${path}.finishedAt`, issues, true);
  isoDate(value.discardedAt, `${path}.discardedAt`, issues, true);
  if (!isRecord(value.scope)) {
    issue(issues, `${path}.scope`, "Expected a capture scope.");
  } else {
    exactKeys(value.scope, ["origin", "startedUrl", "excludedOrigins"], `${path}.scope`, issues);
    text(value.scope.origin, `${path}.scope.origin`, issues, { max: 2_000 });
    text(value.scope.startedUrl, `${path}.scope.startedUrl`, issues, { max: 4_000 });
    if (!Array.isArray(value.scope.excludedOrigins)) {
      issue(issues, `${path}.scope.excludedOrigins`, "Expected an origin array.");
    } else {
      value.scope.excludedOrigins.forEach((origin, index) =>
        text(origin, `${path}.scope.excludedOrigins[${index}]`, issues, { max: 2_000 }),
      );
    }
  }
  privacyPolicy(value.privacyPolicy, `${path}.privacyPolicy`, issues);
  if (!Array.isArray(value.pauses)) {
    issue(issues, `${path}.pauses`, "Expected a pause interval array.");
  } else {
    value.pauses.forEach((pause, index) => {
      const pausePath = `${path}.pauses[${index}]`;
      if (!isRecord(pause)) {
        issue(issues, pausePath, "Expected a pause interval.");
        return;
      }
      exactKeys(pause, ["pausedAt", "resumedAt"], pausePath, issues);
      isoDate(pause.pausedAt, `${pausePath}.pausedAt`, issues);
      isoDate(pause.resumedAt, `${pausePath}.resumedAt`, issues, true);
    });
    const openPauses = value.pauses.filter(
      (pause) => isRecord(pause) && pause.resumedAt === undefined,
    );
    if (openPauses.length > 1) issue(issues, `${path}.pauses`, "Only one pause may be open.");
    if (value.state === "paused" && openPauses.length !== 1) {
      issue(issues, `${path}.pauses`, "A paused capture requires one open pause interval.");
    }
    if (value.state !== "paused" && openPauses.length !== 0) {
      issue(issues, `${path}.pauses`, "Only a paused capture may have an open pause interval.");
    }
  }
  if (!Array.isArray(value.events)) {
    issue(issues, `${path}.events`, "Expected a capture event array.");
  } else {
    const eventIds = new Set<string>();
    value.events.forEach((event, index) =>
      {
        captureEvent(event, `${path}.events[${index}]`, issues);
        if (isRecord(event) && typeof event.id === "string") {
          if (eventIds.has(event.id)) {
            issue(issues, `${path}.events[${index}].id`, "Duplicate capture event ID.");
          }
          eventIds.add(event.id);
        }
      },
    );
  }
  if (!Array.isArray(value.draftBlocks)) {
    issue(issues, `${path}.draftBlocks`, "Expected a guide block array.");
  } else {
    value.draftBlocks.forEach((block, index) =>
      guideBlock(block, `${path}.draftBlocks[${index}]`, issues),
    );
  }
  if (value.state === "finished" && !value.finishedAt) {
    issue(issues, `${path}.finishedAt`, "Finished captures require a finish time.");
  }
  if (value.state !== "finished" && value.finishedAt !== undefined) {
    issue(issues, `${path}.finishedAt`, "Only finished captures may have a finish time.");
  }
  if (value.state === "discarded" && !value.discardedAt) {
    issue(issues, `${path}.discardedAt`, "Discarded captures require a discard time.");
  }
  if (value.state !== "discarded" && value.discardedAt !== undefined) {
    issue(issues, `${path}.discardedAt`, "Only discarded captures may have a discard time.");
  }

  const startTime = timestamp(value.startedAt);
  const endTime =
    value.state === "finished"
      ? timestamp(value.finishedAt)
      : value.state === "discarded"
        ? timestamp(value.discardedAt)
        : undefined;
  const pauseRanges = Array.isArray(value.pauses)
    ? value.pauses
        .map((pause, index) => {
          if (!isRecord(pause)) return undefined;
          const start = timestamp(pause.pausedAt);
          const end = timestamp(pause.resumedAt);
          if (start !== undefined && end !== undefined && end < start) {
            issue(
              issues,
              `${path}.pauses[${index}].resumedAt`,
              "A capture cannot resume before it was paused.",
            );
          }
          if (startTime !== undefined && start !== undefined && start < startTime) {
            issue(
              issues,
              `${path}.pauses[${index}].pausedAt`,
              "A pause cannot begin before the capture.",
            );
          }
          if (endTime !== undefined && start !== undefined && start > endTime) {
            issue(
              issues,
              `${path}.pauses[${index}].pausedAt`,
              "A pause cannot begin after the capture ended.",
            );
          }
          return start === undefined ? undefined : { start, end, index };
        })
        .filter(
          (range): range is { start: number; end: number | undefined; index: number } =>
            range !== undefined,
        )
    : [];
  for (let index = 1; index < pauseRanges.length; index += 1) {
    const previous = pauseRanges[index - 1];
    const current = pauseRanges[index];
    if (current.start < previous.start) {
      issue(
        issues,
        `${path}.pauses[${current.index}].pausedAt`,
        "Pause intervals must be chronological.",
      );
    }
    if (previous.end === undefined || current.start < previous.end) {
      issue(
        issues,
        `${path}.pauses[${current.index}]`,
        "Pause intervals must not overlap.",
      );
    }
  }

  if (Array.isArray(value.events)) {
    let previousEventTime: number | undefined;
    value.events.forEach((event, index) => {
      if (!isRecord(event)) return;
      const occurredAt = timestamp(event.occurredAt);
      if (occurredAt === undefined) return;
      if (startTime !== undefined && occurredAt < startTime) {
        issue(
          issues,
          `${path}.events[${index}].occurredAt`,
          "A capture event cannot occur before capture starts.",
        );
      }
      if (endTime !== undefined && occurredAt > endTime) {
        issue(
          issues,
          `${path}.events[${index}].occurredAt`,
          "A capture event cannot occur after capture ends.",
        );
      }
      if (previousEventTime !== undefined && occurredAt < previousEventTime) {
        issue(
          issues,
          `${path}.events[${index}].occurredAt`,
          "Capture events must be chronological.",
        );
      }
      previousEventTime = occurredAt;
      const paused = pauseRanges.some(
        (range) =>
          occurredAt >= range.start &&
          (range.end === undefined || occurredAt < range.end),
      );
      if (paused) {
        issue(
          issues,
          `${path}.events[${index}].occurredAt`,
          "Paused capture intervals must contain no events.",
        );
      }
    });
  }
  if (
    value.state === "discarded" &&
    ((Array.isArray(value.events) && value.events.length > 0) ||
      (Array.isArray(value.draftBlocks) && value.draftBlocks.length > 0))
  ) {
    issue(
      issues,
      path,
      "Discarded captures must purge captured events and draft blocks.",
    );
  }
  return true;
}

function desktopRectangle(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is DesktopCoordinateRectangle {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a desktop rectangle.");
    return false;
  }
  exactKeys(value, ["x", "y", "width", "height"], path, issues);
  finiteNumber(value.x, `${path}.x`, issues);
  finiteNumber(value.y, `${path}.y`, issues);
  finiteNumber(value.width, `${path}.width`, issues, { min: 1 });
  finiteNumber(value.height, `${path}.height`, issues, { min: 1 });
  return true;
}

function desktopPoint(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is DesktopCoordinatePoint {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a desktop point.");
    return false;
  }
  exactKeys(value, ["x", "y"], path, issues);
  finiteNumber(value.x, `${path}.x`, issues);
  finiteNumber(value.y, `${path}.y`, issues);
  return true;
}

function desktopIdArray(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  options: { nonEmpty?: boolean } = {},
) {
  if (!Array.isArray(value)) {
    issue(issues, path, "Expected an identifier array.");
    return;
  }
  if (options.nonEmpty && value.length === 0) {
    issue(issues, path, "At least one identifier is required.");
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    identifier(entry, `${path}[${index}]`, issues);
    if (typeof entry === "string") {
      if (seen.has(entry)) issue(issues, `${path}[${index}]`, "Duplicate identifier.");
      seen.add(entry);
    }
  });
}

function desktopScope(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is DesktopCaptureScope {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a desktop capture scope.");
    return false;
  }
  if (value.kind === "application") {
    exactKeys(
      value,
      ["kind", "applicationName", "processId", "excludedWindowIds"],
      path,
      issues,
    );
    text(value.applicationName, `${path}.applicationName`, issues, { max: 500 });
    finiteNumber(value.processId, `${path}.processId`, issues, {
      min: 1,
      integer: true,
    });
  } else if (value.kind === "window") {
    exactKeys(
      value,
      [
        "kind",
        "windowId",
        "applicationName",
        "windowTitle",
        "includeOwnedDialogs",
        "excludedWindowIds",
      ],
      path,
      issues,
    );
    identifier(value.windowId, `${path}.windowId`, issues);
    text(value.applicationName, `${path}.applicationName`, issues, { max: 500 });
    text(value.windowTitle, `${path}.windowTitle`, issues, {
      optional: true,
      max: 2_000,
    });
    if (value.includeOwnedDialogs !== true) {
      issue(
        issues,
        `${path}.includeOwnedDialogs`,
        "Window capture must include owned dialogs.",
      );
    }
  } else if (value.kind === "monitor") {
    exactKeys(
      value,
      ["kind", "monitorId", "monitorName", "bounds", "excludedWindowIds"],
      path,
      issues,
    );
    identifier(value.monitorId, `${path}.monitorId`, issues);
    text(value.monitorName, `${path}.monitorName`, issues, {
      optional: true,
      max: 500,
    });
    desktopRectangle(value.bounds, `${path}.bounds`, issues);
  } else if (value.kind === "all-displays") {
    exactKeys(
      value,
      ["kind", "monitorIds", "excludedWindowIds"],
      path,
      issues,
    );
    desktopIdArray(value.monitorIds, `${path}.monitorIds`, issues, {
      nonEmpty: true,
    });
  } else {
    issue(
      issues,
      `${path}.kind`,
      "Expected one of: application, window, monitor, all-displays.",
    );
  }
  desktopIdArray(value.excludedWindowIds, `${path}.excludedWindowIds`, issues);
  return true;
}

function desktopInteraction(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is DesktopCaptureInteraction {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a desktop interaction.");
    return false;
  }
  exactKeys(
    value,
    [
      "id",
      "type",
      "kind",
      "occurredAt",
      "target",
      "displayId",
      "windowId",
      "point",
      "destination",
      "shortcut",
      "text",
      "instruction",
      "media",
    ],
    path,
    issues,
  );
  identifier(value.id, `${path}.id`, issues);
  if (value.type !== "desktop-interaction") {
    issue(issues, `${path}.type`, "Desktop events must use desktop-interaction.");
  }
  enumeration(
    value.kind,
    [
      "left-click",
      "right-click",
      "double-click",
      "drag",
      "text-entry",
      "enter",
      "tab",
      "shortcut",
      "app-switch",
    ] as const,
    `${path}.kind`,
    issues,
  );
  isoDate(value.occurredAt, `${path}.occurredAt`, issues);
  text(value.displayId, `${path}.displayId`, issues, { optional: true, max: ID_MAX });
  text(value.windowId, `${path}.windowId`, issues, { optional: true, max: ID_MAX });
  if (value.point !== undefined) desktopPoint(value.point, `${path}.point`, issues);
  if (value.destination !== undefined) {
    desktopPoint(value.destination, `${path}.destination`, issues);
  }
  text(value.shortcut, `${path}.shortcut`, issues, { optional: true, max: 200 });
  text(value.text, `${path}.text`, issues, {
    optional: true,
    max: LONG_TEXT_MAX,
    nonEmpty: false,
  });
  text(value.instruction, `${path}.instruction`, issues, { max: 2_000 });
  media(value.media, `${path}.media`, issues, true);
  if (!isRecord(value.target)) {
    issue(issues, `${path}.target`, "Expected desktop UI metadata.");
  } else {
    exactKeys(
      value.target,
      [
        "applicationName",
        "windowTitle",
        "controlRole",
        "controlLabel",
        "bounds",
        "passwordStatus",
      ],
      `${path}.target`,
      issues,
    );
    text(value.target.applicationName, `${path}.target.applicationName`, issues, {
      max: 500,
    });
    text(value.target.windowTitle, `${path}.target.windowTitle`, issues, {
      optional: true,
      max: 2_000,
    });
    text(value.target.controlRole, `${path}.target.controlRole`, issues, {
      optional: true,
      max: 200,
    });
    text(value.target.controlLabel, `${path}.target.controlLabel`, issues, {
      optional: true,
      max: 2_000,
    });
    if (value.target.bounds !== undefined) {
      desktopRectangle(value.target.bounds, `${path}.target.bounds`, issues);
    }
    enumeration(
      value.target.passwordStatus,
      ["not-password", "password", "unknown"] as const,
      `${path}.target.passwordStatus`,
      issues,
    );
    if (
      value.text !== undefined &&
      value.target.passwordStatus !== "not-password"
    ) {
      issue(
        issues,
        `${path}.text`,
        "Exact text is forbidden when password status is password or unknown.",
      );
    }
  }
  if (value.text !== undefined && value.kind !== "text-entry") {
    issue(issues, `${path}.text`, "Only a text-entry event may include text.");
  }
  if (value.kind === "shortcut" && value.shortcut === undefined) {
    issue(issues, `${path}.shortcut`, "Shortcut events require a named shortcut.");
  }
  if (value.kind === "drag" && value.destination === undefined) {
    issue(issues, `${path}.destination`, "Drag events require a destination.");
  }
  return true;
}

function captureSessionV2(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is CaptureSessionV2 {
  if (!isRecord(value)) {
    issue(issues, path, "Expected a capture session object.");
    return false;
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "source",
      "captureId",
      "workspaceId",
      "entityId",
      "state",
      "startedAt",
      "finishedAt",
      "discardedAt",
      "scope",
      "privacyPolicy",
      "pauses",
      "events",
      "draftBlocks",
    ],
    path,
    issues,
  );
  if (value.schemaVersion !== 2) {
    issue(issues, `${path}.schemaVersion`, "Schema version must be 2.");
  }
  if (value.source !== "desktop-capture") {
    issue(issues, `${path}.source`, "Contract v2 is for desktop capture.");
  }
  desktopScope(value.scope, `${path}.scope`, issues);
  privacyPolicy(value.privacyPolicy, `${path}.privacyPolicy`, issues);
  const textInputCapture = isRecord(value.privacyPolicy)
    ? value.privacyPolicy.textInputCapture
    : undefined;
  enumeration(
    textInputCapture,
    ["none", "exact-non-password"] as const,
    `${path}.privacyPolicy.textInputCapture`,
    issues,
  );
  if (Array.isArray(value.events)) {
    value.events.forEach((event, index) => {
      desktopInteraction(event, `${path}.events[${index}]`, issues);
      if (
        textInputCapture === "none" &&
        isRecord(event) &&
        event.text !== undefined
      ) {
        issue(
          issues,
          `${path}.events[${index}].text`,
          "Text is disabled by this capture privacy policy.",
        );
      }
    });
  }

  // Reuse the mature v1 lifecycle validator for time ordering, pauses,
  // terminal-state rules, duplicate event IDs, and draft block validation.
  const lifecycleCandidate = {
    schemaVersion: 1,
    captureId: value.captureId,
    workspaceId: value.workspaceId,
    ...(value.entityId === undefined ? {} : { entityId: value.entityId }),
    state: value.state,
    startedAt: value.startedAt,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    ...(value.discardedAt === undefined
      ? {}
      : { discardedAt: value.discardedAt }),
    scope: {
      origin: "https://desktop.capture.invalid",
      startedUrl: "https://desktop.capture.invalid/",
      excludedOrigins: [],
    },
    privacyPolicy: value.privacyPolicy,
    pauses: value.pauses,
    events: Array.isArray(value.events)
      ? value.events.map((event) =>
          isRecord(event)
            ? {
                id: event.id,
                type: "click",
                occurredAt: event.occurredAt,
                targetLabel:
                  isRecord(event.target) &&
                  typeof event.target.applicationName === "string"
                    ? event.target.applicationName
                    : "Desktop action",
              }
            : event,
        )
      : value.events,
    draftBlocks: value.draftBlocks,
  };
  captureSessionV1(lifecycleCandidate, path, issues);
  return true;
}

function captureSession(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is CaptureSession {
  if (isRecord(value) && value.schemaVersion === 2) {
    return captureSessionV2(value, path, issues);
  }
  return captureSessionV1(value, path, issues);
}

function exportRequest(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is GuideExportRequest {
  if (!isRecord(value)) {
    issue(issues, path, "Expected an export request object.");
    return false;
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "requestId",
      "workspaceId",
      "guideId",
      "revisionId",
      "format",
      "requestedAt",
      "requestedBy",
      "viewer",
    ],
    path,
    issues,
  );
  if (value.schemaVersion !== 1) issue(issues, `${path}.schemaVersion`, "Schema version must be 1.");
  identifier(value.requestId, `${path}.requestId`, issues);
  identifier(value.workspaceId, `${path}.workspaceId`, issues);
  identifier(value.guideId, `${path}.guideId`, issues);
  identifier(value.revisionId, `${path}.revisionId`, issues);
  enumeration(value.format, GUIDE_EXPORT_FORMATS, `${path}.format`, issues);
  isoDate(value.requestedAt, `${path}.requestedAt`, issues);
  actor(value.requestedBy, `${path}.requestedBy`, issues);
  if (value.viewer !== undefined) actor(value.viewer, `${path}.viewer`, issues);
  return true;
}

function exportReceipt(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is GuideExportReceipt {
  if (!isRecord(value)) {
    issue(issues, path, "Expected an export receipt object.");
    return false;
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "exportId",
      "requestId",
      "workspaceId",
      "guideId",
      "revisionId",
      "format",
      "status",
      "occurredAt",
      "byteLength",
      "failureCode",
    ],
    path,
    issues,
  );
  if (value.schemaVersion !== 1) issue(issues, `${path}.schemaVersion`, "Schema version must be 1.");
  identifier(value.exportId, `${path}.exportId`, issues);
  identifier(value.requestId, `${path}.requestId`, issues);
  identifier(value.workspaceId, `${path}.workspaceId`, issues);
  identifier(value.guideId, `${path}.guideId`, issues);
  identifier(value.revisionId, `${path}.revisionId`, issues);
  enumeration(value.format, GUIDE_EXPORT_FORMATS, `${path}.format`, issues);
  enumeration(value.status, ["completed", "failed"] as const, `${path}.status`, issues);
  isoDate(value.occurredAt, `${path}.occurredAt`, issues);
  if (value.byteLength !== undefined) {
    finiteNumber(value.byteLength, `${path}.byteLength`, issues, {
      min: 0,
      integer: true,
    });
  }
  text(value.failureCode, `${path}.failureCode`, issues, {
    optional: true,
    max: 200,
  });
  if (value.status === "completed" && value.byteLength === undefined) {
    issue(issues, `${path}.byteLength`, "Completed exports require a byte length.");
  }
  if (value.status === "completed" && value.failureCode !== undefined) {
    issue(issues, `${path}.failureCode`, "Completed exports cannot have a failure code.");
  }
  if (value.status === "failed" && !value.failureCode) {
    issue(issues, `${path}.failureCode`, "Failed exports require a failure code.");
  }
  return true;
}

function auditMetadata(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is AuditMetadataValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issue(issues, path, "Audit numbers must be finite.");
    return true;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => auditMetadata(item, `${path}[${index}]`, issues));
    return true;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        issue(issues, `${path}.${key}`, "Sensitive fields are forbidden in audit metadata.");
      }
      auditMetadata(item, `${path}.${key}`, issues);
    }
    return true;
  }
  issue(issues, path, "Unsupported audit metadata value.");
  return false;
}

function auditEvent(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is GuideAuditEvent {
  if (!isRecord(value)) {
    issue(issues, path, "Expected an audit event object.");
    return false;
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "eventId",
      "workspaceId",
      "occurredAt",
      "actor",
      "action",
      "guideId",
      "revisionId",
      "targetId",
      "summary",
      "metadata",
    ],
    path,
    issues,
  );
  if (value.schemaVersion !== 1) issue(issues, `${path}.schemaVersion`, "Schema version must be 1.");
  identifier(value.eventId, `${path}.eventId`, issues);
  identifier(value.workspaceId, `${path}.workspaceId`, issues);
  isoDate(value.occurredAt, `${path}.occurredAt`, issues);
  actor(value.actor, `${path}.actor`, issues);
  enumeration(value.action, GUIDE_AUDIT_ACTIONS, `${path}.action`, issues);
  identifier(value.guideId, `${path}.guideId`, issues, true);
  identifier(value.revisionId, `${path}.revisionId`, issues, true);
  identifier(value.targetId, `${path}.targetId`, issues, true);
  text(value.summary, `${path}.summary`, issues, { max: 2_000 });
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) {
      issue(issues, `${path}.metadata`, "Expected an audit metadata object.");
    } else {
      auditMetadata(value.metadata, `${path}.metadata`, issues);
    }
  }
  return true;
}

function validationResult<T>(
  value: unknown,
  validator: (value: unknown, path: string, issues: ValidationIssue[]) => boolean,
): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  validator(value, "$", issues);
  return issues.length
    ? { success: false, issues }
    : { success: true, value: value as T };
}

function parseResult<T>(name: string, result: ValidationResult<T>): T {
  if (!result.success) {
    throw new GuideContractError(`${name} is invalid.`, result.issues);
  }
  return deepFreeze(result.value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as UnknownRecord)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function validateWorkspaceRole(value: unknown): ValidationResult<WorkspaceRole> {
  return validationResult(value, (candidate, path, issues) =>
    enumeration(candidate, WORKSPACE_ROLES, path, issues),
  );
}

export function validateGuideAudience(value: unknown): ValidationResult<GuideAudience> {
  return validationResult(value, audience);
}

export function validateGuideBlock(value: unknown): ValidationResult<GuideBlock> {
  return validationResult(value, guideBlock);
}

export function validateGuideActionMedia(
  value: unknown,
): ValidationResult<GuideActionMedia> {
  return validationResult(value, (candidate, path, issues) =>
    media(candidate, path, issues),
  );
}

export function validateGuideRedaction(
  value: unknown,
): ValidationResult<GuideRedaction> {
  return validationResult(value, redaction);
}

export function validatePrivacyReview(value: unknown): ValidationResult<PrivacyReview> {
  return validationResult(value, privacyReview);
}

export function validateWorkspaceBranding(value: unknown): ValidationResult<WorkspaceBranding> {
  return validationResult(value, branding);
}

export function validateGuideExportPolicy(value: unknown): ValidationResult<GuideExportPolicy> {
  return validationResult(value, exportPolicy);
}

export function validateGuideRevision(value: unknown): ValidationResult<GuideRevision> {
  return validationResult(value, revision);
}

export function validatePublishedGuideRevision(
  value: unknown,
): ValidationResult<PublishedGuideRevision> {
  const result = validateGuideRevision(value);
  if (!result.success) return result;
  if (result.value.lifecycle !== "published") {
    return {
      success: false,
      issues: [{ path: "$.lifecycle", message: "Only a published revision is exportable." }],
    };
  }
  return { success: true, value: result.value };
}

export function validateCaptureSession(value: unknown): ValidationResult<CaptureSession> {
  return validationResult(value, captureSession);
}

export function validateDesktopCaptureSession(
  value: unknown,
): ValidationResult<CaptureSessionV2> {
  return validationResult(value, captureSessionV2);
}

export function validateDesktopCaptureScope(
  value: unknown,
): ValidationResult<DesktopCaptureScope> {
  return validationResult(value, desktopScope);
}

export function validateDesktopCaptureInteraction(
  value: unknown,
): ValidationResult<DesktopCaptureInteraction> {
  return validationResult(value, desktopInteraction);
}

export function validateCapturePrivacyPolicy(
  value: unknown,
): ValidationResult<CapturePrivacyPolicy> {
  return validationResult(value, privacyPolicy);
}

export function validateCaptureEvent(value: unknown): ValidationResult<CaptureEvent> {
  return validationResult(value, captureEvent);
}

export function validateGuideExportRequest(
  value: unknown,
): ValidationResult<GuideExportRequest> {
  return validationResult(value, exportRequest);
}

export function validateGuideExportReceipt(
  value: unknown,
): ValidationResult<GuideExportReceipt> {
  return validationResult(value, exportReceipt);
}

export function validateGuideAuditEvent(value: unknown): ValidationResult<GuideAuditEvent> {
  return validationResult(value, auditEvent);
}

export function isGuideRevision(value: unknown): value is GuideRevision {
  return validateGuideRevision(value).success;
}

export function isPublishedGuideRevision(value: unknown): value is PublishedGuideRevision {
  return validatePublishedGuideRevision(value).success;
}

export function isCaptureSession(value: unknown): value is CaptureSession {
  return validateCaptureSession(value).success;
}

export function parseGuideRevision(value: unknown): GuideRevision {
  return parseResult("Guide revision", validateGuideRevision(value));
}

export function parsePublishedGuideRevision(value: unknown): PublishedGuideRevision {
  return parseResult("Published guide revision", validatePublishedGuideRevision(value));
}

export function parseCaptureSession(value: unknown): CaptureSession {
  return parseResult("Capture session", validateCaptureSession(value));
}

export function parseGuideAudience(value: unknown): GuideAudience {
  return parseResult("Guide audience", validateGuideAudience(value));
}

export function parseGuideBlock(value: unknown): GuideBlock {
  return parseResult("Guide block", validateGuideBlock(value));
}

export function parseWorkspaceBranding(value: unknown): WorkspaceBranding {
  return parseResult("Workspace branding", validateWorkspaceBranding(value));
}

export function parseGuideExportPolicy(value: unknown): GuideExportPolicy {
  return parseResult("Guide export policy", validateGuideExportPolicy(value));
}

export function parseGuideExportRequest(value: unknown): GuideExportRequest {
  return parseResult("Guide export request", validateGuideExportRequest(value));
}

export function parseGuideAuditEvent(value: unknown): GuideAuditEvent {
  return parseResult("Guide audit event", validateGuideAuditEvent(value));
}

export function parseGuideExportReceipt(value: unknown): GuideExportReceipt {
  return parseResult("Guide export receipt", validateGuideExportReceipt(value));
}
