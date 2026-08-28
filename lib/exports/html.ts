import type { GuideBlock, PublishedGuideRevision } from "../guide-contracts";
import { prepareGuideExport } from "./policy";
import {
  assetSource,
  escapeHtml,
  formatLongDate,
  plainText,
  safeDocumentHref,
  shadeHex,
  tintHex,
  watermarkParts,
} from "./shared";
import type { GuideRenderOptions, PreparedGuideExport } from "./types";

function projected(value: number, start: number, size: number): number {
  return ((value - start) / size) * 100;
}

function slug(value: string, used: Map<string, number>): string {
  const base =
    plainText(value)
      .toLowerCase()
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "section";
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen ? `${base}-${seen}` : base;
}

function mediaFigure(
  block: Extract<GuideBlock, { type: "action" }>,
  source: string,
): string {
  const media = block.media!;
  const crop = media.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const shapes: string[] = [];
  const click = media.clickTarget;
  if (
    click &&
    click.point.x >= crop.x &&
    click.point.x <= crop.x + crop.width &&
    click.point.y >= crop.y &&
    click.point.y <= crop.y + crop.height
  ) {
    const cx = projected(click.point.x, crop.x, crop.width);
    const cy = projected(click.point.y, crop.y, crop.height);
    const radius = Math.max(1.2, (click.radius / Math.max(crop.width, crop.height)) * 100);
    shapes.push(
      `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${escapeHtml(click.color)}" stroke-width="1.4"/><circle cx="${cx}" cy="${cy}" r="1.2" fill="${escapeHtml(click.color)}"/>`,
    );
  }
  for (const item of media.annotations) {
    const x = projected(item.region.x, crop.x, crop.width);
    const y = projected(item.region.y, crop.y, crop.height);
    const width = (item.region.width / crop.width) * 100;
    const height = (item.region.height / crop.height) * 100;
    const color = escapeHtml(item.color);
    if (item.type === "arrow") {
      shapes.push(
        `<line x1="${x}" y1="${y}" x2="${x + width}" y2="${y + height}" stroke="${color}" stroke-width="1.4"/><path d="M ${x + width} ${y + height} l -3 -1.2 l 1.2 -3 z" fill="${color}"/>`,
      );
    } else if (item.type === "highlight") {
      shapes.push(
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color}" fill-opacity=".24" stroke="${color}" stroke-width=".7"/>`,
      );
    } else if (item.type === "text") {
      shapes.push(
        `<rect x="${x}" y="${y}" width="${Math.max(width, 12)}" height="${Math.max(height, 7)}" rx="1.2" fill="${color}" fill-opacity=".92"/><text x="${x + 1.5}" y="${y + 4.8}" fill="#fff" font-size="3.4" font-family="ui-sans-serif,system-ui">${escapeHtml(item.text ?? "Annotation")}</text>`,
      );
    } else {
      shapes.push(
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="${color}" stroke-width="1.3"/>`,
      );
    }
  }
  const imageStyle = [
    `width:${100 / crop.width}%`,
    `height:${100 / crop.height}%`,
    `left:${(-crop.x / crop.width) * 100}%`,
    `top:${(-crop.y / crop.height) * 100}%`,
  ].join(";");
  const aspect = (media.width * crop.width) / (media.height * crop.height);
  return `<figure class="shot"><div class="shot-frame" style="aspect-ratio:${aspect}"><img src="${escapeHtml(source)}" alt="${escapeHtml(media.altText)}" style="${imageStyle}"><svg class="shot-marks" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${shapes.join("")}</svg></div></figure>`;
}

function paragraphs(value: string): string {
  return plainText(value)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

const CALLOUT_LABELS = {
  note: "Note",
  warning: "Warning",
  success: "Tip",
} as const;

function renderBlock(
  block: GuideBlock,
  ids: ReadonlyMap<string, string>,
  numbers: ReadonlyMap<string, number>,
  prepared: PreparedGuideExport,
): string {
  if (block.type === "heading") {
    const id = ids.get(block.id) ?? "";
    return block.level === 2
      ? `<h2 class="section" id="${escapeHtml(id)}">${escapeHtml(block.text)}</h2>`
      : `<h3 class="subsection" id="${escapeHtml(id)}">${escapeHtml(block.text)}</h3>`;
  }
  if (block.type === "paragraph") {
    return `<div class="prose">${paragraphs(block.text)}</div>`;
  }
  if (block.type === "callout") {
    const label = CALLOUT_LABELS[block.tone];
    return `<aside class="callout callout-${block.tone}"><p class="callout-label">${escapeHtml(block.title || label)}</p>${paragraphs(block.text)}</aside>`;
  }

  const number = numbers.get(block.id) ?? 0;
  const id = ids.get(block.id) ?? "";
  const systemUrl = safeDocumentHref(block.systemReference?.url);
  const system = block.systemReference
    ? `<p class="system"><span class="system-label">System</span>${
        systemUrl
          ? `<a href="${escapeHtml(systemUrl)}" rel="noreferrer noopener">${escapeHtml(block.systemReference.name)}</a>`
          : `<span>${escapeHtml(block.systemReference.name)}</span>`
      }</p>`
    : "";
  const mediaSource = block.media
    ? assetSource(prepared.assets.get(block.media.mediaId))
    : undefined;
  const media = block.media
    ? mediaSource
      ? mediaFigure(block, mediaSource)
      : `<p class="shot-missing" role="img" aria-label="${escapeHtml(block.media.altText)}">Screenshot unavailable in this export</p>`
    : "";
  const expected = block.expectedResult
    ? `<div class="expected"><p class="expected-label">Expected result</p>${paragraphs(block.expectedResult)}</div>`
    : "";
  const confirmation = block.requiresConfirmation
    ? '<p class="confirm">Confirm the expected result before continuing.</p>'
    : "";

  return `<section class="step" id="${escapeHtml(id)}"><div class="step-rail"><span class="step-number">${number}</span></div><div class="step-body"><h3 class="step-title"><span class="sr-only">Step ${number}. </span>${escapeHtml(block.title)}</h3><div class="prose">${paragraphs(block.instructions)}</div>${system}${media}${expected}${confirmation}</div></section>`;
}

export function renderGuideToHtml(
  candidate: PublishedGuideRevision,
  options: GuideRenderOptions = {},
): string {
  const prepared = prepareGuideExport(candidate, "html", options);
  const { revision, assets, watermark } = prepared;
  const accent = revision.branding.accentColor;
  const marks = watermarkParts(watermark);
  const logoAsset = revision.branding.logoMediaId
    ? assets.get(revision.branding.logoMediaId)
    : undefined;
  const logoSource = assetSource(logoAsset);

  const ids = new Map<string, string>();
  const numbers = new Map<string, number>();
  const used = new Map<string, number>();
  let counter = 0;
  for (const block of revision.blocks) {
    if (block.type === "action") {
      counter += 1;
      numbers.set(block.id, counter);
      ids.set(block.id, slug(`step-${counter}-${block.title}`, used));
    } else if (block.type === "heading") {
      ids.set(block.id, slug(block.text, used));
    }
  }
  const stepCount = counter;

  const contents = revision.blocks
    .filter((block) => block.type === "heading" || block.type === "action")
    .map((block) => {
      const id = escapeHtml(ids.get(block.id) ?? "");
      if (block.type === "action") {
        return `<li class="toc-step"><a href="#${id}"><span class="toc-number">${numbers.get(block.id)}</span>${escapeHtml(block.title)}</a></li>`;
      }
      const level = block.type === "heading" && block.level === 3 ? " toc-sub" : "";
      return `<li class="toc-section${level}"><a href="#${id}">${escapeHtml(block.text)}</a></li>`;
    })
    .join("");

  const blocks = revision.blocks
    .map((block) => renderBlock(block, ids, numbers, prepared))
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline';">
  <meta name="generator" content="KnowHow">
  <meta name="description" content="${escapeHtml(plainText(revision.summary ?? revision.title).slice(0, 300))}">
  <title>${escapeHtml(revision.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --accent: ${accent};
      --accent-deep: ${shadeHex(accent, 0.32)};
      --accent-wash: ${tintHex(accent, 0.94)};
      --accent-edge: ${tintHex(accent, 0.72)};
      --ink: #14181a;
      --ink-soft: #3d474b;
      --muted: #6a757a;
      --rule: #e2e6e6;
      --rule-strong: #cdd4d4;
      --paper: #ffffff;
      --desk: #eef0ee;
      --warn: #9a4b00;
      --warn-wash: #fff6e9;
      --ok: #1f6b48;
      --ok-wash: #eef8f2;
      --measure: 68ch;
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      background: var(--desk);
      color: var(--ink);
      font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-variant-numeric: tabular-nums;
    }
    .sr-only {
      position: absolute; width: 1px; height: 1px;
      margin: -1px; padding: 0; border: 0;
      clip-path: inset(50%); overflow: hidden; white-space: nowrap;
    }
    .doc {
      width: min(920px, calc(100% - 32px));
      margin: 40px auto;
      background: var(--paper);
      border-radius: 6px;
      box-shadow: 0 1px 2px rgba(20, 24, 26, .06), 0 18px 50px rgba(20, 24, 26, .10);
      overflow: hidden;
    }

    /* Cover */
    .cover { padding: 56px 64px 34px; border-top: 5px solid var(--accent); }
    .brand {
      display: flex; align-items: center; gap: 12px;
      margin-bottom: 30px;
      color: var(--muted);
      font-size: 12px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
    }
    .brand img { display: block; max-width: 132px; max-height: 40px; object-fit: contain; }
    h1 {
      max-width: 22ch;
      margin: 0;
      font-size: clamp(32px, 5.4vw, 46px);
      font-weight: 700;
      line-height: 1.08;
      letter-spacing: -.025em;
    }
    .summary {
      max-width: var(--measure);
      margin: 20px 0 0;
      color: var(--ink-soft);
      font-size: 18px;
      line-height: 1.55;
    }
    .facts {
      display: flex; flex-wrap: wrap; gap: 0 28px;
      margin: 28px 0 0; padding: 16px 0 0;
      border-top: 1px solid var(--rule);
      list-style: none;
    }
    .facts div { display: flex; flex-direction: column; gap: 2px; }
    .facts dt { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .facts dd { margin: 0; font-size: 14px; font-weight: 600; }
    .controlled {
      display: flex; flex-wrap: wrap; gap: 6px 18px;
      margin-top: 22px; padding: 12px 16px;
      border: 1px solid var(--accent-edge); border-radius: 5px;
      background: var(--accent-wash);
      color: var(--accent-deep);
      font-size: 12.5px;
    }
    .controlled strong { font-weight: 700; }

    /* Contents */
    .contents { padding: 26px 64px 30px; border-top: 1px solid var(--rule); background: #fafbfa; }
    .contents h2 { margin: 0 0 12px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
    .contents ol { margin: 0; padding: 0; list-style: none; }
    .contents a { display: block; padding: 3px 0; color: var(--ink); text-decoration: none; }
    .contents a:hover { color: var(--accent-deep); text-decoration: underline; }
    .toc-section > a { margin-top: 10px; font-weight: 700; }
    .toc-section:first-child > a { margin-top: 0; }
    .toc-sub > a { padding-left: 14px; font-weight: 600; }
    .toc-step > a { display: grid; grid-template-columns: 26px 1fr; align-items: baseline; color: var(--ink-soft); font-size: 15px; }
    .toc-number { color: var(--muted); font-size: 12px; font-weight: 700; }

    /* Body */
    .body { padding: 14px 64px 56px; }
    .prose { max-width: var(--measure); }
    .prose p { margin: 0 0 14px; }
    .prose p:last-child { margin-bottom: 0; }
    .section {
      margin: 46px 0 18px;
      padding-bottom: 10px;
      border-bottom: 2px solid var(--rule-strong);
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -.015em;
      break-after: avoid;
    }
    .subsection { margin: 34px 0 14px; font-size: 18px; font-weight: 700; break-after: avoid; }
    .section + .step, .subsection + .step { margin-top: 22px; }

    /* Steps */
    .step {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      gap: 0 18px;
      margin: 30px 0;
      break-inside: avoid;
    }
    .step-rail { display: flex; flex-direction: column; align-items: center; gap: 8px; }
    .step-number {
      display: grid; width: 30px; height: 30px; place-items: center;
      border-radius: 999px;
      background: var(--accent); color: #fff;
      font-size: 13px; font-weight: 700; line-height: 1;
    }
    .step-rail::after { content: ""; flex: 1; width: 2px; background: var(--rule); border-radius: 1px; }
    .step:last-of-type .step-rail::after { display: none; }
    .step-title { margin: 3px 0 10px; font-size: 19px; font-weight: 700; line-height: 1.3; letter-spacing: -.01em; }
    .step-body > * + * { margin-top: 14px; }

    .system { display: flex; align-items: baseline; gap: 8px; margin: 0; font-size: 13.5px; }
    .system-label { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    a { color: var(--accent-deep); }

    .shot { margin: 0; }
    .shot-frame {
      position: relative;
      overflow: hidden;
      width: 100%;
      border: 1px solid var(--rule-strong);
      border-radius: 6px;
      background: #f4f6f5;
      box-shadow: 0 1px 3px rgba(20, 24, 26, .07);
    }
    .shot-frame img { position: absolute; display: block; max-width: none; object-fit: fill; }
    .shot-marks { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; }
    .shot-missing {
      margin: 0; padding: 26px 20px;
      border: 1px dashed var(--rule-strong); border-radius: 6px;
      color: var(--muted); font-size: 13px; text-align: center;
    }

    .callout, .expected {
      max-width: var(--measure);
      margin: 22px 0;
      padding: 14px 18px;
      border: 1px solid var(--accent-edge);
      border-left-width: 4px;
      border-radius: 5px;
      background: var(--accent-wash);
      break-inside: avoid;
    }
    .step-body .callout, .step-body .expected { margin: 0; }
    .callout-label, .expected-label {
      margin: 0 0 5px;
      color: var(--accent-deep);
      font-size: 11.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
    }
    .callout p:last-child, .expected p:last-child { margin-bottom: 0; }
    .callout-warning { border-color: #f0d3a6; background: var(--warn-wash); }
    .callout-warning .callout-label { color: var(--warn); }
    .callout-success, .expected { border-color: #bfe0cd; background: var(--ok-wash); }
    .callout-success .callout-label, .expected-label { color: var(--ok); }
    .confirm {
      display: inline-block; margin: 0;
      padding: 6px 12px; border-radius: 999px;
      background: var(--warn-wash); color: var(--warn);
      font-size: 12.5px; font-weight: 700;
    }

    .colophon {
      padding: 22px 64px 30px;
      border-top: 1px solid var(--rule);
      color: var(--muted);
      font-size: 12px;
    }

    @media (max-width: 680px) {
      .doc { width: 100%; margin: 0; border-radius: 0; }
      .cover { padding: 36px 22px 26px; }
      .contents, .body, .colophon { padding-left: 22px; padding-right: 22px; }
      .step { grid-template-columns: 32px minmax(0, 1fr); gap: 0 12px; }
      .step-number { width: 26px; height: 26px; font-size: 12px; }
    }

    @page { margin: 16mm 14mm 18mm; }
    @media print {
      body { background: #fff; font-size: 10.5pt; }
      .doc { width: auto; margin: 0; border-radius: 0; box-shadow: none; }
      .cover { padding: 0 0 20px; break-after: page; }
      .contents { padding: 0; border: 0; background: none; break-after: page; }
      .body { padding: 0; }
      .colophon { padding: 18px 0 0; }
      h1 { font-size: 30pt; }
      .summary { font-size: 12pt; }
      .contents a { color: var(--ink); }
      .shot-frame { box-shadow: none; }
      .step, .callout, .expected, .shot { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main class="doc">
    <header class="cover">
      <div class="brand">${logoSource ? `<img src="${escapeHtml(logoSource)}" alt="${escapeHtml(revision.branding.workspaceName)}">` : ""}<span>${escapeHtml(revision.branding.workspaceName)}</span></div>
      <h1>${escapeHtml(revision.title)}</h1>
      ${revision.summary ? `<p class="summary">${escapeHtml(plainText(revision.summary)).replaceAll("\n", "<br>")}</p>` : ""}
      <dl class="facts">
        <div><dt>Revision</dt><dd>${revision.revisionNumber}</dd></div>
        <div><dt>Published</dt><dd>${escapeHtml(formatLongDate(revision.publishedAt))}</dd></div>
        ${stepCount ? `<div><dt>Steps</dt><dd>${stepCount}</dd></div>` : ""}
      </dl>
      ${
        marks.length
          ? `<p class="controlled"><strong>Controlled copy.</strong> ${marks.map((part) => escapeHtml(part)).join(" &middot; ")}</p>`
          : ""
      }
    </header>
    ${contents ? `<nav class="contents" aria-label="Contents"><h2>Contents</h2><ol>${contents}</ol></nav>` : ""}
    <article class="body">
${blocks}
    </article>
    ${revision.branding.showKnowHowBranding ? '<footer class="colophon">Generated with KnowHow. Exports are point-in-time copies &mdash; check the live guide for the current revision.</footer>' : ""}
  </main>
</body>
</html>
`;
}
