import type { GuideBlock, PublishedGuideRevision } from "../guide-contracts";
import { prepareGuideExport } from "./policy";
import {
  assetSource,
  escapeMarkdown,
  formatLongDate,
  markdownText,
  safeDocumentHref,
  watermarkParts,
} from "./shared";
import type { GuideRenderOptions, PreparedGuideExport } from "./types";

function calloutMarker(tone: "note" | "warning" | "success"): string {
  if (tone === "warning") return "[!WARNING]";
  if (tone === "success") return "[!TIP]";
  return "[!NOTE]";
}

function markdownDestination(value: string): string {
  return `<${value
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E")
    .replaceAll(" ", "%20")}>`;
}

/** Prefixes every line of an already-rendered block with `> `. */
function quote(value: string): string {
  return value
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function anchor(text: string, used: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen ? `${base}-${seen}` : base;
}

/**
 * Headings own `##`, so every action step sits at `###` underneath them and the
 * document outline matches what the reader sees.
 */
function renderBlock(
  block: GuideBlock,
  actionNumber: number,
  prepared: PreparedGuideExport,
): string[] {
  if (block.type === "heading") {
    return [`${block.level === 2 ? "##" : "###"} ${escapeMarkdown(block.text)}`, ""];
  }
  if (block.type === "paragraph") {
    return [markdownText(block.text), ""];
  }
  if (block.type === "callout") {
    // The alert marker already names an untitled callout, so only an author's
    // own title earns a heading line of its own.
    return [
      quote(
        [
          calloutMarker(block.tone),
          ...(block.title ? [`**${escapeMarkdown(block.title)}**`, ""] : []),
          markdownText(block.text),
        ].join("\n"),
      ),
      "",
    ];
  }

  const lines: string[] = [
    `### Step ${actionNumber}. ${escapeMarkdown(block.title)}`,
    "",
    markdownText(block.instructions),
    "",
  ];
  if (block.systemReference) {
    const safeUrl = safeDocumentHref(block.systemReference.url);
    const name = escapeMarkdown(block.systemReference.name);
    lines.push(
      `**System:** ${safeUrl ? `[${name}](${markdownDestination(safeUrl)})` : name}`,
      "",
    );
  }
  if (block.media) {
    const source = assetSource(prepared.assets.get(block.media.mediaId));
    const alt = escapeMarkdown(block.media.altText);
    lines.push(
      source
        ? `![${alt}](${markdownDestination(source)})`
        : `> _Screenshot unavailable in this export: ${alt}_`,
      "",
    );
  }
  if (block.expectedResult) {
    lines.push(
      quote(`**Expected result**\n\n${markdownText(block.expectedResult)}`),
      "",
    );
  }
  if (block.requiresConfirmation) {
    lines.push("- [ ] Confirm the expected result before continuing.", "");
  }
  return lines;
}

export function renderGuideToMarkdown(
  candidate: PublishedGuideRevision,
  options: GuideRenderOptions = {},
): string {
  const prepared = prepareGuideExport(candidate, "markdown", options);
  const { revision, watermark } = prepared;
  const output: string[] = [];

  output.push(`# ${escapeMarkdown(revision.title)}`, "");
  if (revision.summary) output.push(markdownText(revision.summary), "");
  output.push(
    [
      escapeMarkdown(revision.branding.workspaceName),
      `Revision ${revision.revisionNumber}`,
      `Published ${formatLongDate(revision.publishedAt)}`,
    ].join(" · "),
    "",
  );

  const marks = watermarkParts(watermark);
  if (marks.length) {
    output.push(
      quote(
        [
          "[!IMPORTANT]",
          "**Controlled copy.** Check the live guide before you rely on it.",
          "",
          ...marks.map((part) => escapeMarkdown(part)),
        ].join("\n"),
      ),
      "",
    );
  }

  // A contents list is what makes a long SOP navigable once it leaves the app.
  const used = new Map<string, number>();
  const contents: string[] = [];
  let counter = 0;
  const numbers = new Map<string, number>();
  for (const block of revision.blocks) {
    if (block.type === "action") {
      counter += 1;
      numbers.set(block.id, counter);
      contents.push(
        `   - [Step ${counter}. ${escapeMarkdown(block.title)}](#${anchor(`step-${counter}-${block.title}`, used)})`,
      );
    } else if (block.type === "heading") {
      contents.push(
        `${block.level === 2 ? "" : "   "}- [${escapeMarkdown(block.text)}](#${anchor(block.text, used)})`,
      );
    }
  }
  if (contents.length > 2) {
    output.push("## Contents", "", ...contents, "");
  }

  for (const block of revision.blocks) {
    output.push(...renderBlock(block, numbers.get(block.id) ?? 0, prepared));
  }

  if (revision.branding.showKnowHowBranding) {
    output.push("---", "", "_Generated with KnowHow._", "");
  }

  return `${output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
