import type {
  GuideActionMedia,
  GuideBlock,
  PublishedGuideRevision,
} from "../guide-contracts";
import { prepareGuideExport } from "./policy";
import {
  drawingMlColor,
  formatLongDate,
  plainText,
  shadeHex,
  tintHex,
  watermarkParts,
} from "./shared";
import {
  GuideRendererError,
  type GuideExportAsset,
  type GuideRenderOptions,
} from "./types";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function concat(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function u16(value: number) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** ZIP record signatures: "PK" followed by the record type. */
const LOCAL_FILE_HEADER = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
const CENTRAL_FILE_HEADER = Uint8Array.of(0x50, 0x4b, 0x01, 0x02);
const END_OF_CENTRAL_DIRECTORY = Uint8Array.of(0x50, 0x4b, 0x05, 0x06);

function zipStore(files: readonly ZipEntry[]) {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = utf8(file.name);
    const crc = crc32(file.data);
    const local = concat([
      LOCAL_FILE_HEADER,
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(file.data.byteLength),
      u32(file.data.byteLength),
      u16(name.byteLength),
      u16(0),
      name,
      file.data,
    ]);
    locals.push(local);
    centrals.push(
      concat([
        CENTRAL_FILE_HEADER,
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(file.data.byteLength),
        u32(file.data.byteLength),
        u16(name.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.byteLength;
  }
  const central = concat(centrals);
  const end = concat([
    END_OF_CENTRAL_DIRECTORY,
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.byteLength),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, central, end]);
}

function xml(value: string) {
  return plainText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// ---- Geometry (EMU: 914400 per inch, 16:9 deck) ---------------------------
const SLIDE_WIDTH = 12192000;
const SLIDE_HEIGHT = 6858000;
const MARGIN = 685800;
const CONTENT_WIDTH = SLIDE_WIDTH - MARGIN * 2;
const ACCENT_BAR = 45720;

const INK = "16191B";
const INK_SOFT = "3D474B";
const MUTED = "6A757A";
const WARNING = "9A4B00";
const WARNING_WASH = "FFF6E9";
const SUCCESS = "1F6B48";
const SUCCESS_WASH = "EEF8F2";
const PAPER = "FFFFFF";

interface Run {
  readonly text: string;
  readonly size: number;
  readonly bold?: boolean;
  readonly color?: string;
  readonly caps?: boolean;
  readonly spaceBefore?: number;
}

function runXml(run: Run): string {
  const properties = [
    `lang="en-US"`,
    `sz="${Math.round(run.size)}"`,
    run.bold ? `b="1"` : "",
    run.caps ? `cap="all" spc="180"` : "",
    `dirty="0"`,
  ]
    .filter(Boolean)
    .join(" ");
  return `<a:r><a:rPr ${properties}><a:solidFill><a:srgbClr val="${run.color ?? INK}"/></a:solidFill><a:latin typeface="+mn-lt"/></a:rPr><a:t>${xml(run.text)}</a:t></a:r>`;
}

/** One `a:p` per source line so multi-line instructions keep their breaks. */
function paragraphsXml(runs: readonly Run[]): string {
  return runs
    .flatMap((run) => {
      const lines = plainText(run.text).split("\n").filter((line) => line.trim());
      return lines.map((line, index) => {
        const spacing =
          index === 0 && run.spaceBefore
            ? `<a:spcBef><a:spcPts val="${Math.round(run.spaceBefore)}"/></a:spcBef>`
            : `<a:spcBef><a:spcPts val="300"/></a:spcBef>`;
        return `<a:p><a:pPr>${spacing}<a:lnSpc><a:spcPct val="105000"/></a:lnSpc></a:pPr>${runXml({ ...run, text: line })}</a:p>`;
      });
    })
    .join("");
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
}

function transform(box: Box): string {
  return `<a:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(Math.max(box.cx, 1))}" cy="${Math.round(Math.max(box.cy, 1))}"/></a:xfrm>`;
}

function textShape(
  id: number,
  name: string,
  box: Box,
  runs: readonly Run[],
  anchor: "t" | "ctr" | "b" = "t",
): string {
  if (!runs.some((run) => run.text.trim())) return "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${transform(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphsXml(runs)}</p:txBody></p:sp>`;
}

function rectShape(
  id: number,
  name: string,
  box: Box,
  fill: string,
  options: { readonly line?: string; readonly rounded?: boolean } = {},
): string {
  const geometry = options.rounded
    ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 6000"/></a:avLst></a:prstGeom>`
    : `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;
  const line = options.line
    ? `<a:ln w="9525"><a:solidFill><a:srgbClr val="${options.line}"/></a:solidFill></a:ln>`
    : `<a:ln><a:noFill/></a:ln>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${transform(box)}${geometry}<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>${line}</p:spPr></p:sp>`;
}

interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function pictureShape(
  id: number,
  relationship: string,
  box: Box,
  crop: CropRect | undefined,
  description: string,
): string {
  const percent = (value: number) =>
    Math.max(0, Math.min(99000, Math.round(value * 100000)));
  const source = crop
    ? `<a:srcRect l="${percent(crop.x)}" t="${percent(crop.y)}" r="${percent(1 - crop.x - crop.width)}" b="${percent(1 - crop.y - crop.height)}"/>`
    : "";
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Screenshot" descr="${xml(description)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relationship}"/>${source}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${transform(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="9525"><a:solidFill><a:srgbClr val="CDD4D4"/></a:solidFill></a:ln></p:spPr></p:pic>`;
}

function outlineShape(
  id: number,
  name: string,
  box: Box,
  geometry: "rect" | "ellipse",
  color: string,
  weight = 28575,
): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${transform(box)}<a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="${weight}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></p:spPr></p:sp>`;
}

function washShape(
  id: number,
  name: string,
  box: Box,
  color: string,
  alpha: number,
): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${transform(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"><a:alpha val="${alpha}"/></a:srgbClr></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></p:spPr></p:sp>`;
}

/** A straight arrow; DrawingML needs a positive extent plus flip flags. */
function arrowShape(
  id: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
): string {
  const flipH = to.x < from.x ? ' flipH="1"' : "";
  const flipV = to.y < from.y ? ' flipV="1"' : "";
  const geometry = `<a:xfrm${flipH}${flipV}><a:off x="${Math.round(Math.min(from.x, to.x))}" y="${Math.round(Math.min(from.y, to.y))}"/><a:ext cx="${Math.round(Math.max(Math.abs(to.x - from.x), 1))}" cy="${Math.round(Math.max(Math.abs(to.y - from.y), 1))}"/></a:xfrm>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Arrow"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${geometry}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="28575"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:tailEnd type="triangle" w="med" len="med"/></a:ln></p:spPr></p:sp>`;
}

function labelShape(id: number, box: Box, color: string, text: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Annotation"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${transform(box)}<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 14000"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="45720" tIns="18288" rIns="45720" bIns="18288" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr algn="ctr"/>${runXml({ text, size: 900, bold: true, color: PAPER })}</a:p></p:txBody></p:sp>`;
}

/**
 * Redraws the guide's click target and annotations over the placed screenshot,
 * so a deck carries the same markings the PDF and HTML exports do.
 */
function annotationShapes(
  startId: number,
  box: Box,
  media: GuideActionMedia,
): string[] {
  const crop = media.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const point = (nx: number, ny: number) => ({
    x: box.x + ((nx - crop.x) / crop.width) * box.cx,
    y: box.y + ((ny - crop.y) / crop.height) * box.cy,
  });
  const shapes: string[] = [];
  let id = startId;

  const click = media.clickTarget;
  if (
    click &&
    click.point.x >= crop.x &&
    click.point.x <= crop.x + crop.width &&
    click.point.y >= crop.y &&
    click.point.y <= crop.y + crop.height
  ) {
    const centre = point(click.point.x, click.point.y);
    const radius = Math.max(
      45720,
      (click.radius / Math.max(crop.width, crop.height)) * Math.min(box.cx, box.cy),
    );
    const color = drawingMlColor(click.color);
    shapes.push(
      outlineShape(
        id++,
        "Click target",
        { x: centre.x - radius, y: centre.y - radius, cx: radius * 2, cy: radius * 2 },
        "ellipse",
        color,
      ),
    );
    shapes.push(
      washShape(
        id++,
        "Click point",
        { x: centre.x - 22860, y: centre.y - 22860, cx: 45720, cy: 45720 },
        color,
        100000,
      ),
    );
  }

  for (const item of media.annotations) {
    const left = Math.max(item.region.x, crop.x);
    const top = Math.max(item.region.y, crop.y);
    const right = Math.min(item.region.x + item.region.width, crop.x + crop.width);
    const bottom = Math.min(item.region.y + item.region.height, crop.y + crop.height);
    if (right <= left || bottom <= top) continue;
    const topLeft = point(left, top);
    const bottomRight = point(right, bottom);
    const region: Box = {
      x: topLeft.x,
      y: topLeft.y,
      cx: bottomRight.x - topLeft.x,
      cy: bottomRight.y - topLeft.y,
    };
    const color = drawingMlColor(item.color);
    if (item.type === "arrow") {
      shapes.push(arrowShape(id++, topLeft, bottomRight, color));
    } else if (item.type === "highlight") {
      shapes.push(washShape(id++, "Highlight", region, color, 24000));
    } else if (item.type === "text") {
      const text = plainText(item.text ?? "Annotation").slice(0, 60);
      shapes.push(
        labelShape(
          id++,
          {
            ...region,
            cx: Math.max(region.cx, 914400),
            cy: Math.max(region.cy, 274320),
          },
          color,
          text,
        ),
      );
    } else {
      shapes.push(outlineShape(id++, "Region", region, "rect", color));
    }
  }
  return shapes;
}

function slideXml(shapes: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.filter(Boolean).join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="KnowHow"><a:themeElements><a:clrScheme name="KnowHow"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="16191B"/></a:dk2><a:lt2><a:srgbClr val="EEF0EE"/></a:lt2><a:accent1><a:srgbClr val="2F6F4E"/></a:accent1><a:accent2><a:srgbClr val="1F6B48"/></a:accent2><a:accent3><a:srgbClr val="6A757A"/></a:accent3><a:accent4><a:srgbClr val="9A4B00"/></a:accent4><a:accent5><a:srgbClr val="3D474B"/></a:accent5><a:accent6><a:srgbClr val="CDD4D4"/></a:accent6><a:hlink><a:srgbClr val="1F6B48"/></a:hlink><a:folHlink><a:srgbClr val="6A757A"/></a:folHlink></a:clrScheme><a:fontScheme name="KnowHow"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="KnowHow"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const EMPTY_TREE = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`;

const SLIDE_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${EMPTY_TREE}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr algn="l"><a:defRPr sz="1600"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr algn="l"><a:defRPr sz="1600"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const SLIDE_LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const RELATIONSHIPS_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELATIONSHIPS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function relationships(entries: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELATIONSHIPS_NS}">${entries.join("")}</Relationships>`;
}

function relationship(id: string, type: string, target: string): string {
  return `<Relationship Id="${id}" Type="${OFFICE_RELATIONSHIPS}/${type}" Target="${target}"/>`;
}

// ---- Slide composition -----------------------------------------------------

interface Palette {
  readonly accent: string;
  readonly accentDeep: string;
  readonly accentWash: string;
  readonly accentEdge: string;
}

interface SlidePlan {
  readonly shapes: readonly string[];
  readonly asset?: GuideExportAsset;
  readonly media?: GuideActionMedia;
}

/** Shrinks the body size as the text grows, so a long step still fits. */
function bodySize(text: string, base: number, minimum: number): number {
  const length = plainText(text).length;
  if (length <= 220) return base;
  if (length <= 420) return Math.max(minimum, base - 200);
  if (length <= 700) return Math.max(minimum, base - 400);
  return minimum;
}

function accentBar(id: number, color: string): string {
  return rectShape(id, "Accent", { x: 0, y: 0, cx: SLIDE_WIDTH, cy: ACCENT_BAR }, color);
}

const PANEL_INSET = 205740;
const EMU_PER_POINT = 12700;

/**
 * Estimates the height a panel needs. Helvetica-class faces average a little
 * over half the point size per character, which is close enough to keep a
 * panel from either clipping its text or floating in dead space.
 */
function panelHeight(body: string, size: number, width: number): number {
  const usable = (width - PANEL_INSET * 2) / EMU_PER_POINT;
  const perLine = Math.max(12, Math.floor(usable / (size / 100) / 0.52));
  const lines = plainText(body)
    .split("\n")
    .filter((line) => line.trim())
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0);
  const labelHeight = 15 * EMU_PER_POINT;
  const bodyHeight = lines * (size / 100) * 1.4 * EMU_PER_POINT;
  return Math.round(PANEL_INSET * 2 + labelHeight + bodyHeight);
}

/**
 * Draws a tone-coloured panel sized to its own text. `placement` is either the
 * top edge, or a bottom edge the panel grows upward from.
 */
function panel(
  id: number,
  frame: { x: number; cx: number } & ({ top: number } | { bottom: number }),
  label: string,
  body: string,
  tone: "note" | "warning" | "success",
  palette: Palette,
): readonly string[] {
  const fill =
    tone === "warning"
      ? WARNING_WASH
      : tone === "success"
        ? SUCCESS_WASH
        : palette.accentWash;
  const edge =
    tone === "warning"
      ? "F0D3A6"
      : tone === "success"
        ? "BFE0CD"
        : palette.accentEdge;
  const labelColor =
    tone === "warning" ? WARNING : tone === "success" ? SUCCESS : palette.accentDeep;
  const size = bodySize(body, 1300, 1000);
  const cy = panelHeight(body, size, frame.cx);
  const y = "top" in frame ? frame.top : frame.bottom - cy;
  const box: Box = { x: frame.x, y, cx: frame.cx, cy };
  return [
    rectShape(id, "Panel", box, fill, { line: edge, rounded: true }),
    textShape(
      id + 1,
      "Panel text",
      {
        x: box.x + PANEL_INSET,
        y: box.y + PANEL_INSET,
        cx: box.cx - PANEL_INSET * 2,
        cy: box.cy - PANEL_INSET * 2,
      },
      [
        { text: label, size: 1000, bold: true, color: labelColor, caps: true },
        { text: body, size, color: INK_SOFT, spaceBefore: 500 },
      ],
    ),
  ];
}

export async function renderGuideToPptx(
  candidate: PublishedGuideRevision,
  options: GuideRenderOptions = {},
): Promise<Uint8Array> {
  const prepared = prepareGuideExport(candidate, "pptx", options);
  const { revision, assets, watermark } = prepared;
  const marks = watermarkParts(watermark);
  const accentHex = revision.branding.accentColor;
  const palette: Palette = {
    accent: drawingMlColor(accentHex),
    accentDeep: drawingMlColor(shadeHex(accentHex, 0.32)),
    accentWash: drawingMlColor(tintHex(accentHex, 0.94)),
    accentEdge: drawingMlColor(tintHex(accentHex, 0.72)),
  };

  const stepTotal = revision.blocks.filter((block) => block.type === "action").length;
  const plans: SlidePlan[] = [];

  // Title slide.
  plans.push({
    shapes: [
      accentBar(2, palette.accent),
      textShape(
        4,
        "Workspace",
        { x: MARGIN, y: 1005840, cx: CONTENT_WIDTH, cy: 320040 },
        [
          {
            text: revision.branding.workspaceName,
            size: 1200,
            bold: true,
            color: MUTED,
            caps: true,
          },
        ],
      ),
      textShape(
        5,
        "Title",
        { x: MARGIN, y: 1508760, cx: CONTENT_WIDTH, cy: 1965960 },
        [
          {
            text: revision.title,
            size: bodySize(revision.title, 4000, 2800),
            bold: true,
            color: INK,
          },
        ],
      ),
      textShape(
        6,
        "Summary",
        { x: MARGIN, y: 2971800, cx: Math.round(CONTENT_WIDTH * 0.78), cy: 1600200 },
        revision.summary
          ? [
              {
                text: revision.summary,
                size: bodySize(revision.summary, 1600, 1200),
                color: INK_SOFT,
              },
            ]
          : [],
      ),
      rectShape(
        7,
        "Rule",
        { x: MARGIN, y: 5303520, cx: CONTENT_WIDTH, cy: 12700 },
        palette.accentEdge,
      ),
      textShape(
        8,
        "Meta",
        { x: MARGIN, y: 5455920, cx: CONTENT_WIDTH, cy: 685800 },
        [
          {
            text: [
              `Revision ${revision.revisionNumber}`,
              `Published ${formatLongDate(revision.publishedAt)}`,
              ...(stepTotal ? [`${stepTotal} steps`] : []),
            ].join("   ·   "),
            size: 1200,
            bold: true,
            color: MUTED,
          },
          ...(marks.length
            ? [{ text: marks.join("   ·   "), size: 1000, color: MUTED }]
            : []),
        ],
      ),
    ],
  });

  let stepNumber = 0;
  for (const block of revision.blocks) {
    plans.push(...planBlock(block));
  }

  function planBlock(block: GuideBlock): SlidePlan[] {
    if (block.type === "heading") {
      return [
        {
          shapes: [
            accentBar(2, palette.accent),
            textShape(
              3,
              "Section label",
              { x: MARGIN, y: 2743200, cx: CONTENT_WIDTH, cy: 320040 },
              [{ text: "Section", size: 1200, bold: true, color: MUTED, caps: true }],
            ),
            textShape(
              4,
              "Section title",
              { x: MARGIN, y: 3108960, cx: CONTENT_WIDTH, cy: 1188720 },
              [
                {
                  text: block.text,
                  size: bodySize(block.text, block.level === 2 ? 3600 : 2800, 2000),
                  bold: true,
                  color: INK,
                },
              ],
            ),
            rectShape(
              5,
              "Underline",
              { x: MARGIN, y: 2606040, cx: 914400, cy: 45720 },
              palette.accent,
            ),
          ],
        },
      ];
    }

    if (block.type === "paragraph") {
      return [
        {
          shapes: [
            accentBar(2, palette.accent),
            textShape(
              3,
              "Body",
              { x: MARGIN, y: 1371600, cx: CONTENT_WIDTH, cy: 4114800 },
              [{ text: block.text, size: bodySize(block.text, 1800, 1200), color: INK_SOFT }],
            ),
          ],
        },
      ];
    }

    if (block.type === "callout") {
      const label =
        block.title ||
        (block.tone === "warning" ? "Warning" : block.tone === "success" ? "Tip" : "Note");
      return [
        {
          shapes: [
            accentBar(2, palette.accent),
            ...panel(
              3,
              { x: MARGIN, top: 2286000, cx: CONTENT_WIDTH },
              label,
              block.text,
              block.tone,
              palette,
            ),
          ],
        },
      ];
    }

    stepNumber += 1;
    const asset = block.media ? assets.get(block.media.mediaId) : undefined;
    const hasImage = Boolean(block.media && asset?.bytes);
    const textWidth = hasImage ? 4114800 : CONTENT_WIDTH;
    const shapes: string[] = [
      accentBar(2, palette.accent),
      textShape(
        3,
        "Step label",
        { x: MARGIN, y: 502920, cx: CONTENT_WIDTH, cy: 274320 },
        [
          {
            text: `Step ${stepNumber} of ${stepTotal}`,
            size: 1100,
            bold: true,
            color: palette.accentDeep,
            caps: true,
          },
        ],
      ),
      textShape(
        4,
        "Step title",
        { x: MARGIN, y: 822960, cx: CONTENT_WIDTH, cy: 822960 },
        [
          {
            text: block.title,
            size: bodySize(block.title, 2400, 1800),
            bold: true,
            color: INK,
          },
        ],
      ),
      textShape(
        5,
        "Instructions",
        { x: MARGIN, y: 1828800, cx: textWidth, cy: 2286000 },
        [
          {
            text: block.instructions,
            size: bodySize(block.instructions, 1500, 1100),
            color: INK_SOFT,
          },
          ...(block.systemReference
            ? [
                {
                  text: `System: ${block.systemReference.name}`,
                  size: 1100,
                  color: MUTED,
                  spaceBefore: 800,
                },
              ]
            : []),
        ],
      ),
    ];

    // Result panels stack upward from the foot of the slide.
    let panelBottom = 6172200;
    if (block.requiresConfirmation) {
      const body = "Confirm the expected result before continuing.";
      shapes.push(
        ...panel(
          10,
          { x: MARGIN, bottom: panelBottom, cx: textWidth },
          "Confirmation required",
          body,
          "warning",
          palette,
        ),
      );
      panelBottom -= panelHeight(body, bodySize(body, 1300, 1000), textWidth) + 137160;
    }
    if (block.expectedResult) {
      shapes.push(
        ...panel(
          6,
          { x: MARGIN, bottom: panelBottom, cx: textWidth },
          "Expected result",
          block.expectedResult,
          "success",
          palette,
        ),
      );
    }

    if (block.media && !hasImage) {
      shapes.push(
        textShape(
          8,
          "Missing screenshot",
          { x: MARGIN, y: 6172200, cx: CONTENT_WIDTH, cy: 274320 },
          [{ text: "Screenshot unavailable in this export", size: 1000, color: MUTED }],
        ),
      );
    }

    return [
      {
        shapes,
        ...(hasImage ? { asset, media: block.media } : {}),
      },
    ];
  }

  // ---- Package -------------------------------------------------------------
  const files: ZipEntry[] = [];
  const mediaExtensions = new Set<string>();

  plans.forEach((plan, index) => {
    const slideNumber = index + 1;
    const shapes = [...plan.shapes];
    const slideRelationships = [
      relationship("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
    ];

    if (plan.asset?.bytes) {
      const extension = plan.asset.mimeType === "image/jpeg" ? "jpeg" : "png";
      mediaExtensions.add(extension);
      const name = `image${slideNumber}.${extension}`;
      files.push({ name: `ppt/media/${name}`, data: plan.asset.bytes });
      slideRelationships.push(relationship("rId2", "image", `../media/${name}`));

      const media = plan.media;
      const crop = media?.crop;
      const aspect = media
        ? crop
          ? (media.width * crop.width) / (media.height * crop.height)
          : media.width / media.height
        : 16 / 9;
      // Fit the cropped screenshot inside the right-hand frame, never stretch it.
      const frame = { x: 5257800, y: 1051560, cx: 6248400, cy: 4525963 };
      let width = frame.cx;
      let height = width / aspect;
      if (height > frame.cy) {
        height = frame.cy;
        width = height * aspect;
      }
      const placed: Box = {
        x: frame.x + (frame.cx - width) / 2,
        y: frame.y + (frame.cy - height) / 2,
        cx: width,
        cy: height,
      };
      shapes.push(
        pictureShape(9, "rId2", placed, crop, media?.altText ?? "Screenshot"),
      );
      if (media) shapes.push(...annotationShapes(20, placed, media));
    }

    files.push({
      name: `ppt/slides/slide${slideNumber}.xml`,
      data: utf8(slideXml(shapes)),
    });
    files.push({
      name: `ppt/slides/_rels/slide${slideNumber}.xml.rels`,
      data: utf8(relationships(slideRelationships)),
    });
  });

  files.push(
    { name: "ppt/theme/theme1.xml", data: utf8(THEME_XML) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: utf8(SLIDE_MASTER_XML) },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: utf8(
        relationships([
          relationship("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
          relationship("rId2", "theme", "../theme/theme1.xml"),
        ]),
      ),
    },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: utf8(SLIDE_LAYOUT_XML) },
    {
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: utf8(
        relationships([
          relationship("rId1", "slideMaster", "../slideMasters/slideMaster1.xml"),
        ]),
      ),
    },
  );

  const slideIds = plans
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`)
    .join("");
  files.push({
    name: "ppt/presentation.xml",
    data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_RELATIONSHIPS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/><p:notesSz cx="${SLIDE_HEIGHT}" cy="${SLIDE_WIDTH}"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1600"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`),
  });
  files.push({
    name: "ppt/_rels/presentation.xml.rels",
    data: utf8(
      relationships([
        relationship("rId1", "slideMaster", "slideMasters/slideMaster1.xml"),
        ...plans.map((_, index) =>
          relationship("rId" + (index + 2), "slide", `slides/slide${index + 1}.xml`),
        ),
        relationship(`rId${plans.length + 2}`, "theme", "theme/theme1.xml"),
      ]),
    ),
  });

  const exportedAt = watermark?.exportedAt ?? revision.publishedAt;
  files.push(
    {
      name: "docProps/core.xml",
      data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(revision.title)}</dc:title><dc:creator>${xml(revision.branding.workspaceName)}</dc:creator><cp:lastModifiedBy>KnowHow</cp:lastModifiedBy><cp:revision>${revision.revisionNumber}</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${xml(new Date(revision.publishedAt).toISOString())}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${xml(new Date(exportedAt).toISOString())}</dcterms:modified></cp:coreProperties>`),
    },
    {
      name: "docProps/app.xml",
      data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Company>${xml(revision.branding.workspaceName)}</Company><Slides>${plans.length}</Slides><Application>KnowHow</Application></Properties>`),
    },
    {
      name: "_rels/.rels",
      data: utf8(
        relationships([
          relationship("rId1", "officeDocument", "ppt/presentation.xml"),
          `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`,
          relationship("rId3", "extended-properties", "docProps/app.xml"),
        ]),
      ),
    },
  );

  const defaults = [
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `<Default Extension="xml" ContentType="application/xml"/>`,
    ...[...mediaExtensions].map(
      (extension) =>
        `<Default Extension="${extension}" ContentType="image/${extension === "jpeg" ? "jpeg" : "png"}"/>`,
    ),
  ].join("");
  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
    ...plans.map(
      (_, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    ),
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`,
  ].join("");
  files.unshift({
    name: "[Content_Types].xml",
    data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}${overrides}</Types>`),
  });

  try {
    return zipStore(files);
  } catch (error) {
    throw new GuideRendererError("RENDER_FAILED", "PowerPoint export failed.", {
      format: "pptx",
      cause: error,
    });
  }
}
