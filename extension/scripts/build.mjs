import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const expectedExtensionId = "phbofjenfnnnnndghhinoldlfbpaedpo";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chromeExtensionId(publicKey) {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex")
    .slice(0, 32);
  return Array.from(digest, (character) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(character, 16)),
  ).join("");
}

function resolveExtensionRoot() {
  const fromScript = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (existsSync(resolve(fromScript, "manifest.json"))) return fromScript;
  const fromCwd = resolve(process.cwd(), "extension");
  if (existsSync(resolve(fromCwd, "manifest.json"))) return fromCwd;
  throw new Error("Could not locate the KnowHow Capture extension.");
}

function parseKnowHowOrigin(value, storeBuild) {
  const origin = new URL(value);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        (origin.hostname === "localhost" || origin.hostname === "127.0.0.1")
      ))
  ) {
    throw new Error(
      "KNOWHOW_EXTENSION_ORIGIN must be an exact HTTPS origin (or localhost for development).",
    );
  }
  if (storeBuild && origin.protocol !== "https:") {
    throw new Error("Store builds require an HTTPS KnowHow origin.");
  }
  return origin;
}

async function listFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push({
        absolute,
        name: relative(root, absolute).split(sep).join("/"),
      });
    } else {
      throw new Error("Unsupported extension package entry: " + absolute);
    }
  }
  return files;
}

async function deterministicZip(root) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const files = await listFiles(root);

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const contents = await readFile(file.absolute);
    const compressed = deflateRawSync(contents, { level: 9 });
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

/**
 * @param {{
 *   store?: boolean;
 *   origin?: string;
 *   persist?: boolean;
 *   extensionRoot?: string;
 * }} [options]
 */
export async function buildKnowHowCapturePackage({
  store = false,
  origin: originValue,
  persist = true,
  extensionRoot: extensionRootValue,
} = {}) {
  const storeBuild = store === true;
  const configuredOrigin =
    originValue?.trim() || process.env.KNOWHOW_EXTENSION_ORIGIN?.trim();
  if (storeBuild && !configuredOrigin) {
    throw new Error("KNOWHOW_EXTENSION_ORIGIN is required for a store build.");
  }
  const origin = parseKnowHowOrigin(
    configuredOrigin || "http://localhost:3001",
    storeBuild,
  );
  const extensionRoot = extensionRootValue
    ? resolve(extensionRootValue)
    : resolveExtensionRoot();
  if (!existsSync(resolve(extensionRoot, "manifest.json"))) {
    throw new Error("Could not locate the KnowHow Capture extension.");
  }
  const outputDirectory = resolve(extensionRoot, "..", "outputs", "extension");
  const persistedDestination = resolve(extensionRoot, "dist");
  if (
    persist &&
    (dirname(persistedDestination) !== extensionRoot ||
      persistedDestination === extensionRoot)
  ) {
    throw new Error("Refusing to build outside extension/dist.");
  }

  const workDirectory = persist
    ? persistedDestination
    : await mkdtemp(resolve(tmpdir(), "knowhow-capture-"));

  try {
    const manifestPath = resolve(extensionRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const originMatch = `${origin.origin}/*`;
    manifest.host_permissions = [originMatch];
    manifest.externally_connectable = { matches: [originMatch] };
    const filename = `knowhow-capture-${manifest.version}-${storeBuild ? "store" : "development"}.zip`;
    const archivePath = resolve(outputDirectory, filename);
    if (persist && dirname(archivePath) !== outputDirectory) {
      throw new Error("Refusing to package outside outputs/extension.");
    }
    const contentSource = await readFile(
      resolve(extensionRoot, "src/content/capture.js"),
      "utf8",
    );
    const backgroundSource = await readFile(
      resolve(extensionRoot, "src/background/index.js"),
      "utf8",
    );
    const captureStoreSource = await readFile(
      resolve(extensionRoot, "src/core/capture-store.js"),
      "utf8",
    );
    const typedFieldSource = await readFile(
      resolve(extensionRoot, "src/content/typed-fields.js"),
      "utf8",
    );

    if (manifest.manifest_version !== 3) {
      throw new Error("KnowHow Capture must remain a Manifest V3 extension.");
    }
    if (
      typeof manifest.key !== "string" ||
      chromeExtensionId(manifest.key) !== expectedExtensionId
    ) {
      throw new Error(
        "KnowHow Capture must retain the manifest key for extension ID " +
          expectedExtensionId +
          ".",
      );
    }
    if (manifest.incognito !== "not_allowed") {
      throw new Error("Incognito capture must remain disabled.");
    }
    if (manifest.content_scripts?.length) {
      throw new Error("Static content scripts are prohibited.");
    }
    if (manifest.host_permissions?.includes("<all_urls>")) {
      throw new Error("Required <all_urls> access is prohibited.");
    }
    if (
      JSON.stringify(manifest.optional_host_permissions || []) !==
      JSON.stringify(["<all_urls>"])
    ) {
      throw new Error(
        "Website capture access must remain an explicit optional <all_urls> request.",
      );
    }
    if (
      (manifest.content_scripts || []).some((entry) =>
        (entry.matches || []).includes("<all_urls>"),
      )
    ) {
      throw new Error("Static <all_urls> content injection is prohibited.");
    }
    for (const forbiddenPermission of [
      "clipboardRead",
      "desktopCapture",
      "tabCapture",
    ]) {
      if (manifest.permissions?.includes(forbiddenPermission)) {
        throw new Error("Forbidden permission: " + forbiddenPermission);
      }
    }
    if (/clipboard/i.test(contentSource)) {
      throw new Error(
        "Content capture contains a forbidden clipboard operation.",
      );
    }
    // Capturing what an author types is the whole point of a "type this here"
    // step, so the content script does read a field's contents — but from
    // exactly one function, and only for fields it has already classified as
    // ordinary. These checks pin that shape in place: a stray `.value` read
    // anywhere else in the script, or a `typedFieldText` that stops refusing
    // every classification but "text", fails the build rather than shipping.
    const fieldReaderStart = contentSource.indexOf(
      "function typedFieldText(element, kind)",
    );
    const fieldReaderEnd = contentSource.indexOf("\n  }", fieldReaderStart + 1);
    if (fieldReaderStart < 0 || fieldReaderEnd < 0) {
      throw new Error("Content capture must read typed text from typedFieldText.");
    }
    const fieldReader = contentSource.slice(fieldReaderStart, fieldReaderEnd);
    if (!/if \(kind !== "text"\) return "";/.test(fieldReader)) {
      throw new Error(
        "typedFieldText must refuse every field classification except \"text\".",
      );
    }
    if (!/return sanitizedText\(raw\);/.test(fieldReader)) {
      throw new Error(
        "Typed text must pass through the session redaction policy before it leaves the page.",
      );
    }
    const fieldValueReads = contentSource.match(/\.value\b/g) || [];
    if (
      fieldValueReads.length !== (fieldReader.match(/\.value\b/g) || []).length
    ) {
      throw new Error(
        "Content capture may read a form field only inside typedFieldText.",
      );
    }
    // The rule that decides which fields may be read lives in its own script so
    // it can be tested without a browser. These checks keep each exclusion in
    // place; the tests in scripts/test-capture-core.mjs cover what they mean.
    for (const requiredFieldGuard of [
      ['password fields', 'if (isTextInput && inputType === "password") return "password";'],
      ['password autocomplete', 'if (autocomplete.includes("password")) return "password";'],
      ['username fields', 'if (autocomplete === "username") return "username";'],
      ["credential forms", "signals?.inCredentialForm === true"],
      ["credential-named fields", "CREDENTIAL_FIELD_HINT.test(hint)"],
      ["one-time codes and card numbers", 'autocomplete.startsWith("cc-")'],
    ]) {
      if (!typedFieldSource.includes(requiredFieldGuard[1])) {
        throw new Error(
          "Field classification must keep its " +
            requiredFieldGuard[0] +
            " exclusion.",
        );
      }
    }
    if (!contentSource.includes("typedFields.classifyField({")) {
      throw new Error(
        "Content capture must classify a field before reading it.",
      );
    }
    const keyboardListeners =
      contentSource.match(/addEventListener\(\s*["']key(?:down|up|press)/g) || [];
    const pickerEscapeListener =
      'document.addEventListener("keydown", onPickerKeyDown, true)';
    const pickerHandlerStart = contentSource.indexOf(
      "function onPickerKeyDown(event)",
    );
    const pickerHandlerEnd = contentSource.indexOf(
      "\n  function ",
      pickerHandlerStart + 1,
    );
    const pickerHandler = contentSource.slice(
      pickerHandlerStart,
      pickerHandlerEnd < 0 ? undefined : pickerHandlerEnd,
    );
    if (
      keyboardListeners.length !== 2 ||
      !contentSource.includes(pickerEscapeListener) ||
      pickerHandlerStart < 0 ||
      !pickerHandler.includes('event.key !== "Escape"') ||
      /send\s*\(|CAPTURE|record/i.test(pickerHandler)
    ) {
      throw new Error(
        "Content capture may listen for keys only to close the element picker and to recognise a shortcut.",
      );
    }
    // The second listener records keyboard shortcuts. It is allowed to exist
    // only in this shape: every decision about what may be recorded belongs to
    // classifyShortcut, which refuses bare printable keys and password fields,
    // and the handler itself never reaches for a field's contents.
    const shortcutListener =
      'document.addEventListener("keydown", onShortcutKeyDown, true)';
    const shortcutHandlerStart = contentSource.indexOf(
      "function onShortcutKeyDown(event)",
    );
    const shortcutHandlerEnd = contentSource.indexOf(
      "\n  function ",
      shortcutHandlerStart + 1,
    );
    const shortcutHandler = contentSource.slice(
      shortcutHandlerStart,
      shortcutHandlerEnd < 0 ? undefined : shortcutHandlerEnd,
    );
    if (
      !contentSource.includes(shortcutListener) ||
      shortcutHandlerStart < 0 ||
      !shortcutHandler.includes("typedFields.classifyShortcut({") ||
      /\.value\b/.test(shortcutHandler)
    ) {
      throw new Error(
        "Keyboard shortcut capture must classify every key press through classifyShortcut.",
      );
    }
    for (const requiredShortcutGuard of [
      ["password fields", 'if (signals?.fieldKind === "password") return null;'],
      ["held keys", "if (signals?.repeat === true) return null;"],
      ["bare printable keys", "if (!named) return null;"],
    ]) {
      if (!typedFieldSource.includes(requiredShortcutGuard[1])) {
        throw new Error(
          "Shortcut classification must keep its " +
            requiredShortcutGuard[0] +
            " exclusion.",
        );
      }
    }
    const captureVisibleTabCalls =
      backgroundSource.match(/chrome\.tabs\.captureVisibleTab\s*\(/g) || [];
    if (captureVisibleTabCalls.length !== 1) {
      throw new Error(
        "captureVisibleTab must remain isolated to one guarded code path.",
      );
    }
    if (/dataUrl/.test(captureStoreSource)) {
      throw new Error("Raw screenshot data must never enter capture storage.");
    }

    if (persist) {
      await rm(workDirectory, { recursive: true, force: true });
    }
    await mkdir(workDirectory, { recursive: true });
    await cp(resolve(extensionRoot, "src"), resolve(workDirectory, "src"), {
      recursive: true,
    });
    const builtConfigPath = resolve(workDirectory, "src", "core", "config.js");
    const builtConfig = await readFile(builtConfigPath, "utf8");
    const configuredSource = builtConfig.replace(
      /export const KNOWHOW_ORIGIN\s*=\s*"[^"]+";/,
      `export const KNOWHOW_ORIGIN = ${JSON.stringify(origin.origin)};`,
    );
    if (configuredSource === builtConfig && !builtConfig.includes(origin.origin)) {
      throw new Error("Could not configure the extension application origin.");
    }
    await writeFile(builtConfigPath, configuredSource, "utf8");
    const popupFontDirectory = resolve(workDirectory, "src", "popup", "fonts");
    await mkdir(popupFontDirectory, { recursive: true });
    await cp(
      resolve(
        extensionRoot,
        "..",
        "node_modules",
        "@fontsource-variable",
        "google-sans-flex",
        "files",
        "google-sans-flex-latin-wght-normal.woff2",
      ),
      resolve(popupFontDirectory, "google-sans-flex-latin-wght-normal.woff2"),
    );
    await writeFile(
      resolve(workDirectory, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );

    const zip = await deterministicZip(workDirectory);
    if (persist) {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(archivePath, zip);
      console.log("Built unpacked extension at " + workDirectory);
      console.log("Packaged deterministic download at " + archivePath);
      console.log("Extension channel: " + (storeBuild ? "store" : "development"));
      console.log("KnowHow origin: " + origin.origin);
    }
    return {
      zip,
      filename,
      origin: origin.origin,
      version: manifest.version,
    };
  } finally {
    if (!persist) {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1]?.includes("build.mjs")) {
  await buildKnowHowCapturePackage({
    store: process.argv.includes("--store"),
  });
}
