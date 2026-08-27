import type {
  GuideExportAsset,
  GuideExportWatermark,
} from "./types";

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!>|])/g, "\\$1");
}

export function markdownText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => escapeMarkdown(line))
    .join("  \n");
}

export function formatIsoDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function safeDocumentHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^(?:https?:\/\/|\/|\.\/|\.\.\/)/i.test(value) ? value : undefined;
}

export function formatWatermark(
  watermark: GuideExportWatermark | undefined,
): string | undefined {
  if (!watermark) return undefined;
  const parts = [
    watermark.workspace ? `Workspace: ${watermark.workspace}` : "",
    watermark.viewer ? `Viewer: ${watermark.viewer}` : "",
    watermark.exportedAt
      ? `Exported: ${formatIsoDate(watermark.exportedAt)}`
      : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" | ") : undefined;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const packed = (first << 16) | (second << 8) | third;
    result += BASE64_ALPHABET[(packed >> 18) & 63];
    result += BASE64_ALPHABET[(packed >> 12) & 63];
    result += index + 1 < bytes.length
      ? BASE64_ALPHABET[(packed >> 6) & 63]
      : "=";
    result += index + 2 < bytes.length ? BASE64_ALPHABET[packed & 63] : "=";
  }
  return result;
}

export function assetSource(
  asset: GuideExportAsset | undefined,
): string | undefined {
  if (asset?.bytes) {
    return `data:${asset.mimeType};base64,${bytesToBase64(asset.bytes)}`;
  }
  return asset?.href;
}

export function pdfSafeText(value: string): string {
  return value
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u2022/g, "-")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "?");
}

export function hexToRgb(value: string): {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
} {
  const normalized = value.slice(1);
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16) / 255,
    green: Number.parseInt(normalized.slice(2, 4), 16) / 255,
    blue: Number.parseInt(normalized.slice(4, 6), 16) / 255,
  };
}
