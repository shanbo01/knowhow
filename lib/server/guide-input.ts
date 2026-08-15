import type { Audience, EditorBlock } from "../knowhow-types";
import { HttpError } from "./http-security";
import { inputObject, inputText } from "./input";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function coordinate(value: unknown, label: string, positive = false) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < (positive ? Number.EPSILON : 0) ||
    value > 1
  ) {
    throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} must be normalized between 0 and 1.`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} has invalid fields.`);
  }
}

function crop(value: unknown, label: string): NonNullable<EditorBlock["crop"]> {
  const object = inputObject(value, label);
  exactKeys(object, new Set(["x", "y", "width", "height"]), label);
  const x = coordinate(object.x, `${label} x`);
  const y = coordinate(object.y, `${label} y`);
  const result = {
    x,
    y,
    width: Math.min(coordinate(object.width, `${label} width`, true), Math.max(Number.EPSILON, 1 - x)),
    height: Math.min(coordinate(object.height, `${label} height`, true), Math.max(Number.EPSILON, 1 - y)),
  };
  return result;
}

function annotations(value: unknown, label: string): NonNullable<EditorBlock["annotations"]> {
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} is invalid.`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const item = inputObject(candidate, `${label} ${index + 1}`);
    exactKeys(
      item,
      new Set(["id", "kind", "x", "y", "width", "height", "x2", "y2", "text", "color"]),
      `${label} ${index + 1}`,
    );
    const id = inputText(item.id, "Annotation ID", { min: 1, max: 128 });
    if (!SAFE_ID.test(id) || seen.has(id)) throw new HttpError(400, "GUIDE_STEPS_INVALID", "Annotation IDs must be unique and valid.");
    seen.add(id);
    if (item.kind !== "click" && item.kind !== "arrow" && item.kind !== "box" && item.kind !== "text") {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", "An annotation kind is invalid.");
    }
    const x = coordinate(item.x, "Annotation x");
    const y = coordinate(item.y, "Annotation y");
    const width = item.width === undefined ? undefined : coordinate(item.width, "Annotation width", true);
    const height = item.height === undefined ? undefined : coordinate(item.height, "Annotation height", true);
    if (
      item.kind !== "click" &&
      ((width !== undefined && x + width > 1) || (height !== undefined && y + height > 1))
    ) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", "An annotation is outside the screenshot.");
    }
    const x2 = item.x2 === undefined ? undefined : coordinate(item.x2, "Annotation x2");
    const y2 = item.y2 === undefined ? undefined : coordinate(item.y2, "Annotation y2");
    const text = item.text === undefined ? undefined : inputText(item.text, "Annotation text", { max: 2_000 });
    if (item.kind === "text" && !text) throw new HttpError(400, "GUIDE_STEPS_INVALID", "Text annotations need text.");
    const color = item.color === undefined ? undefined : inputText(item.color, "Annotation color", { min: 4, max: 9 });
    if (color && !/^#[0-9a-f]{3,8}$/i.test(color)) throw new HttpError(400, "GUIDE_STEPS_INVALID", "Annotation color is invalid.");
    return { id, kind: item.kind, x, y, width, height, x2, y2, text, color };
  });
}

function redactions(value: unknown, label: string): NonNullable<EditorBlock["redactions"]> {
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "GUIDE_STEPS_INVALID", `${label} is invalid.`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const item = inputObject(candidate, `${label} ${index + 1}`);
    exactKeys(item, new Set(["id", "x", "y", "width", "height", "applied"]), `${label} ${index + 1}`);
    const id = inputText(item.id, "Redaction ID", { min: 1, max: 128 });
    if (!SAFE_ID.test(id) || seen.has(id)) throw new HttpError(400, "GUIDE_STEPS_INVALID", "Redaction IDs must be unique and valid.");
    seen.add(id);
    const x = coordinate(item.x, "Redaction x");
    const y = coordinate(item.y, "Redaction y");
    const width = Math.min(coordinate(item.width, "Redaction width", true), Math.max(Number.EPSILON, 1 - x));
    const height = Math.min(coordinate(item.height, "Redaction height", true), Math.max(Number.EPSILON, 1 - y));
    if (typeof item.applied !== "boolean") {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", "A redaction is invalid.");
    }
    return { id, x, y, width, height, applied: item.applied };
  });
}

export function normalizeGuideSteps(value: unknown): EditorBlock[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 250) {
    throw new HttpError(400, "GUIDE_STEPS_INVALID", "A guide needs between 1 and 250 blocks.");
  }
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    const item = inputObject(candidate, `Block ${index + 1}`);
    exactKeys(
      item,
      new Set(["id", "kind", "title", "description", "screenshotMediaId", "crop", "annotations", "redactions"]),
      `Block ${index + 1}`,
    );
    if (item.kind !== "action" && item.kind !== "heading" && item.kind !== "note" && item.kind !== "warning") {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", `Block ${index + 1} has an invalid type.`);
    }
    const id = inputText(item.id, `Block ${index + 1} ID`, { min: 1, max: 128 });
    if (!SAFE_ID.test(id) || ids.has(id)) throw new HttpError(400, "GUIDE_STEPS_INVALID", "Block IDs must be unique and valid.");
    ids.add(id);
    const screenshotMediaId = item.screenshotMediaId === undefined
      ? undefined
      : inputText(item.screenshotMediaId, "Screenshot", { min: 1, max: 36 });
    if (screenshotMediaId && !SAFE_ID.test(screenshotMediaId)) throw new HttpError(400, "GUIDE_STEPS_INVALID", "A screenshot ID is invalid.");
    const normalizedCrop = item.crop === undefined ? undefined : crop(item.crop, `Block ${index + 1} crop`);
    const normalizedAnnotations = item.annotations === undefined ? undefined : annotations(item.annotations, `Block ${index + 1} annotations`);
    const normalizedRedactions = item.redactions === undefined ? undefined : redactions(item.redactions, `Block ${index + 1} redactions`);
    if (!screenshotMediaId && (normalizedCrop || normalizedAnnotations?.length || normalizedRedactions?.length)) {
      throw new HttpError(400, "GUIDE_STEPS_INVALID", "Media edits require a private screenshot.");
    }
    return {
      id,
      kind: item.kind,
      title: inputText(item.title, `Block ${index + 1} title`, { min: 1, max: 500 }),
      description: inputText(item.description ?? "", `Block ${index + 1} description`, { max: 50_000 }),
      ...(screenshotMediaId ? { screenshotMediaId } : {}),
      ...(normalizedCrop ? { crop: normalizedCrop } : {}),
      ...(normalizedAnnotations ? { annotations: normalizedAnnotations } : {}),
      ...(normalizedRedactions ? { redactions: normalizedRedactions } : {}),
    };
  });
}

export function normalizeGuideAudiences(value: unknown, workspaceId: string): Audience[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new HttpError(400, "AUDIENCE_REQUIRED", "Select at least one audience.");
  }
  const audiences = value.map((candidate) => {
    const item = inputObject(candidate, "Audience");
    if (item.kind !== "workspace" && item.kind !== "group" && item.kind !== "user") {
      throw new HttpError(400, "AUDIENCE_INVALID", "An audience is invalid.");
    }
    const kind = item.kind;
    return {
      kind,
      subjectId: kind === "workspace" ? workspaceId : inputText(item.subjectId, "Audience target", { min: 1, max: 36 }),
      label: item.label === undefined ? undefined : inputText(item.label, "Audience label", { max: 200 }),
    } satisfies Audience;
  });
  if (audiences.some((audience) => audience.kind === "workspace")) {
    return [{ kind: "workspace", subjectId: workspaceId, label: "Entire workspace" }];
  }
  return audiences.filter(
    (audience, index, all) =>
      all.findIndex((candidate) => candidate.kind === audience.kind && candidate.subjectId === audience.subjectId) === index,
  );
}

