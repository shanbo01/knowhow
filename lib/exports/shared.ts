import type {
  GuideExportAsset,
  GuideExportWatermark,
} from "./types";

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Characters WinAnsiEncoding places in 0x80-0x9f. Everything else the standard
 * PDF fonts can draw is plain Latin-1, so those two ranges together describe
 * the whole glyph set available to `pdfSafeText`.
 */
const WIN_ANSI_HIGH = new Set(
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ",
);

/** Symbols with no PDF standard-font glyph that still deserve to survive. */
const TRANSLITERATIONS = new Map<string, string>([
  ["→", "->"],
  ["⇒", "=>"],
  ["←", "<-"],
  ["⇐", "<="],
  ["↔", "<->"],
  ["↑", "^"],
  ["↓", "v"],
  ["≤", "<="],
  ["≥", ">="],
  ["≠", "!="],
  ["≈", "~"],
  ["✓", "[x]"],
  ["✔", "[x]"],
  ["✗", "[ ]"],
  ["✘", "[ ]"],
  ["▸", ">"],
  ["►", ">"],
  ["⌘", "Cmd"],
  ["⌥", "Alt"],
  ["⇧", "Shift"],
  ["⌃", "Ctrl"],
  ["⏎", "Enter"],
  ["⌫", "Backspace"],
]);

/** Whitespace a capture picks up that should read as a plain space. */
const UNICODE_SPACES = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
]);

/** Zero-width marks that survive a copy/paste and corrupt nothing but layout. */
const INVISIBLE = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Normalizes author text for any renderer: collapses the exotic whitespace a
 * browser capture picks up and drops control characters that are illegal in
 * XML, without touching the Unicode the author actually meant to write.
 */
export function plainText(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === 0x0d) continue;
    if (code === 0x0a || code === 0x09) {
      result += character;
      continue;
    }
    if (UNICODE_SPACES.has(code)) {
      result += " ";
      continue;
    }
    // Control characters and zero-width marks are illegal or invisible in XML.
    if (code < 0x20 || code === 0x7f || INVISIBLE.has(code)) continue;
    result += character;
  }
  return result.replace(/[ \t]+$/gm, "");
}

/**
 * Escapes only what would otherwise be parsed as Markdown. Escaping every
 * punctuation mark is safe but makes the raw file unreadable, which is most of
 * what people do with a Markdown export.
 */
export function escapeMarkdown(value: string): string {
  return plainText(value)
    .replace(/([\\`*[\]<|])/g, "\\$1")
    // Underscores only open emphasis at a word boundary, so leave snake_case be.
    .replace(/(^|[^\w\\])_/g, "$1\\_")
    .replace(/_($|[^\w])/g, "\\_$1")
    // Line-leading punctuation would otherwise start a heading, quote or list.
    .replace(/^(\s*)([#>+=-])/gm, "$1\\$2")
    .replace(/^(\s*\d+)([.)])/gm, "$1\\$2");
}

/**
 * Renders a multi-paragraph string as Markdown: blank lines stay paragraph
 * breaks, single newlines become hard breaks.
 */
export function markdownText(value: string): string {
  return plainText(value)
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => escapeMarkdown(line).trimEnd())
        .filter(Boolean)
        .join("  \n"),
    )
    .filter(Boolean)
    .join("\n\n");
}

export function formatIsoDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

export function formatLongDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? formatIsoDate(value) : LONG_DATE.format(parsed);
}

export function safeDocumentHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^(?:https?:\/\/|\/|\.\/|\.\.\/)/i.test(value) ? value : undefined;
}

export function watermarkParts(
  watermark: GuideExportWatermark | undefined,
): readonly string[] {
  if (!watermark) return [];
  return [
    watermark.workspace ? `Workspace: ${watermark.workspace}` : "",
    watermark.viewer ? `Viewer: ${watermark.viewer}` : "",
    watermark.exportedAt ? `Exported: ${formatIsoDate(watermark.exportedAt)}` : "",
  ].filter(Boolean);
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

function winAnsiEncodable(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0xa0 && code <= 0xff) ||
    WIN_ANSI_HIGH.has(character)
  );
}

/**
 * Restricts text to the glyphs the PDF standard fonts can actually draw. Those
 * fonts use WinAnsiEncoding, so accented Latin, curly quotes, dashes and
 * bullets all survive; only genuinely unrepresentable symbols are
 * transliterated or, as a last resort, replaced.
 */
export function pdfSafeText(value: string): string {
  let result = "";
  for (const character of plainText(value)) {
    if (character === "\n" || winAnsiEncodable(character)) {
      result += character;
      continue;
    }
    const transliterated = TRANSLITERATIONS.get(character);
    if (transliterated !== undefined) {
      result += transliterated;
      continue;
    }
    // Strip the accent rather than the letter: "A-macron" reads better as "A".
    const folded = [...character.normalize("NFKD")]
      .filter((part) => {
        const code = part.codePointAt(0)!;
        return code < 0x0300 || code > 0x036f;
      })
      .join("");
    result += folded && [...folded].every(winAnsiEncodable) ? folded : "?";
  }
  return result;
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

/** Mixes a hex colour toward white (`amount` 0 keeps it, 1 makes it white). */
export function tintHex(value: string, amount: number): string {
  const { red, green, blue } = hexToRgb(value);
  const channel = (raw: number) =>
    Math.round((raw + (1 - raw) * amount) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** Darkens a hex colour toward black, for text that must stay legible. */
export function shadeHex(value: string, amount: number): string {
  const { red, green, blue } = hexToRgb(value);
  const channel = (raw: number) =>
    Math.round(raw * (1 - amount) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** Uppercase hex without the leading `#`, the form DrawingML wants. */
export function drawingMlColor(value: string): string {
  return value.replace("#", "").toUpperCase();
}
