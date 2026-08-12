import { HttpError } from "./http-security";

export function inputText(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; optional?: boolean } = {},
) {
  if (value === undefined && options.optional) return "";
  if (typeof value !== "string") throw new HttpError(400, "INPUT_INVALID", `${label} is required.`);
  const normalized = value.trim();
  if (normalized.length < (options.min ?? 0) || normalized.length > (options.max ?? 2_000)) {
    throw new HttpError(400, "INPUT_INVALID", `${label} is invalid.`);
  }
  return normalized;
}

export function inputBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new HttpError(400, "INPUT_INVALID", `${label} is invalid.`);
  return value;
}

export function inputInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new HttpError(400, "INPUT_INVALID", `${label} is invalid.`);
  }
  return Number(value);
}

export function inputStringList(value: unknown, label: string, maximumItems: number, maximumLength = 320) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new HttpError(400, "INPUT_INVALID", `${label} is invalid.`);
  }
  const output = value.map((item) => inputText(item, label, { max: maximumLength }));
  return [...new Set(output)];
}

export function inputObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "INPUT_INVALID", `${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

export function inputEmail(value: unknown, label = "Email") {
  const email = inputText(value, label, { min: 5, max: 320 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "EMAIL_INVALID", `${label} is invalid.`);
  }
  return email;
}

export function slugify(value: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || "workspace";
}

