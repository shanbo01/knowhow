(() => {
  "use strict";

  const INSTANCE_KEY = "__KNOWHOW_CAPTURE_INSTANCE_V1__";
  if (globalThis[INSTANCE_KEY]) {
    globalThis[INSTANCE_KEY].announce();
    return;
  }

  const state = {
    sessionId: null,
    status: "idle",
    policy: {},
    documentId: null,
    navigationKey: null,
  };
  const geometry = globalThis.__KNOWHOW_BLUR_GEOMETRY__;
  if (!geometry?.normalizeAndMergeMasks || !geometry.maskRadius) return;
  const typedFields = globalThis.__KNOWHOW_TYPED_FIELDS__;
  if (!typedFields?.classifyField || !typedFields.typedStepCopy) return;
  let pendingPointer = null;
  let lastCommittedClick = null;
  let preparedFrames = [];
  let preparedFrameTimer = null;
  let preparedFrameInFlight = null;
  let preparedFrameNeedsSettle = true;
  let visualEpoch = 0;

  const POINTER_MOVE_TOLERANCE = 6;
  const POINTER_COMMIT_WINDOW_MS = 3_000;
  const DOUBLE_CLICK_WINDOW_MS = 420;
  const PREPARED_FRAME_MAX_AGE_MS = 2_000;
  // Chrome allows two captureVisibleTab calls per second across the whole
  // extension. Pre-warming a frame is speculative work, so it must leave most
  // of that budget for the screenshot that belongs to a click the author
  // actually made. These bounds keep pre-warming to roughly one capture per
  // second on a busy page instead of one per DOM mutation batch.
  const PREPARED_FRAME_QUIET_MS = 220;
  const PREPARED_FRAME_MAX_WAIT_MS = 700;
  const PREPARED_FRAME_MIN_SPACING_MS = 600;
  let lastPreparedFrameAt = 0;
  let preparedFrameWantedSince = 0;

  // A message that never reaches the worker is a step the author performed and
  // KnowHow silently forgot. Manifest V3 tears the worker down aggressively, so
  // the first send after an idle moment routinely rejects with "Could not
  // establish connection" while Chrome is still booting it back up. Every
  // handler on the other side is keyed by interactionId and is idempotent, so a
  // retried message either lands first or is a no-op.
  const FATAL_SEND_PATTERN = /context invalidated|Extension context/i;
  const SEND_RETRY_DELAYS_MS = [20, 60, 180, 400];

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function send(message, { retries = SEND_RETRY_DELAYS_MS.length } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage(message);
        if (response !== undefined) return response;
      } catch (error) {
        // The extension was reloaded or disabled: this document's script is
        // orphaned and no retry can succeed.
        if (FATAL_SEND_PATTERN.test(String(error?.message || error))) return null;
      }
      if (attempt >= retries) return null;
      await sleep(SEND_RETRY_DELAYS_MS[attempt] ?? 400);
    }
  }

  function sanitizedText(value) {
    let output = String(value || "").replace(/\s+/g, " ").trim();
    const replacements = [
      [
        state.policy.redactEmails === true,
        /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
      ],
      [
        state.policy.redactPhoneNumbers === true,
        /(?:\+?\d[\d\s().-]{7,}\d)/g,
      ],
      [
        state.policy.redactFinancialNumbers === true,
        /(?:\b\d[ -]*?){13,19}\b/g,
      ],
      [
        state.policy.redactIds === true,
        /\b(?=[A-Z0-9-]{8,}\b)(?=(?:[A-Z0-9-]*\d){2,})[A-Z0-9][A-Z0-9-]{7,}\b/gi,
      ],
      [state.policy.redactAllNumbers === true, /\d+/g],
    ];
    for (const [enabled, pattern] of replacements) {
      if (enabled) output = output.replace(pattern, "[redacted]");
    }
    return output.replace(/\s+/g, " ").trim().slice(0, 100);
  }

  function sanitizedPageUrl() {
    const segments = location.pathname.split("/").map((segment) => {
      const decoded = (() => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })();
      const urlFindings = rangeFindings(decoded, {
        redactEmails: state.policy.redactEmails === true,
        redactPhoneNumbers: state.policy.redactPhoneNumbers === true,
        redactFinancialNumbers: state.policy.redactFinancialNumbers === true,
        redactIds: false,
        redactAllNumbers: false,
        redactCommonNames: false,
      });
      return urlFindings.length
        ? "[redacted]"
        : encodeURIComponent(decoded.slice(0, 100));
    });
    return location.origin + segments.join("/");
  }

  let occluderBoxes = null;
  let occluderBoxesAt = 0;
  const lastScrollerOffset = new WeakMap();
  const watchedScrollers = new WeakSet();

  function intersectBoxes(left, right) {
    const next = {
      left: Math.max(left.left, right.left),
      top: Math.max(left.top, right.top),
      right: Math.min(left.right, right.right),
      bottom: Math.min(left.bottom, right.bottom),
    };
    if (next.right <= next.left || next.bottom <= next.top) return null;
    return next;
  }

  function clientBox(rect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
  }

  function clipsOverflow(value) {
    return value === "auto" || value === "scroll" || value === "hidden" || value === "clip";
  }

  function clipToOverflowAncestors(box, element) {
    if (!(element instanceof Element)) return box;
    let node = element.parentElement;
    let hops = 0;
    while (node && hops < 24) {
      hops += 1;
      if (node === document.documentElement || node === document.body) {
        node = node.parentElement;
        continue;
      }
      const style = getComputedStyle(node);
      const clipX = clipsOverflow(style.overflowX);
      const clipY = clipsOverflow(style.overflowY);
      if (clipX || clipY) {
        const rect = node.getBoundingClientRect();
        box = intersectBoxes(box, {
          left: clipX ? rect.left : box.left,
          top: clipY ? rect.top : box.top,
          right: clipX ? rect.right : box.right,
          bottom: clipY ? rect.bottom : box.bottom,
        });
        if (!box) return null;
      }
      node = node.parentElement;
    }
    return box;
  }

  function isTopChrome(box) {
    const height = box.bottom - box.top;
    const width = box.right - box.left;
    return (
      box.top < innerHeight * 0.4 &&
      height >= 20 &&
      height <= innerHeight * 0.4 &&
      width >= innerWidth * 0.4
    );
  }

  function isLeftChrome(box) {
    const height = box.bottom - box.top;
    const width = box.right - box.left;
    return (
      box.left < innerWidth * 0.12 &&
      width >= 40 &&
      width <= innerWidth * 0.4 &&
      height >= innerHeight * 0.3
    );
  }

  function addOccluder(element, seen, boxes) {
    if (!(element instanceof Element) || seen.has(element)) return;
    if (element.closest("[data-knowhow-ui],[data-knowhow-overlay]")) return;
    seen.add(element);
    const position = getComputedStyle(element).position;
    if (position !== "fixed" && position !== "sticky") return;
    const box = clientBox(element.getBoundingClientRect());
    if (!isTopChrome(box) && !isLeftChrome(box)) return;
    boxes.push({ ...box, element });
  }

  function collectOccluderBoxes() {
    const now = performance.now();
    if (occluderBoxes && now - occluderBoxesAt < 80) return occluderBoxes;
    const boxes = [];
    const seen = new Set();
    try {
      for (const element of document.querySelectorAll(
        "header, nav, [role=banner], [role=navigation], [role=search], [role=tablist], [role=toolbar]",
      )) {
        let node = element;
        let hops = 0;
        while (node && hops < 8) {
          addOccluder(node, seen, boxes);
          node = node.parentElement;
          hops += 1;
        }
      }
    } catch {
      // Some documents reject querySelectorAll; skip chrome clipping then.
    }
    for (const element of document.body?.children || []) {
      addOccluder(element, seen, boxes);
    }
    for (const element of document.documentElement?.children || []) {
      addOccluder(element, seen, boxes);
    }
    occluderBoxes = boxes;
    occluderBoxesAt = now;
    return boxes;
  }

  function clipAgainstOccludingChrome(box, owner) {
    for (const chrome of collectOccluderBoxes()) {
      if (owner instanceof Element && chrome.element.contains(owner)) continue;
      const overlap = intersectBoxes(box, chrome);
      if (!overlap) continue;
      if (isTopChrome(chrome) && box.top < chrome.bottom) {
        box = { ...box, top: Math.max(box.top, chrome.bottom) };
      }
      if (isLeftChrome(chrome) && box.left < chrome.right) {
        box = { ...box, left: Math.max(box.left, chrome.right) };
      }
      if (box.right <= box.left || box.bottom <= box.top) return null;
    }
    return box;
  }

  const SURFACE_HOST_REASONS = new Set([
    "embedded-frame",
    "form-field",
    "password-field",
    "image",
    "manual-element",
  ]);
  const MAX_LIVE_HOSTS = 240;
  const MAX_LIVE_OVERLAYS = 160;
  const LOOSE_HOST_TAGS = new Set([
    "HTML",
    "BODY",
    "MAIN",
    "HEADER",
    "FOOTER",
    "NAV",
    "SECTION",
    "ARTICLE",
    "ASIDE",
    "TABLE",
    "TBODY",
    "THEAD",
    "TFOOT",
  ]);

  function isDocumentHosted(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const root = element.getRootNode();
    return root === document;
  }

  const PHRASING_HOST_TAGS = new Set([
    "SPAN",
    "A",
    "B",
    "I",
    "EM",
    "STRONG",
    "SMALL",
    "MARK",
    "TIME",
    "LABEL",
    "CITE",
    "CODE",
    "ABBR",
    "DATA",
    "Q",
    "S",
    "U",
    "VAR",
  ]);
  const TABLE_CELL_HOST_TAGS = new Set(["TD", "TH"]);

  // Inspect-element `filter: blur()` only looks right on a tight node. A row,
  // cell, or page shell would smear neighbors, so those fall back to overlays.
  function tightBlurHost(owner, ink, reason) {
    if (!(owner instanceof Element) || !isDocumentHosted(owner)) return null;
    if (owner.closest("[data-knowhow-ui],[data-knowhow-overlay]")) return null;
    if (LOOSE_HOST_TAGS.has(owner.tagName)) return null;
    const role = owner.getAttribute("role");
    if (role === "main" || role === "navigation" || role === "banner") {
      return null;
    }
    const hostBox = owner.getBoundingClientRect();
    const hostArea = Math.max(0, hostBox.width) * Math.max(0, hostBox.height);
    if (hostArea < 9) return null;
    const pageArea = Math.max(1, innerWidth * innerHeight);
    if (SURFACE_HOST_REASONS.has(reason)) {
      if (hostArea > pageArea * 0.85) return null;
      return owner;
    }
    if (role === "row" || owner.tagName === "TR") return null;
    if (
      (reason === "long-text" || reason === "table-row") &&
      (isLeafBlurHost(owner) ||
        TABLE_CELL_HOST_TAGS.has(owner.tagName) ||
        role === "cell" ||
        role === "gridcell" ||
        role === "columnheader" ||
        role === "rowheader") &&
      hostArea <= pageArea * 0.45
    ) {
      return owner;
    }
    if (hostBox.height > 160 && hostBox.height > (Number(ink?.height) || 0) * 1.8) {
      return null;
    }
    const inkWidth = Math.max(1, Number(ink?.width) || hostBox.width);
    const inkHeight = Math.max(1, Number(ink?.height) || hostBox.height);
    const inkArea = inkWidth * inkHeight;
    const tightWidth = hostBox.width <= inkWidth * 1.45;
    const tightArea = hostArea <= inkArea * 2.4;
    const lineBox =
      tightWidth && hostBox.height <= Math.max(48, inkHeight * 2.8);
    const phrasingLine =
      PHRASING_HOST_TAGS.has(owner.tagName) &&
      hostBox.height <= Math.max(48, inkHeight * 3) &&
      hostBox.width <= innerWidth * 0.92;
    // Numbers and IDs are often direct text inside a small div, badge, or
    // table cell. Rejecting that compact line box creates the old opaque
    // overlay even though filtering the host is both tighter and more faithful
    // to Inspect element's `filter: blur()` behavior.
    const compactTextContainer =
      !SURFACE_HOST_REASONS.has(reason) &&
      hostBox.height <= 72 &&
      hostBox.width <= Math.min(640, innerWidth * 0.6) &&
      hostArea <= pageArea * 0.12;
    if (!tightArea && !lineBox && !phrasingLine && !compactTextContainer) {
      return null;
    }
    return owner;
  }

  function isLeafBlurHost(owner) {
    if (!(owner instanceof Element)) return false;
    if (owner.childElementCount === 0) return true;
    return [...owner.childNodes].every((node) => {
      if (node.nodeType === Node.TEXT_NODE) return true;
      return (
        node.nodeType === Node.ELEMENT_NODE &&
        (node.tagName === "BR" || node.tagName === "WBR")
      );
    });
  }

  // `hostOverride` is how a caller that already decided the cover for a whole
  // run of rectangles forces every one of them to agree. Pass `undefined` to
  // let this rectangle decide for itself.
  function maskFromClientRect(rect, reason, owner, hostOverride) {
    const unclipped = clientBox(rect);
    const inkWidth = Math.max(0, unclipped.right - unclipped.left);
    const inkHeight = Math.max(0, unclipped.bottom - unclipped.top);
    if (inkWidth < 3 || inkHeight < 3) return null;
    const host =
      hostOverride !== undefined
        ? hostOverride
        : tightBlurHost(owner, {
            width: inkWidth,
            height: inkHeight,
          }, reason);
    let box = intersectBoxes(unclipped, {
      left: 0,
      top: 0,
      right: innerWidth,
      bottom: innerHeight,
    });
    if (box) box = clipToOverflowAncestors(box, owner);
    if (box) box = clipAgainstOccludingChrome(box, owner);
    if (box) {
      const width = box.right - box.left;
      const height = box.bottom - box.top;
      if (width >= 3 && height >= 3) {
        const mask = { x: box.left, y: box.top, width, height, reason };
        if (host) mask.host = host;
        return mask;
      }
    }
    if (!host) return null;
    // Element filters do not need a paint box. Keep the host so in-DOM rows
    // below the fold are already blurred when they scroll in.
    return {
      x: unclipped.left,
      y: unclipped.top,
      width: inkWidth,
      height: inkHeight,
      reason,
      host,
    };
  }

  function rectFor(element, reason, owner) {
    const source =
      owner instanceof Element
        ? owner
        : element instanceof Element
          ? element
          : null;
    return maskFromClientRect(element.getBoundingClientRect(), reason, source);
  }

  function contentRectFor(element, reason) {
    const outer = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const leftInset =
      (Number.parseFloat(style.borderLeftWidth) || 0) +
      Math.min(10, Number.parseFloat(style.paddingLeft) || 3);
    const rightInset =
      (Number.parseFloat(style.borderRightWidth) || 0) +
      Math.min(10, Number.parseFloat(style.paddingRight) || 3);
    const topInset =
      (Number.parseFloat(style.borderTopWidth) || 0) +
      Math.min(5, Number.parseFloat(style.paddingTop) || 2);
    const bottomInset =
      (Number.parseFloat(style.borderBottomWidth) || 0) +
      Math.min(5, Number.parseFloat(style.paddingBottom) || 2);
    return maskFromClientRect(
      {
        left: outer.left + leftInset,
        top: outer.top + topInset,
        right: outer.right - rightInset,
        bottom: outer.bottom - bottomInset,
      },
      reason,
      element,
    );
  }

  function canonicalScroller(node) {
    if (
      !node ||
      node === document ||
      node === document.body ||
      node === document.documentElement
    ) {
      return document.scrollingElement || document.documentElement;
    }
    return node;
  }

  function scrollerOffsets(scroller) {
    const node = canonicalScroller(scroller);
    if (
      node === document.scrollingElement ||
      node === document.documentElement
    ) {
      return {
        x: Number(globalThis.scrollX) || 0,
        y: Number(globalThis.scrollY) || 0,
      };
    }
    return {
      x: Number(node.scrollLeft) || 0,
      y: Number(node.scrollTop) || 0,
    };
  }

  function rememberScroller(scroller) {
    if (!scroller) return;
    const node = canonicalScroller(scroller);
    lastScrollerOffset.set(node, scrollerOffsets(node));
    watchScroller(node);
  }

  function watchScroller(scroller) {
    const node = canonicalScroller(scroller);
    if (!(node instanceof Element) || watchedScrollers.has(node)) return;
    if (
      node === document.documentElement ||
      node === document.body ||
      node === document.scrollingElement
    ) {
      return;
    }
    watchedScrollers.add(node);
    node.addEventListener("scroll", onLiveOverlayScroll, { passive: true });
  }

  function nearestScroller(element) {
    let node = element instanceof Element ? element : null;
    while (
      node &&
      node !== document.body &&
      node !== document.documentElement
    ) {
      const style = getComputedStyle(node);
      if (
        style.overflowY === "auto" ||
        style.overflowY === "scroll" ||
        style.overflowX === "auto" ||
        style.overflowX === "scroll"
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function pageElementFromPoint(x, y) {
    const stack =
      typeof document.elementsFromPoint === "function"
        ? document.elementsFromPoint(x, y)
        : [document.elementFromPoint(x, y)];
    return (
      stack.find(
        (node) =>
          node instanceof Element &&
          !node.closest("[data-knowhow-ui],[data-knowhow-overlay]"),
      ) || null
    );
  }

  function scrollParentForMask(mask) {
    const x = Math.min(innerWidth - 1, Math.max(0, mask.x + mask.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(0, mask.y + mask.height / 2));
    return nearestScroller(pageElementFromPoint(x, y));
  }

  function rememberOverflowScrollers() {
    rememberScroller(document.scrollingElement || document.documentElement);
    const root = document.body || document.documentElement;
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let hops = 0;
    let found = 0;
    let node;
    while ((node = walker.nextNode()) && hops < 800 && found < 40) {
      hops += 1;
      if (!(node instanceof Element)) continue;
      const style = getComputedStyle(node);
      if (
        style.overflowY === "auto" ||
        style.overflowY === "scroll" ||
        style.overflowX === "auto" ||
        style.overflowX === "scroll"
      ) {
        rememberScroller(node);
        found += 1;
      }
    }
  }

  function scrollerClipBox(scroller) {
    const node = canonicalScroller(scroller);
    if (
      node === document.scrollingElement ||
      node === document.documentElement ||
      !(node instanceof Element)
    ) {
      return { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    }
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
  }

  function observableRoots() {
    const roots = [document];
    const queue = [document.documentElement];
    let visited = 0;
    while (queue.length && visited < 1_500) {
      const element = queue.shift();
      if (!(element instanceof Element)) continue;
      visited += 1;
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        queue.push(...element.shadowRoot.children);
      }
      queue.push(...element.children);
    }
    return roots;
  }

  function queryAllOpenRoots(selector) {
    const found = [];
    for (const root of observableRoots()) {
      found.push(...root.querySelectorAll(selector));
    }
    return [...new Set(found)];
  }

  function viewportSnapshot() {
    const visual = globalThis.visualViewport;
    return {
      width: Math.max(1, innerWidth),
      height: Math.max(1, innerHeight),
      devicePixelRatio: Math.max(1, Number(globalThis.devicePixelRatio) || 1),
      scrollX: Number(globalThis.scrollX) || 0,
      scrollY: Number(globalThis.scrollY) || 0,
      ...(visual
        ? {
          visualViewport: {
            offsetX: Number(visual.offsetLeft) || 0,
            offsetY: Number(visual.offsetTop) || 0,
            width: Math.max(1, Number(visual.width) || innerWidth),
            height: Math.max(1, Number(visual.height) || innerHeight),
            scale: Math.max(0.01, Number(visual.scale) || 1),
          },
        }
        : {}),
    };
  }

  function viewportKey(viewport = viewportSnapshot()) {
    return [
      Math.round(viewport.width),
      Math.round(viewport.height),
      Math.round(viewport.scrollX || 0),
      Math.round(viewport.scrollY || 0),
      Number(viewport.devicePixelRatio || 1).toFixed(2),
    ].join(":");
  }

  function inPage(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function visible(element) {
    if (!inPage(element)) return false;
    const rect = element.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    );
  }

  function maskIntersectsViewport(mask) {
    if (!mask) return false;
    const x = Number(mask.x);
    const y = Number(mask.y);
    const width = Number(mask.width);
    const height = Number(mask.height);
    return (
      width > 0 &&
      height > 0 &&
      x + width > 0 &&
      y + height > 0 &&
      x < innerWidth &&
      y < innerHeight
    );
  }

  function formFieldMasks() {
    if (state.policy.smartBlurEnabled !== true) return [];
    const selectors = [];
    if (state.policy.redactFormFields === true) {
      selectors.push(
        "input[type=password]",
        "[autocomplete*=password]",
        "[autocomplete=one-time-code]",
        "[autocomplete=cc-number]",
        "[data-knowhow-redact]",
        "input:not([type=button]):not([type=submit]):not([type=reset])",
        "textarea",
        "select",
        "[contenteditable=true]",
      );
    }
    if (state.policy.redactEmails === true) {
      selectors.push("input[type=email]", "[autocomplete=email]");
    }
    if (state.policy.redactPhoneNumbers === true) {
      selectors.push("input[type=tel]", "[autocomplete=tel]");
    }
    if (!selectors.length) return [];
    const selector = selectors.join(",");
    return queryAllOpenRoots(selector)
      .filter(
        (element) =>
          inPage(element) &&
          !element.closest("[data-knowhow-ui],[data-knowhow-overlay]"),
      )
      .map((element) =>
        contentRectFor(
          element,
          element.matches("input[type=password],[autocomplete*=password]")
            ? "password-field"
            : "form-field",
        ),
      )
      .filter(Boolean);
  }

  function rangeFindings(text, policy = state.policy) {
    const findings = [];
    const detectors = [
      [
        policy.redactEmails === true,
        "email",
        /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
      ],
      [
        policy.redactPhoneNumbers === true,
        "phone",
        /(?:\+?\d[\d\s().-]{7,}\d)/g,
      ],
      [
        policy.redactFinancialNumbers === true,
        "financial-number",
        /(?:\b\d[ -]*?){13,19}\b/g,
      ],
      [
        policy.redactIds === true,
        "identifier",
        /\b(?=[A-Z0-9-]{8,}\b)(?=(?:[A-Z0-9-]*\d){2,})[A-Z0-9][A-Z0-9-]{7,}\b/gi,
      ],
      [policy.redactAllNumbers === true, "number", /\d+/g],
    ];
    for (const [enabled, reason, pattern] of detectors) {
      if (!enabled) continue;
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        findings.push({
          start: match.index,
          end: match.index + match[0].length,
          reason,
        });
        if (!match[0].length) pattern.lastIndex += 1;
      }
    }
    return findings;
  }

  // A text node usually carries the source file's newlines and indentation.
  // Selecting those collapsed spaces makes the browser hand back rectangles
  // that run to the end of the line box, which paints a cover over blank page.
  // Every range is trimmed to the ink it actually needs to hide.
  function inkRange(node, start, end) {
    const value = node.nodeValue || "";
    let from = start;
    let to = Math.min(end, value.length);
    while (from < to && /\s/.test(value[from])) from += 1;
    while (to > from && /\s/.test(value[to - 1])) to -= 1;
    if (from >= to) return null;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    return range;
  }

  function pushRangeMasks(masks, range, reason) {
    const owner =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer?.parentElement;
    const rects = [...range.getClientRects()];
    if (!rects.length) return;
    // One run of text is one piece of content, so it gets one kind of cover.
    // Judging each client rectangle on its own let a wrapped line put its first
    // row on a `filter` host and its second on an overlay — which painted a
    // solid slab across text the host was already blurring. The host is decided
    // once, from the ink of the whole range, and every rectangle follows it.
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const rect of rects) {
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    const host = tightBlurHost(
      owner,
      { width: right - left, height: bottom - top },
      reason,
    );
    for (const rect of rects) {
      const mask = maskFromClientRect(rect, reason, owner, host);
      if (mask) masks.push(mask);
    }
  }

  function textMasksInElement(element, reason, limit = 80) {
    const masks = [];
    if (!(element instanceof Element)) return masks;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    let visited = 0;
    while ((node = walker.nextNode()) && visited < limit) {
      visited += 1;
      const parent = node.parentElement;
      if (
        !parent ||
        !inPage(parent) ||
        parent.closest(
          "script,style,noscript,svg,[data-knowhow-ui],[data-knowhow-overlay]",
        )
      ) {
        continue;
      }
      const value = node.nodeValue || "";
      if (!value.trim()) continue;
      const range = inkRange(node, 0, value.length);
      if (range) pushRangeMasks(masks, range, reason);
    }
    return masks;
  }

  function textMasks() {
    if (state.policy.smartBlurEnabled !== true) return [];
    if (
      state.policy.redactEmails !== true &&
      state.policy.redactPhoneNumbers !== true &&
      state.policy.redactFinancialNumbers !== true &&
      state.policy.redactIds !== true &&
      state.policy.redactAllNumbers !== true &&
      state.policy.redactLongText !== true
    ) {
      return [];
    }
    const masks = [];
    let visited = 0;
    for (const root of observableRoots()) {
      const treeRoot =
        root instanceof Document
          ? root.body || root.documentElement
          : root;
      if (!treeRoot) continue;
      const walker = document.createTreeWalker(treeRoot, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && visited < 1_500) {
        visited += 1;
        const parent = node.parentElement;
        if (
          !parent ||
          !inPage(parent) ||
          parent.closest(
            "script,style,noscript,svg,[data-knowhow-ui],[data-knowhow-overlay]",
          )
        ) {
          continue;
        }
        const value = node.nodeValue || "";
        if (!value.trim()) continue;
        if (
          state.policy.redactLongText === true &&
          value.trim().length >= 100
        ) {
          const range = inkRange(node, 0, value.length);
          if (range) pushRangeMasks(masks, range, "long-text");
          continue;
        }
        for (const finding of rangeFindings(value)) {
          const range = inkRange(node, finding.start, finding.end);
          if (range) pushRangeMasks(masks, range, finding.reason);
        }
      }
      if (visited >= 1_500) break;
    }
    return masks;
  }

  function embeddedFrameMasks() {
    if (state.policy.smartBlurEnabled !== true) return [];
    if (state.policy.redactImages !== true) return [];
    return queryAllOpenRoots("iframe")
      .filter(inPage)
      .map((frame) => rectFor(frame, "embedded-frame"))
      .filter(Boolean);
  }

  function isInboxStyleRow(element) {
    const rect = element.getBoundingClientRect();
    return (
      rect.height >= 18 &&
      rect.height <= 140 &&
      rect.width >= 160 &&
      rect.width >= innerWidth * 0.25
    );
  }

  function optionalSurfaceMasks() {
    const masks = [];
    if (state.policy.smartBlurEnabled !== true) return masks;
    if (state.policy.redactImages === true) {
      const seen = new Set();
      for (const image of queryAllOpenRoots(
        "img,picture,canvas,video,svg,[role=img]",
      )) {
        if (image.tagName === "PICTURE" && image.querySelector("img")) continue;
        if (!inPage(image) || seen.has(image)) continue;
        seen.add(image);
        const mask = rectFor(image, "image");
        if (mask) masks.push(mask);
      }
    }
    if (state.policy.redactTableRows === true) {
      let rows = 0;
      for (const row of queryAllOpenRoots("tr, [role=row]")) {
        if (rows >= 80) break;
        if (!inPage(row) || !isInboxStyleRow(row)) continue;
        rows += 1;
        masks.push(...textMasksInElement(row, "table-row"));
      }
    }
    return masks;
  }

  const manualSelections = new Map();
  const manualSelectionHistory = [];
  const manualExclusions = new Map();
  const manualExclusionHistory = [];
  let pickerMode = "blur";

  function selectorWithinRoot(element) {
    const segments = [];
    let current = element;
    while (
      current instanceof Element &&
      current.parentElement &&
      segments.length < 8
    ) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
          (sibling) => sibling.tagName === current.tagName,
        )
        : [];
      const position = Math.max(1, siblings.indexOf(current) + 1);
      segments.unshift(`${tag}:nth-of-type(${position})`);
      current = current.parentElement;
    }
    if (current instanceof Element && segments.length < 8) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (sibling) => sibling.tagName === current.tagName,
          )
        : [];
      const position = Math.max(1, siblings.indexOf(current) + 1);
      segments.unshift(`${tag}:nth-of-type(${position})`);
    }
    return segments.join(" > ");
  }

  function structuralDescriptor(element) {
    if (!(element instanceof Element)) return [];
    const scopes = [];
    let current = element;
    while (current instanceof Element && scopes.length < 6) {
      const root = current.getRootNode();
      const selector = selectorWithinRoot(current);
      if (!selector) return [];
      scopes.push({ selector, tagName: current.tagName });
      if (root === document) break;
      if (!(root instanceof ShadowRoot) || !(root.host instanceof Element)) {
        return [];
      }
      current = root.host;
    }
    return scopes.reverse();
  }

  function resolveManualElement(selection) {
    if (selection.element?.isConnected) return selection.element;
    if (!Array.isArray(selection.descriptor) || !selection.descriptor.length) {
      return null;
    }
    try {
      let root = document;
      let candidate = null;
      for (const [index, segment] of selection.descriptor.entries()) {
        candidate = root.querySelector(segment.selector);
        if (!candidate || candidate.tagName !== segment.tagName) return null;
        if (index < selection.descriptor.length - 1) {
          if (!candidate.shadowRoot) return null;
          root = candidate.shadowRoot;
        }
      }
      selection.element = candidate;
      return candidate;
    } catch {
      // A stale structural descriptor simply stops matching on this page.
    }
    return null;
  }

  function manualSelectionMasks() {
    const masks = [];
    for (const selection of manualSelections.values()) {
      const element = resolveManualElement(selection);
      if (!element || !inPage(element)) continue;
      const style = getComputedStyle(element);
      const clientRects =
        style.display === "inline" ? Array.from(element.getClientRects()) : [];
      const rects = clientRects.length
        ? clientRects
        : [element.getBoundingClientRect()];
      for (const clientRect of rects) {
        const mask = maskFromClientRect(clientRect, "manual-element", element);
        if (mask) {
          masks.push({
            ...mask,
            manual: true,
            selectionId: selection.id,
          });
        }
      }
    }
    return masks;
  }

  function clearManualSelections() {
    forgetTypedField();
    lastTypedStep = null;
    manualSelections.clear();
    manualSelectionHistory.length = 0;
    manualExclusions.clear();
    manualExclusionHistory.length = 0;
    syncSmartBlurUi();
    syncManualSelectionCopy();
    noteVisualChange(0);
  }

  function exclusionCoversMask(mask) {
    for (const exclusion of manualExclusions.values()) {
      const element = resolveManualElement(exclusion);
      if (!(element instanceof Element) || !element.isConnected) continue;
      if (
        mask.host instanceof Element &&
        (mask.host === element ||
          element.contains(mask.host) ||
          mask.host.contains(element))
      ) {
        return true;
      }
      const box = element.getBoundingClientRect();
      const left = Math.max(mask.x, box.left);
      const top = Math.max(mask.y, box.top);
      const right = Math.min(mask.x + mask.width, box.right);
      const bottom = Math.min(mask.y + mask.height, box.bottom);
      const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
      if (overlap >= mask.width * mask.height * 0.5) return true;
    }
    return false;
  }

  function collectMasks() {
    const viewport = viewportSnapshot();
    return geometry.normalizeAndMergeMasks([
      ...formFieldMasks(),
      ...textMasks(),
      ...embeddedFrameMasks(),
      ...optionalSurfaceMasks(),
      ...manualSelectionMasks(),
    ], viewport, {
      padding: 1,
      horizontalGap: 6,
      verticalOverlap: 0.55,
      mergeWaste: 1.35,
    }).filter((mask) => !exclusionCoversMask(mask));
  }

  function serializableMask(mask) {
    if (!mask) return null;
    return {
      x: mask.x,
      y: mask.y,
      width: mask.width,
      height: mask.height,
      reason: mask.reason,
      cover: mask.host ? "filter" : "overlay",
      ...(mask.manual === true ? { manual: true } : {}),
      ...(typeof mask.selectionId === "string" ? { selectionId: mask.selectionId } : {}),
    };
  }

  function serializableMasks(masks) {
    return (Array.isArray(masks) ? masks : [])
      .filter(maskIntersectsViewport)
      .map(serializableMask)
      .filter(Boolean);
  }

  let blurPreviewRoot = null;
  const scrollerOverlayHosts = new Map();
  const scrollerPositionRestore = new WeakMap();
  const blurredHostSet = new Set();
  const blurredHostIds = new WeakMap();
  let blurredHostIdSeq = 0;
  let blurPreviewTimer = null;
  let blurPreviewFrame = null;
  let blurPreviewQueuedAt = 0;
  let blurPreviewInterval = null;
  let blurPreviewObserver = null;
  let blurPreviewRestoreTimer = null;
  let blurPreviewSuspended = false;
  let liveOverlayScrolling = false;
  let liveOverlayScrollTimer = null;
  let smartBlurUiRoot = null;
  let smartBlurPanelOpen = false;
  let lastSerializableMasks = [];
  let lastOverlaySignature = "";
  const scrollerIds = new WeakMap();
  let scrollerIdSeq = 0;
  let pickerActive = false;
  let pickerCandidate = null;
  let pickerOverlayRoot = null;
  let pickerToolbar = null;
  let lastPointerPoint = null;
  let privacyVeilEl = null;
  let hoverTargetEl = null;
  let hoverTargetElement = null;

  const NUMBER_POLICY_KEYS = [
    "redactAllNumbers",
    "redactPhoneNumbers",
    "redactFinancialNumbers",
    "redactIds",
  ];

  const SMART_BLUR_OPTIONS = [
    ["redactEmails", "Email"],
    ["redactAllNumbers", "Number"],
    ["redactLongText", "Long text"],
    ["redactFormFields", "Form field"],
    ["redactTableRows", "Table row"],
    ["redactImages", "Image"],
  ];

  // Workspace privacy categories map onto these switches. A recommended
  // category is labelled in the panel but never switched on for the author.
  const RECOMMENDED_CATEGORY_BY_KEY = {
    redactEmails: "email",
    redactAllNumbers: ["phone-number", "financial-number", "identifier"],
    redactFormFields: "form-field",
  };

  function recommendedPolicyKey(key) {
    const category = RECOMMENDED_CATEGORY_BY_KEY[key];
    const recommended = state.policy.recommendedRedactions;
    if (!category || !Array.isArray(recommended)) return false;
    if (Array.isArray(category)) {
      return category.some((item) => recommended.includes(item));
    }
    return recommended.includes(category);
  }

  function numberPolicyIsOn() {
    return NUMBER_POLICY_KEYS.some((key) => state.policy[key] === true);
  }

  function policySwitchIsOn(key) {
    if (key === "redactAllNumbers") return numberPolicyIsOn();
    return state.policy[key] === true;
  }

  function captureSessionVisible() {
    return state.status === "recording" || state.status === "paused";
  }

  function clearBlurPreviewSchedule() {
    if (blurPreviewTimer) {
      clearTimeout(blurPreviewTimer);
      blurPreviewTimer = null;
    }
    if (blurPreviewFrame) {
      cancelAnimationFrame(blurPreviewFrame);
      blurPreviewFrame = null;
    }
  }

  function clearHostBlur(host) {
    if (!(host instanceof Element)) return;
    host.removeAttribute("data-knowhow-blurred");
    host.removeAttribute("data-knowhow-mask-reason");
    host.classList.remove("knowhow-blur-revealed");
  }

  function clearElementBlurs() {
    for (const host of blurredHostSet) clearHostBlur(host);
    blurredHostSet.clear();
    for (const leftover of document.querySelectorAll("[data-knowhow-blurred]")) {
      clearHostBlur(leftover);
    }
  }

  function hostSignatureId(host) {
    let id = blurredHostIds.get(host);
    if (!id) {
      blurredHostIdSeq += 1;
      id = "h" + blurredHostIdSeq;
      blurredHostIds.set(host, id);
    }
    return id;
  }

  function syncElementBlurs(hosted) {
    const next = new Map();
    for (const mask of hosted) {
      const host = mask.host;
      if (!(host instanceof Element) || !host.isConnected) continue;
      if (!next.has(host)) next.set(host, mask.reason);
    }
    for (const host of blurredHostSet) {
      if (!next.has(host)) clearHostBlur(host);
    }
    blurredHostSet.clear();
    for (const [host, reason] of next) {
      if (host.getAttribute("data-knowhow-blurred") !== reason) {
        host.setAttribute("data-knowhow-blurred", reason);
      }
      if (host.getAttribute("data-knowhow-mask-reason") !== reason) {
        host.setAttribute("data-knowhow-mask-reason", reason);
      }
      blurredHostSet.add(host);
    }
  }

  function removeBlurPreview() {
    clearBlurPreviewSchedule();
    globalThis.CSS?.highlights?.delete("knowhow-blur");
    clearElementBlurs();
    hidePrivacyVeil();
    for (const [scroller, host] of scrollerOverlayHosts) {
      host.remove();
      const previous = scrollerPositionRestore.get(scroller);
      if (typeof previous === "string") scroller.style.position = previous;
    }
    scrollerOverlayHosts.clear();
    blurPreviewRoot?.remove();
    blurPreviewRoot = null;
    lastOverlaySignature = "";
    blurPreviewQueuedAt = 0;
  }

  function ensureBlurPreviewRoot() {
    if (blurPreviewRoot?.isConnected) return blurPreviewRoot;
    const root = document.createElement("div");
    root.dataset.knowhowOverlay = "smart-blur-preview";
    root.setAttribute("aria-hidden", "true");
    (document.body || document.documentElement).append(root);
    blurPreviewRoot = root;
    return root;
  }

  function isWindowScroller(scroller) {
    const node = canonicalScroller(scroller);
    return (
      node === document.scrollingElement ||
      node === document.documentElement ||
      node === document.body
    );
  }

  function ensureScrollerOverlayRoot(scroller) {
    const node = canonicalScroller(scroller);
    if (isWindowScroller(node) || !(node instanceof Element)) {
      return ensureBlurPreviewRoot();
    }
    const existing = scrollerOverlayHosts.get(node);
    if (existing) {
      if (!existing.isConnected) node.append(existing);
      return existing;
    }
    if (!scrollerPositionRestore.has(node)) {
      const position = getComputedStyle(node).position;
      if (position === "static") {
        scrollerPositionRestore.set(node, node.style.position);
        node.style.position = "relative";
      } else {
        scrollerPositionRestore.set(node, null);
      }
    }
    const host = document.createElement("div");
    host.dataset.knowhowOverlay = "smart-blur-preview";
    host.dataset.knowhowScroller = "1";
    host.setAttribute("aria-hidden", "true");
    node.append(host);
    scrollerOverlayHosts.set(node, host);
    return host;
  }

  function scrollerSignatureId(scroller) {
    const node = canonicalScroller(scroller);
    if (isWindowScroller(node)) return "window";
    let id = scrollerIds.get(node);
    if (!id) {
      scrollerIdSeq += 1;
      id = "s" + scrollerIdSeq;
      scrollerIds.set(node, id);
    }
    return id;
  }

  function overlayPaintOrigin(scroller) {
    if (isWindowScroller(scroller) || !(scroller instanceof Element)) {
      return { x: 0, y: 0 };
    }
    const box = scroller.getBoundingClientRect();
    return {
      x: box.left - (Number(scroller.scrollLeft) || 0),
      y: box.top - (Number(scroller.scrollTop) || 0),
    };
  }

  function overlaySignature(groups) {
    const parts = [];
    for (const [scroller, grouped] of groups) {
      const origin = overlayPaintOrigin(scroller);
      parts.push(scrollerSignatureId(scroller));
      for (const mask of grouped) {
        parts.push(
          [
            Math.round(mask.x - origin.x),
            Math.round(mask.y - origin.y),
            Math.round(mask.width),
            Math.round(mask.height),
            mask.reason,
          ].join(","),
        );
      }
    }
    return parts.join("|");
  }

  function liveBlurSignature(hosted, groups) {
    const hosts = hosted
      .map((mask) => `${hostSignatureId(mask.host)}:${mask.reason}`)
      .sort()
      .join(",");
    return hosts + "||" + overlaySignature(groups);
  }

  function hostViewportDistance(mask) {
    const host = mask.host;
    if (!(host instanceof Element)) return Number.POSITIVE_INFINITY;
    const rect = host.getBoundingClientRect();
    if (rect.bottom < 0) return -rect.bottom;
    if (rect.top > innerHeight) return rect.top - innerHeight;
    if (rect.right < 0) return -rect.right;
    if (rect.left > innerWidth) return rect.left - innerWidth;
    return 0;
  }

  // On-screen hosts always stay covered. Off-screen budget prefers nodes
  // nearest the viewport so scrolling cannot exhaust a top-of-document cap.
  function selectLiveHosts(masks) {
    const unique = [];
    const seen = new Set();
    for (const mask of Array.isArray(masks) ? masks : []) {
      const host = mask.host;
      if (!(host instanceof Element) || !host.isConnected) continue;
      if (seen.has(host)) continue;
      seen.add(host);
      unique.push(mask);
    }
    const onScreen = [];
    const offScreen = [];
    for (const mask of unique) {
      if (hostViewportDistance(mask) === 0) onScreen.push(mask);
      else offScreen.push(mask);
    }
    offScreen.sort(
      (left, right) => hostViewportDistance(left) - hostViewportDistance(right),
    );
    return onScreen.concat(offScreen.slice(0, MAX_LIVE_HOSTS));
  }

  /**
   * True when a filter-blurred host already covers this box. Detectors overlap
   * — a table-row sweep and a form-field sweep can both claim the same cell —
   * and the loser used to be painted as an overlay slab on top of a host that
   * was blurring it anyway. Only hosts that are actually on screen count, so a
   * host dropped by the off-screen budget can never swallow a cover.
   */
  function coveredByLiveHost(mask, hostBoxes) {
    const right = mask.x + mask.width;
    const bottom = mask.y + mask.height;
    for (const box of hostBoxes) {
      if (
        mask.x >= box.left - 1 &&
        mask.y >= box.top - 1 &&
        right <= box.right + 1 &&
        bottom <= box.bottom + 1
      ) {
        return true;
      }
    }
    return false;
  }

  function overlayHostsAreAttached(groups) {
    for (const [scroller] of groups) {
      const host = isWindowScroller(scroller)
        ? blurPreviewRoot
        : scrollerOverlayHosts.get(canonicalScroller(scroller));
      if (!host?.isConnected) return false;
    }
    return true;
  }

  function setOverlayPx(region, name, value) {
    const next = `${value}px`;
    if (region.style.getPropertyValue(name) !== next) {
      region.style.setProperty(name, next);
    }
  }

  function paintOverlayRegion(region, mask, paint = mask) {
    if (region.className !== "knowhow-blur-region") {
      region.className = "knowhow-blur-region";
    }
    if (region.dataset.knowhowMaskReason !== mask.reason) {
      region.dataset.knowhowMaskReason = mask.reason;
    }
    if (region.style.visibility === "hidden") region.style.visibility = "";
    setOverlayPx(region, "--knowhow-blur-x", paint.x);
    setOverlayPx(region, "--knowhow-blur-y", paint.y);
    setOverlayPx(region, "--knowhow-blur-width", paint.width);
    setOverlayPx(region, "--knowhow-blur-height", paint.height);
    setOverlayPx(region, "--knowhow-blur-radius", geometry.maskRadius(mask));
    region.__knowhowMask = mask;
    region.__knowhowScrollParent = scrollParentForMask(mask);
    rememberScroller(region.__knowhowScrollParent);
  }

  function shiftLiveOverlays(scroller, dx, dy) {
    if (!blurPreviewRoot || (!dx && !dy)) return;
    const clip = scrollerClipBox(scroller);
    const matched = canonicalScroller(scroller);
    const isWindow =
      matched === document.scrollingElement ||
      matched === document.documentElement;
    for (const region of blurPreviewRoot.children) {
      const mask = region.__knowhowMask;
      if (!mask) continue;
      const parent = canonicalScroller(region.__knowhowScrollParent);
      const centerX = mask.x + mask.width / 2;
      const centerY = mask.y + mask.height / 2;
      const insideClip =
        centerX >= clip.left &&
        centerX <= clip.right &&
        centerY >= clip.top &&
        centerY <= clip.bottom;
      if (parent !== matched && (isWindow || !insideClip)) continue;
      mask.x -= dx;
      mask.y -= dy;
      let box = {
        left: mask.x,
        top: mask.y,
        right: mask.x + mask.width,
        bottom: mask.y + mask.height,
      };
      box = intersectBoxes(box, clip);
      if (box) box = clipAgainstOccludingChrome(box, null);
      if (!box || box.right - box.left < 3 || box.bottom - box.top < 3) {
        region.style.visibility = "hidden";
        continue;
      }
      region.style.visibility = "";
      region.style.setProperty("--knowhow-blur-x", `${box.left}px`);
      region.style.setProperty("--knowhow-blur-y", `${box.top}px`);
      region.style.setProperty("--knowhow-blur-width", `${box.right - box.left}px`);
      region.style.setProperty("--knowhow-blur-height", `${box.bottom - box.top}px`);
    }
  }

  function onLiveOverlayScroll(event) {
    const scroller = canonicalScroller(event.target);
    const next = scrollerOffsets(scroller);
    const prev = lastScrollerOffset.get(scroller);
    lastScrollerOffset.set(scroller, next);
    if (prev && isWindowScroller(scroller)) {
      shiftLiveOverlays(scroller, next.x - prev.x, next.y - prev.y);
    }
    liveOverlayScrolling = true;
    updateBlurReveal(null);
    // The outline is anchored to viewport coordinates that scrolling
    // invalidates; the next pointer move re-places it against the element.
    updateHoverTarget(null);
    blurPreviewRoot?.setAttribute("data-knowhow-scrolling", "true");
    for (const host of scrollerOverlayHosts.values()) {
      host.setAttribute("data-knowhow-scrolling", "true");
    }
    visualEpoch += 1;
    occluderBoxes = null;
    if (liveOverlayScrollTimer) clearTimeout(liveOverlayScrollTimer);
    liveOverlayScrollTimer = setTimeout(() => {
      liveOverlayScrollTimer = null;
      liveOverlayScrolling = false;
      blurPreviewRoot?.removeAttribute("data-knowhow-scrolling");
      for (const host of scrollerOverlayHosts.values()) {
        host.removeAttribute("data-knowhow-scrolling");
      }
      scheduleBlurPreview(0);
      schedulePreparedFrame(90);
    }, 32);
  }

  function renderBlurPreview({ reveal = true } = {}) {
    clearBlurPreviewSchedule();
    if (blurPreviewSuspended) return;
    if (
      !captureSessionVisible() ||
      state.policy.smartBlurEnabled !== true
    ) {
      clearElementBlurs();
      blurPreviewRoot?.replaceChildren();
      globalThis.CSS?.highlights?.delete("knowhow-blur");
      lastSerializableMasks = [];
      lastOverlaySignature = "";
      hidePrivacyVeil();
      return;
    }
    globalThis.CSS?.highlights?.delete("knowhow-blur");
    const masks = collectMasks();
    lastSerializableMasks = serializableMasks(masks);
    const hosted = selectLiveHosts(masks);
    const liveHostBoxes = hosted
      .filter((mask) => hostViewportDistance(mask) === 0)
      .map((mask) => mask.host.getBoundingClientRect());
    const overlayMasks = [];
    for (const mask of masks) {
      if (mask.host instanceof Element && mask.host.isConnected) continue;
      if (coveredByLiveHost(mask, liveHostBoxes)) continue;
      if (
        overlayMasks.length < MAX_LIVE_OVERLAYS &&
        maskIntersectsViewport(mask)
      ) {
        overlayMasks.push(mask);
      }
    }
    const groups = new Map();
    for (const mask of overlayMasks) {
      const scroller = canonicalScroller(scrollParentForMask(mask));
      const grouped = groups.get(scroller) || [];
      grouped.push(mask);
      groups.set(scroller, grouped);
    }
    const signature = liveBlurSignature(hosted, groups);
    const hostsAttached = hosted.every(
      (mask) =>
        mask.host.isConnected &&
        mask.host.getAttribute("data-knowhow-blurred") === mask.reason,
    );
    if (
      signature === lastOverlaySignature &&
      hostsAttached &&
      overlayHostsAreAttached(groups)
    ) {
      syncBlurCoverageCopy();
      updateBlurReveal(reveal ? lastPointerPoint : null);
      hidePrivacyVeil();
      return;
    }
    lastOverlaySignature = signature;
    syncElementBlurs(hosted);
    const usedHosts = new Set();
    for (const [scroller, grouped] of groups) {
      const host = ensureScrollerOverlayRoot(scroller);
      usedHosts.add(host);
      const origin = overlayPaintOrigin(scroller);
      while (host.children.length > grouped.length) host.lastChild.remove();
      for (let index = 0; index < grouped.length; index += 1) {
        const mask = grouped[index];
        let region = host.children[index];
        if (!region) {
          region = document.createElement("span");
          host.append(region);
        }
        paintOverlayRegion(region, mask, {
          ...mask,
          x: mask.x - origin.x,
          y: mask.y - origin.y,
        });
        region.__knowhowScrollParent = scroller;
      }
    }
    const windowScroller = canonicalScroller(
      document.scrollingElement || document.documentElement,
    );
    if (!groups.has(windowScroller)) {
      ensureBlurPreviewRoot().replaceChildren();
    }
    for (const [scroller, host] of [...scrollerOverlayHosts]) {
      if (usedHosts.has(host)) continue;
      if (scroller instanceof Element && scroller.isConnected) {
        host.replaceChildren();
        continue;
      }
      host.remove();
      scrollerOverlayHosts.delete(scroller);
    }
    rememberOverflowScrollers();
    syncBlurCoverageCopy();
    updateBlurReveal(reveal ? lastPointerPoint : null);
    hidePrivacyVeil();
  }

  function scheduleBlurPreview(delay = 0) {
    if (blurPreviewSuspended) return;
    const now =
      typeof performance === "object" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    if (!blurPreviewQueuedAt) blurPreviewQueuedAt = now;
    const maxWait = 24;
    const elapsed = now - blurPreviewQueuedAt;
    const wait = elapsed >= maxWait ? 0 : Math.max(0, Math.min(delay, maxWait - elapsed));
    clearBlurPreviewSchedule();
    const queueFrame = () => {
      blurPreviewTimer = null;
      blurPreviewQueuedAt = 0;
      blurPreviewFrame = requestAnimationFrame(() => {
        blurPreviewFrame = null;
        renderBlurPreview();
      });
    };
    if (wait > 0) blurPreviewTimer = setTimeout(queueFrame, wait);
    else queueFrame();
  }

  function overlayRegions() {
    const regions = [];
    if (blurPreviewRoot) regions.push(...blurPreviewRoot.children);
    for (const host of scrollerOverlayHosts.values()) {
      regions.push(...host.children);
    }
    return regions;
  }

  /**
   * Hovering a covered row or field lifts its blur so the author can read what
   * they are about to hide. A screenshot taken while one is lifted would carry
   * that content in the clear — and an element-filter cover leaves no redaction
   * metadata behind, so nothing downstream could put it back. Every reveal is
   * therefore dropped before the page is photographed.
   */
  function clearBlurReveal() {
    for (const region of overlayRegions()) {
      region.classList.remove("knowhow-blur-revealed");
    }
    for (const host of blurredHostSet) {
      host.classList.remove("knowhow-blur-revealed");
    }
    for (const stray of document.querySelectorAll(".knowhow-blur-revealed")) {
      stray.classList.remove("knowhow-blur-revealed");
    }
  }

  function blurRevealRow(node) {
    return node instanceof Element ? node.closest("tr, [role=row]") : null;
  }

  function updateBlurReveal(point) {
    const regions = overlayRegions();
    const hosts = [...blurredHostSet];
    if (!regions.length && !hosts.length) return;
    const canReveal =
      !pickerActive &&
      !liveOverlayScrolling &&
      state.policy.smartBlurEnabled === true;
    const x = Number(point?.x);
    const y = Number(point?.y);
    const over = Number.isFinite(x) && Number.isFinite(y);
    const hoverRow = over ? blurRevealRow(pageElementFromPoint(x, y)) : null;
    const rowBox = hoverRow?.getBoundingClientRect();
    for (const region of regions) {
      const mask = region.__knowhowMask;
      const overMask = Boolean(
        mask &&
        over &&
        x >= mask.x &&
        x <= mask.x + mask.width &&
        y >= mask.y &&
        y <= mask.y + mask.height,
      );
      const inRow = Boolean(
        rowBox &&
        mask &&
        mask.x + mask.width / 2 >= rowBox.left &&
        mask.x + mask.width / 2 <= rowBox.right &&
        mask.y + mask.height / 2 >= rowBox.top &&
        mask.y + mask.height / 2 <= rowBox.bottom,
      );
      region.classList.toggle(
        "knowhow-blur-revealed",
        Boolean(canReveal && (overMask || inRow)),
      );
    }
    for (const host of hosts) {
      if (!host.isConnected) continue;
      const box = host.getBoundingClientRect();
      const overHost = Boolean(
        over &&
        x >= box.left &&
        x <= box.right &&
        y >= box.top &&
        y <= box.bottom,
      );
      const inRow = Boolean(hoverRow && hoverRow.contains(host));
      host.classList.toggle(
        "knowhow-blur-revealed",
        Boolean(canReveal && (overHost || inRow)),
      );
    }
  }

  function setPagePolicy(key, checked) {
    const patch =
      key === "redactAllNumbers"
        ? Object.fromEntries(NUMBER_POLICY_KEYS.map((item) => [item, checked]))
        : { [key]: checked };
    state.policy = { ...state.policy, ...patch };
    syncSmartBlurUi();
    noteVisualChange(0);
    void send({ type: "UPDATE_CAPTURE_POLICY", policy: patch });
  }

  const PANEL_FONT =
    "'Google Sans Flex Variable',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  function syncManualSelectionCopy() {
    const blurCount = manualSelections.size;
    const unblurCount = manualExclusions.size;
    const blurNode = smartBlurUiRoot?.querySelector(
      "[data-knowhow-manual-count]",
    );
    if (blurNode) {
      blurNode.textContent = blurCount
        ? `${blurCount} chosen element${blurCount === 1 ? "" : "s"}`
        : "Choose other elements";
    }
    const unblurNode = smartBlurUiRoot?.querySelector(
      "[data-knowhow-unblur-count]",
    );
    if (unblurNode) {
      unblurNode.textContent = unblurCount
        ? `${unblurCount} kept visible`
        : "Unblur elements";
    }
    const history =
      pickerMode === "unblur" ? manualExclusionHistory : manualSelectionHistory;
    const count = pickerMode === "unblur" ? unblurCount : blurCount;
    const undo = pickerToolbar?.querySelector("[data-knowhow-picker-undo]");
    if (undo) undo.disabled = history.length === 0;
    const clear = pickerToolbar?.querySelector("[data-knowhow-picker-clear]");
    if (clear) clear.disabled = count === 0;
  }

  function pickerElementFromEvent(event) {
    if (pickerActive && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      const overlayPointerEvents = pickerOverlayRoot?.style.pointerEvents;
      if (pickerOverlayRoot) pickerOverlayRoot.style.pointerEvents = "none";
      try {
        let element = document.elementFromPoint(event.clientX, event.clientY);
        while (element?.shadowRoot) {
          const nested = element.shadowRoot.elementFromPoint(
            event.clientX,
            event.clientY,
          );
          if (!nested || nested === element) break;
          element = nested;
        }
        if (
          element instanceof Element &&
          !element.closest("[data-knowhow-ui],[data-knowhow-overlay]") &&
          visible(element) &&
          element !== document.documentElement &&
          element !== document.body
        ) {
          return element;
        }
      } finally {
        if (pickerOverlayRoot) {
          pickerOverlayRoot.style.pointerEvents = overlayPointerEvents || "auto";
        }
      }
    }
    for (const item of event.composedPath()) {
      if (!(item instanceof Element)) continue;
      if (item.closest("[data-knowhow-ui],[data-knowhow-overlay]")) continue;
      if (!visible(item)) continue;
      if (item === document.documentElement || item === document.body) continue;
      return item;
    }
    return null;
  }

  function updatePickerHighlight(element) {
    pickerCandidate = element;
    const highlight = pickerOverlayRoot?.querySelector(
      ".knowhow-picker-highlight",
    );
    if (!highlight) return;
    if (!element) {
      highlight.hidden = true;
      return;
    }
    const rect = element.getBoundingClientRect();
    highlight.hidden = false;
    highlight.style.left = `${Math.max(0, rect.left)}px`;
    highlight.style.top = `${Math.max(0, rect.top)}px`;
    highlight.style.width = `${Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left))}px`;
    highlight.style.height = `${Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top))}px`;
  }

  function manualSelectionForElement(element) {
    for (const selection of manualSelections.values()) {
      if (resolveManualElement(selection) === element) return selection;
    }
    return null;
  }

  function notifyManualSelectionChange() {
    syncManualSelectionCopy();
    scheduleBlurPreview();
    noteVisualChange(120);
    void send({
      type: "MANUAL_BLUR_CHANGED",
      sessionId: state.sessionId,
      navigationKey: state.navigationKey,
      count: manualSelections.size,
    });
  }

  function isProtectedUnblurTarget(element) {
    if (!(element instanceof Element)) return true;
    return element === document.documentElement || element === document.body;
  }

  function manualExclusionForElement(element) {
    for (const selection of manualExclusions.values()) {
      if (resolveManualElement(selection) === element) return selection;
    }
    return null;
  }

  function toggleManualExclusion(element) {
    if (isProtectedUnblurTarget(element)) return;
    const existing = manualExclusionForElement(element);
    if (existing) {
      manualExclusions.delete(existing.id);
      const historyIndex = manualExclusionHistory.lastIndexOf(existing.id);
      if (historyIndex >= 0) manualExclusionHistory.splice(historyIndex, 1);
      notifyManualSelectionChange();
      return;
    }
    const id = crypto.randomUUID();
    manualExclusions.set(id, {
      id,
      element,
      descriptor: structuralDescriptor(element),
    });
    manualExclusionHistory.push(id);
    notifyManualSelectionChange();
  }

  function togglePickerTarget(element) {
    if (pickerMode === "unblur") {
      toggleManualExclusion(element);
      return;
    }
    toggleManualSelection(element);
  }

  function undoPickerTarget() {
    if (pickerMode === "unblur") {
      const id = manualExclusionHistory.pop();
      if (!id) return;
      manualExclusions.delete(id);
      notifyManualSelectionChange();
      return;
    }
    undoManualSelection();
  }

  function clearPickerTargets() {
    if (pickerMode === "unblur") {
      manualExclusions.clear();
      manualExclusionHistory.length = 0;
    } else {
      manualSelections.clear();
      manualSelectionHistory.length = 0;
    }
    notifyManualSelectionChange();
  }

  function toggleManualSelection(element) {
    const existing = manualSelectionForElement(element);
    if (existing) {
      manualSelections.delete(existing.id);
      const historyIndex = manualSelectionHistory.lastIndexOf(existing.id);
      if (historyIndex >= 0) manualSelectionHistory.splice(historyIndex, 1);
      notifyManualSelectionChange();
      return;
    }
    const rect = element.getBoundingClientRect();
    if (
      rect.width * rect.height > innerWidth * innerHeight * 0.7 &&
      !globalThis.confirm(
        "This will blur most of the visible page in future screenshots. Continue?",
      )
    ) {
      return;
    }
    const id = crypto.randomUUID();
    manualSelections.set(id, {
      id,
      element,
      descriptor: structuralDescriptor(element),
    });
    manualSelectionHistory.push(id);
    if (state.policy.smartBlurEnabled !== true) {
      setPagePolicy("smartBlurEnabled", true);
    }
    notifyManualSelectionChange();
  }

  function undoManualSelection() {
    const id = manualSelectionHistory.pop();
    if (!id) return;
    manualSelections.delete(id);
    notifyManualSelectionChange();
  }

  function ensurePickerUi() {
    if (!pickerOverlayRoot?.isConnected) {
      const overlay = document.createElement("div");
      overlay.dataset.knowhowOverlay = "element-picker";
      const highlight = document.createElement("span");
      highlight.className = "knowhow-picker-highlight";
      highlight.hidden = true;
      overlay.append(highlight);
      (document.body || document.documentElement).append(overlay);
      pickerOverlayRoot = overlay;
    }
    if (!pickerToolbar?.isConnected) {
      const toolbar = document.createElement("div");
      toolbar.dataset.knowhowUi = "element-picker-toolbar";
      toolbar.className = "knowhow-picker-toolbar";
      const label = document.createElement("strong");
      label.dataset.knowhowPickerLabel = "";
      label.textContent = "Click elements to blur";
      const undo = document.createElement("button");
      undo.type = "button";
      undo.dataset.knowhowPickerUndo = "";
      undo.textContent = "Undo";
      undo.addEventListener("click", undoPickerTarget);
      const clear = document.createElement("button");
      clear.type = "button";
      clear.dataset.knowhowPickerClear = "";
      clear.textContent = "Clear all";
      clear.addEventListener("click", clearPickerTargets);
      const done = document.createElement("button");
      done.type = "button";
      done.dataset.primary = "";
      done.textContent = "Done";
      done.addEventListener("click", () => exitElementPicker());
      toolbar.append(label, undo, clear, done);
      (document.body || document.documentElement).append(toolbar);
      pickerToolbar = toolbar;
    }
    syncPickerToolbar();
  }

  function syncPickerToolbar() {
    const label = pickerToolbar?.querySelector("[data-knowhow-picker-label]");
    if (label) {
      label.textContent =
        pickerMode === "unblur"
          ? "Click elements to unblur"
          : "Click elements to blur";
    }
    pickerOverlayRoot?.classList.toggle(
      "knowhow-picker-unblur",
      pickerMode === "unblur",
    );
    syncManualSelectionCopy();
  }

  function enterElementPicker(mode = "blur") {
    if (!captureSessionVisible()) return;
    smartBlurPanelOpen = false;
    pickerMode = mode === "unblur" ? "unblur" : "blur";
    pickerActive = true;
    ensurePickerUi();
    updateBlurReveal(lastPointerPoint);
    syncSmartBlurUi();
  }

  function exitElementPicker() {
    if (!pickerActive) return;
    pickerActive = false;
    pickerCandidate = null;
    pickerOverlayRoot?.remove();
    pickerToolbar?.remove();
    pickerOverlayRoot = null;
    pickerToolbar = null;
    scheduleBlurPreview();
    updateBlurReveal(lastPointerPoint);
    noteVisualChange(0);
  }

  function onPickerKeyDown(event) {
    if (!pickerActive || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    exitElementPicker();
  }

  function onPickerPointerMove(event) {
    if (!pickerActive) return false;
    updatePickerHighlight(pickerElementFromEvent(event));
    return true;
  }

  function onPickerClick(event) {
    if (!pickerActive || isKnowHowUiEvent(event)) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = pickerElementFromEvent(event) || pickerCandidate;
    if (element) togglePickerTarget(element);
    updatePickerHighlight(element);
    return true;
  }

  function smartBlurSwitch(key, label, { compact = false } = {}) {
    const row = document.createElement("label");
    row.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:14px;" +
      "min-height:" +
      (compact ? "26px" : "32px") +
      ";color:#e7e7ea;font:600 " +
      (compact ? "12px" : "13px") +
      "/1.3 " +
      PANEL_FONT +
      ";cursor:pointer;";
    const text = document.createElement("span");
    text.style.cssText = "display:flex;align-items:center;gap:7px;min-width:0;";
    const labelText = document.createElement("span");
    labelText.textContent = label;
    const suggestion = document.createElement("em");
    suggestion.dataset.knowhowBlurSuggested = key;
    suggestion.textContent = "Suggested";
    suggestion.style.cssText =
      "display:none;flex:0 0 auto;padding:2px 6px;border-radius:999px;" +
      "background:rgba(250,204,21,.14);color:#facc15;font:700 8px/1 " +
      PANEL_FONT +
      ";letter-spacing:.08em;text-transform:uppercase;font-style:normal;";
    text.append(labelText, suggestion);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.knowhowPolicy = key;
    input.style.cssText = "position:absolute;opacity:0;pointer-events:none;";
    const track = document.createElement("span");
    track.dataset.knowhowSwitch = "";
    track.style.cssText =
      "position:relative;display:block;width:34px;height:19px;flex:0 0 auto;" +
      "border-radius:999px;background:#3f3f46;transition:background .14s ease;";
    const thumb = document.createElement("i");
    thumb.style.cssText =
      "position:absolute;left:2.5px;top:2.5px;width:14px;height:14px;border-radius:50%;" +
      "background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.4);transition:transform .14s ease;";
    track.append(thumb);
    input.addEventListener("change", () => setPagePolicy(key, input.checked));
    row.append(text, input, track);
    return row;
  }

  function ensureSmartBlurUi() {
    if (smartBlurUiRoot?.isConnected) return smartBlurUiRoot;
    const root = document.createElement("div");
    root.dataset.knowhowUi = "smart-blur";
    root.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;" +
      "flex-direction:column;align-items:flex-end;font-family:" +
      PANEL_FONT +
      ";color:#fff;";

    const panel = document.createElement("section");
    panel.dataset.knowhowBlurPanel = "";
    panel.style.cssText =
      "display:none;width:min(292px,calc(100vw - 32px));" +
      "max-height:min(520px,calc(100vh - 96px));margin-bottom:9px;overflow:auto;" +
      "border-radius:14px;background:#171714;" +
      "box-shadow:0 0 0 1px rgba(255,255,255,.07),0 22px 60px rgba(0,0,0,.42);";

    const heading = document.createElement("div");
    heading.style.cssText =
      "position:sticky;top:0;display:grid;gap:2px;padding:13px 15px 11px;" +
      "background:#171714;border-bottom:1px solid rgba(255,255,255,.07);";
    const headingRow = document.createElement("div");
    headingRow.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:14px;";
    const title = document.createElement("strong");
    title.textContent = "Smart Blur";
    title.style.cssText = "font-size:14px;letter-spacing:-.01em;";
    headingRow.append(title, smartBlurSwitch("smartBlurEnabled", ""));
    heading.append(headingRow);

    const options = document.createElement("div");
    options.dataset.knowhowBlurOptions = "";
    options.style.cssText = "display:grid;padding:9px 15px 13px;";
    const optionsLabel = document.createElement("span");
    optionsLabel.textContent = "Detect and cover";
    optionsLabel.style.cssText =
      "padding-bottom:5px;color:#8f8f99;font:700 9px/1 " +
      PANEL_FONT +
      ";letter-spacing:.1em;text-transform:uppercase;";
    options.append(optionsLabel);
    for (const [key, label] of SMART_BLUR_OPTIONS) {
      options.append(smartBlurSwitch(key, label, { compact: true }));
    }

    const manualActions = document.createElement("div");
    manualActions.style.cssText =
      "display:grid;gap:7px;padding:3px 15px 13px;border-top:1px solid rgba(255,255,255,.06);";
    const choose = document.createElement("button");
    choose.type = "button";
    choose.dataset.knowhowManualCount = "";
    choose.style.cssText =
      "min-height:36px;margin-top:10px;border:1px solid rgba(255,255,255,.11);" +
      "border-radius:9px;background:#22221e;color:#f5f4f0;font:700 12px/1 " +
      PANEL_FONT + ";cursor:pointer;";
    choose.addEventListener("click", () => enterElementPicker("blur"));
    const unblur = document.createElement("button");
    unblur.type = "button";
    unblur.dataset.knowhowUnblurCount = "";
    unblur.style.cssText = choose.style.cssText.replace("margin-top:10px;", "margin-top:0;");
    unblur.addEventListener("click", () => enterElementPicker("unblur"));
    manualActions.append(choose, unblur);

    panel.append(heading, options, manualActions);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.dataset.knowhowBlurTrigger = "";
    trigger.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:9px 14px 9px 12px;border:0;" +
      "border-radius:999px;background:#171714;color:#fff;" +
      "box-shadow:0 0 0 1px rgba(255,255,255,.08),0 10px 30px rgba(0,0,0,.34);" +
      "font:700 12px/1 " +
      PANEL_FONT +
      ";cursor:pointer;";
    const triggerDot = document.createElement("span");
    triggerDot.dataset.knowhowBlurDot = "";
    triggerDot.style.cssText =
      "width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:#52525b;";
    const triggerLabel = document.createElement("span");
    triggerLabel.dataset.knowhowBlurLabel = "";
    trigger.append(triggerDot, triggerLabel);
    trigger.addEventListener("click", () => {
      smartBlurPanelOpen = !smartBlurPanelOpen;
      clearPreparedFrameSchedule();
      syncSmartBlurUi();
      if (!smartBlurPanelOpen) schedulePreparedFrame(0);
    });

    root.append(panel, trigger);
    (document.body || document.documentElement).append(root);
    smartBlurUiRoot = root;
    syncManualSelectionCopy();
    return root;
  }

  function syncBlurCoverageCopy() {
    if (!smartBlurUiRoot?.isConnected) return;
    const enabled = state.policy.smartBlurEnabled === true;
    const label = smartBlurUiRoot.querySelector("[data-knowhow-blur-label]");
    if (label) {
      label.textContent = enabled ? "Smart Blur on" : "Smart Blur off";
    }
  }

  function syncSmartBlurUi() {
    if (!captureSessionVisible()) {
      smartBlurUiRoot?.remove();
      smartBlurUiRoot = null;
      smartBlurPanelOpen = false;
      return;
    }
    const root = ensureSmartBlurUi();
    const enabled = state.policy.smartBlurEnabled === true;
    const panel = root.querySelector("[data-knowhow-blur-panel]");
    panel.style.display = smartBlurPanelOpen ? "block" : "none";
    const dot = root.querySelector("[data-knowhow-blur-dot]");
    if (dot) {
      dot.style.background = enabled ? "#34d399" : "#52525b";
      dot.style.boxShadow = enabled ? "0 0 0 3px rgba(52,211,153,.18)" : "none";
    }
    for (const chip of root.querySelectorAll("[data-knowhow-blur-suggested]")) {
      chip.style.display = recommendedPolicyKey(
        chip.dataset.knowhowBlurSuggested,
      )
        ? "block"
        : "none";
    }
    for (const input of root.querySelectorAll("[data-knowhow-policy]")) {
      input.checked = policySwitchIsOn(input.dataset.knowhowPolicy);
      const track = input.nextElementSibling;
      if (track) {
        track.style.background = input.checked ? "#22c55e" : "#3f3f46";
        const thumb = track.firstElementChild;
        if (thumb) thumb.style.transform = input.checked ? "translateX(15px)" : "none";
      }
    }
    const options = root.querySelector("[data-knowhow-blur-options]");
    if (options) options.style.opacity = enabled ? "1" : ".5";
    syncBlurCoverageCopy();
  }

  function smartBlurUiIsEngaged() {
    if (smartBlurPanelOpen) return true;
    if (!smartBlurUiRoot?.isConnected || !lastPointerPoint) return false;
    const box = smartBlurUiRoot.getBoundingClientRect();
    return (
      lastPointerPoint.x >= box.left &&
      lastPointerPoint.x <= box.right &&
      lastPointerPoint.y >= box.top &&
      lastPointerPoint.y <= box.bottom
    );
  }

  /**
   * Outlines the element a click would record, so the author can see what
   * KnowHow is about to capture before committing to it. Purely an on-page
   * affordance: it is never part of a screenshot, because every capture path
   * hides the overlays first.
   */
  function updateHoverTarget(element) {
    if (
      !element ||
      state.status !== "recording" ||
      pickerActive ||
      blurPreviewSuspended
    ) {
      if (hoverTargetEl) hoverTargetEl.style.opacity = "0";
      hoverTargetElement = null;
      return;
    }
    // Only the element under the pointer changing is worth a reposition. This
    // runs off pointermove, so it deliberately avoids the mask pipeline's
    // occlusion and overflow work — a plain clipped client rect is all an
    // outline needs.
    if (element === hoverTargetElement) return;
    const box = element.getBoundingClientRect();
    const left = Math.max(0, box.left);
    const top = Math.max(0, box.top);
    const width = Math.min(innerWidth, box.right) - left;
    const height = Math.min(innerHeight, box.bottom) - top;
    if (!(width >= 3 && height >= 3)) {
      if (hoverTargetEl) hoverTargetEl.style.opacity = "0";
      hoverTargetElement = null;
      return;
    }
    const rect = { x: left, y: top, width, height };
    if (!hoverTargetEl?.isConnected) {
      const root = document.body || document.documentElement;
      if (!root) return;
      const outline = document.createElement("div");
      outline.dataset.knowhowOverlay = "hover-target";
      outline.setAttribute("aria-hidden", "true");
      root.append(outline);
      hoverTargetEl = outline;
    }
    hoverTargetElement = element;
    hoverTargetEl.style.opacity = "1";
    hoverTargetEl.style.left = `${rect.x}px`;
    hoverTargetEl.style.top = `${rect.y}px`;
    hoverTargetEl.style.width = `${rect.width}px`;
    hoverTargetEl.style.height = `${rect.height}px`;
  }

  function removeHoverTarget() {
    hoverTargetEl?.remove();
    hoverTargetEl = null;
    hoverTargetElement = null;
  }

  let captureChromeRestoreTimer = null;

  function hideCaptureOverlays() {
    // Keep Smart Blur in the hit-test tree while it is visually removed from a
    // screenshot. `visibility:hidden` let clicks fall through to the website
    // during this one-frame window, which could create a phantom guide step.
    if (smartBlurUiRoot) smartBlurUiRoot.style.opacity = "0";
    if (pickerOverlayRoot) pickerOverlayRoot.style.visibility = "hidden";
    if (pickerToolbar) pickerToolbar.style.visibility = "hidden";
    if (hoverTargetEl) hoverTargetEl.style.visibility = "hidden";
  }

  function restoreCaptureOverlays() {
    if (captureChromeRestoreTimer) {
      clearTimeout(captureChromeRestoreTimer);
      captureChromeRestoreTimer = null;
    }
    if (smartBlurUiRoot) smartBlurUiRoot.style.opacity = "";
    if (pickerOverlayRoot) pickerOverlayRoot.style.visibility = "visible";
    if (pickerToolbar) pickerToolbar.style.visibility = "visible";
    if (hoverTargetEl) hoverTargetEl.style.visibility = "visible";
  }

  function clearPreparedFrameSchedule() {
    if (preparedFrameTimer) clearTimeout(preparedFrameTimer);
    preparedFrameTimer = null;
    preparedFrameWantedSince = 0;
  }

  function frameIsClaimable(frame = preparedFrames.at(-1)) {
    if (!frame || frame.consumed === true) return false;
    if (Date.now() - Number(frame.capturedAtMs || 0) > PREPARED_FRAME_MAX_AGE_MS) {
      return false;
    }
    return (
      frame.viewportKey === viewportKey() &&
      frame.navigationKey === state.navigationKey
    );
  }

  function frameIsEligible(frame = preparedFrames.at(-1)) {
    return frameIsClaimable(frame) && frame.visualEpoch === visualEpoch;
  }

  function preparedFrameSchedulingAllowed() {
    if (state.status !== "recording" || pickerActive) return false;
    if (smartBlurUiIsEngaged()) return false;
    // Every capture tears the start-of-recording flash down so it can never be
    // photographed, and the first pre-warm used to fire within a couple of
    // hundred milliseconds — which meant the author saw a blink instead of the
    // message. Nothing is worth capturing during that beat anyway: the author
    // is reading it, not working.
    if (recordingFlashPlaying()) return false;
    // A backgrounded tab cannot be photographed by captureVisibleTab anyway;
    // scheduling one only burns a queue slot and returns an error.
    return document.visibilityState === "visible";
  }

  function schedulePreparedFrame(delay = 180, { urgent = false } = {}) {
    if (!preparedFrameSchedulingAllowed()) return;
    const now = Date.now();
    if (!preparedFrameWantedSince) preparedFrameWantedSince = now;
    // A quiet-period debounce: each new visual change pushes the capture out,
    // so a burst of mutations produces one screenshot once the page settles
    // rather than one screenshot per mutation. The max wait keeps a page that
    // animates without pause — a spinner, a live feed, a video — from
    // deferring the pre-warm forever and pushing every click onto the slower
    // capture-after-the-fact path.
    const quiet = Math.max(PREPARED_FRAME_QUIET_MS, Math.max(0, delay));
    const untilMaxWait = Math.max(
      0,
      preparedFrameWantedSince + PREPARED_FRAME_MAX_WAIT_MS - now,
    );
    // Never fire faster than the minimum spacing, so speculative pre-warming
    // can never crowd out the screenshot that belongs to a real click.
    const spacing = Math.max(
      0,
      lastPreparedFrameAt + PREPARED_FRAME_MIN_SPACING_MS - now,
    );
    // An urgent request waives the settle-down wait but not the spacing: a
    // click is expected imminently and there is nothing in hand for it, so the
    // only thing worth waiting for is Chrome's own capture budget.
    const delayMs = urgent
      ? spacing
      : Math.max(Math.min(quiet, untilMaxWait), spacing);
    if (preparedFrameTimer) clearTimeout(preparedFrameTimer);
    preparedFrameTimer = setTimeout(() => {
      preparedFrameTimer = null;
      void preparePrivateFrame();
    }, delayMs);
  }

  function noteVisualChange(delay = 180) {
    visualEpoch += 1;
    occluderBoxes = null;
    refreshLiveBlur();
    schedulePreparedFrame(delay);
  }

  function refreshLiveBlur() {
    scheduleBlurPreview();
  }

  async function preparePrivateFrame() {
    if (!preparedFrameSchedulingAllowed()) return null;
    if (preparedFrameInFlight) return preparedFrameInFlight;
    // Another path may have produced a matching frame while this one waited
    // out its debounce.
    if (frameIsEligible()) {
      preparedFrameWantedSince = 0;
      return null;
    }
    const epoch = visualEpoch;
    const context = pageContext();
    context.visualEpoch = epoch;
    context.viewportKey = viewportKey(context.viewport);
    const operation = Promise.resolve()
      .then(async () => {
        if (state.status !== "recording" || pickerActive) {
          return null;
        }
        removeRecordingFlash();
        if (preparedFrameNeedsSettle) {
          preparedFrameNeedsSettle = false;
          const waiter = globalThis.__KNOWHOW_PAGE_SETTLED__;
          if (typeof waiter?.waitForPageSettled === "function") {
            await waiter.waitForPageSettled();
          }
        }
        // KnowHow's own panel still has to be out of shot, but hiding it here
        // meant hiding it for the whole round trip: the worker queues this
        // request behind Chrome's two-screenshots-per-second cap, so the panel
        // vanished for the best part of a second, roughly once a second, on any
        // page that keeps mutating. The worker now hides it in the moment it
        // actually takes the picture instead, which is a single frame.
        await waitForPagePaint();
        if (state.status !== "recording" || pickerActive) return null;
        return send({
          type: "PREPARE_CAPTURE_FRAME",
          sessionId: state.sessionId,
          navigationKey: state.navigationKey,
          visualEpoch: epoch,
          viewportKey: context.viewportKey,
          knownFrameIds: preparedFrames.map((frame) => frame.id),
          context,
        });
      })
      .then((response) => {
        if (response?.ok === true && response.frameId) {
          const preparedFrame = {
            id: response.frameId,
            capturedAtMs: response.capturedAtMs,
            visualEpoch: Number.isFinite(Number(response.visualEpoch))
              ? Number(response.visualEpoch)
              : epoch,
            viewportKey: response.viewportKey || context.viewportKey,
            navigationKey: response.navigationKey || state.navigationKey,
            consumed: false,
          };
          preparedFrames = [
            ...preparedFrames.filter(
              (candidate) => candidate.id !== preparedFrame.id,
            ),
            preparedFrame,
          ].slice(-2);
          return preparedFrame;
        }
        return null;
      })
      .finally(() => {
        preparedFrameInFlight = null;
        // A safety net only: the worker restores the panel as soon as it has
        // the pixels. This covers a capture that never got that far.
        restoreCaptureOverlays();
        lastPreparedFrameAt = Date.now();
        preparedFrameWantedSince = 0;
        if (!preparedFrameSchedulingAllowed()) return;
        // Only re-arm when there is nothing usable in hand. A frame that still
        // matches the page needs no replacement, and the visual-change, scroll
        // and resize paths re-arm the moment the page actually moves — so an
        // idle page stops capturing entirely instead of screenshotting forever.
        if (!frameIsEligible()) schedulePreparedFrame();
      });
    preparedFrameInFlight = operation;
    return operation;
  }

  function showPrivacyVeil() {
    if (state.policy.smartBlurEnabled !== true) return;
    if (privacyVeilEl?.isConnected) return;
    const root = document.documentElement || document.body;
    if (!root) return;
    const veil = document.createElement("div");
    veil.dataset.knowhowOverlay = "privacy-veil";
    veil.setAttribute("aria-hidden", "true");
    root.append(veil);
    privacyVeilEl = veil;
  }

  function hidePrivacyVeil() {
    privacyVeilEl?.remove();
    privacyVeilEl = null;
  }

  // Screenshots need the veil out of the frame, but tearing the node out of the
  // DOM and rebuilding it made it flash back in a beat late — and nothing on
  // the restore path ever rebuilt it, so it simply stayed gone until the next
  // status change. Toggling visibility keeps the element alive and the
  // hide/restore pair symmetric.
  function suspendPrivacyVeilForCapture() {
    if (privacyVeilEl) privacyVeilEl.style.visibility = "hidden";
  }

  function resumePrivacyVeilAfterCapture() {
    if (privacyVeilEl) privacyVeilEl.style.visibility = "";
  }

  function startBlurPreviewTracking() {
    blurPreviewSuspended = false;
    showPrivacyVeil();
    if (!blurPreviewInterval) {
      blurPreviewInterval = setInterval(() => scheduleBlurPreview(), 1_500);
    }
    if (!blurPreviewObserver && (document.body || document.documentElement)) {
      blurPreviewObserver = new MutationObserver((mutations) => {
        let layoutChanged = false;
        let pageChanged = false;
        for (const mutation of mutations) {
          const target = mutation.target instanceof Element
            ? mutation.target
            : mutation.target.parentElement;
          if (target?.closest("[data-knowhow-ui],[data-knowhow-overlay]")) {
            continue;
          }
          if (
            mutation.type === "childList" &&
            [...mutation.addedNodes, ...mutation.removedNodes].every((node) => {
              const element =
                node instanceof Element ? node : node.parentElement;
              return Boolean(
                element?.closest?.(
                  "[data-knowhow-ui],[data-knowhow-overlay]",
                ),
              );
            })
          ) {
            continue;
          }
          if (mutation.type === "attributes") {
            const name = mutation.attributeName;
            if (name === "class") {
              const previous = mutation.oldValue || "";
              const nextValue = target?.getAttribute?.("class") || "";
              const withoutReveal = (value) =>
                value.replace(/\bknowhow-blur-revealed\b/g, "").replace(/\s+/g, " ").trim();
              if (withoutReveal(previous) === withoutReveal(nextValue)) continue;
              pageChanged = true;
              continue;
            }
            if (name === "style") {
              pageChanged = true;
              continue;
            }
            if (
              name === "hidden" ||
              name === "aria-hidden" ||
              name === "value" ||
              name === "src" ||
              name === "srcset"
            ) {
              layoutChanged = true;
              pageChanged = true;
            }
            continue;
          }
          if (
            mutation.type === "childList" ||
            mutation.type === "characterData"
          ) {
            layoutChanged = true;
            pageChanged = true;
          }
        }
        if (layoutChanged) {
          visualEpoch += 1;
          occluderBoxes = null;
          scheduleBlurPreview(0);
          // schedulePreparedFrame debounces and rate-limits internally, so a
          // page mutating in a tight loop re-arms one pending capture instead
          // of queueing a screenshot per batch.
          if (!liveOverlayScrolling) schedulePreparedFrame();
        } else if (pageChanged) {
          scheduleBlurPreview(liveOverlayScrolling ? 80 : 48);
        }
      });
      blurPreviewObserver.observe(document.body || document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: [
          "class",
          "style",
          "hidden",
          "aria-hidden",
          "value",
          "src",
          "srcset",
        ],
      });
    }
    syncSmartBlurUi();
    renderBlurPreview();
    schedulePreparedFrame(0);
  }

  function stopBlurPreviewTracking() {
    if (blurPreviewInterval) {
      clearInterval(blurPreviewInterval);
      blurPreviewInterval = null;
    }
    blurPreviewObserver?.disconnect();
    blurPreviewObserver = null;
    blurPreviewSuspended = false;
    liveOverlayScrolling = false;
    if (liveOverlayScrollTimer) {
      clearTimeout(liveOverlayScrollTimer);
      liveOverlayScrollTimer = null;
    }
    if (blurPreviewRestoreTimer) {
      clearTimeout(blurPreviewRestoreTimer);
      blurPreviewRestoreTimer = null;
    }
    clearPreparedFrameSchedule();
    preparedFrames = [];
    exitElementPicker();
    removeBlurPreview();
    syncSmartBlurUi();
  }

  // Hides KnowHow's own panel and nothing else, on the same lost-message
  // fallback as the full hide: a restore that never arrives must not leave the
  // author staring at a page with no Smart Blur controls.
  function hideCaptureChromeForCapture() {
    hideCaptureOverlays();
    if (captureChromeRestoreTimer) clearTimeout(captureChromeRestoreTimer);
    captureChromeRestoreTimer = setTimeout(() => {
      captureChromeRestoreTimer = null;
      restoreCaptureOverlays();
    }, 1_200);
  }

  function hideBlurPreviewForCapture() {
    blurPreviewSuspended = true;
    clearBlurReveal();
    suspendPrivacyVeilForCapture();
    if (blurPreviewRoot) blurPreviewRoot.style.visibility = "hidden";
    for (const host of scrollerOverlayHosts.values()) {
      host.style.visibility = "hidden";
    }
    hideCaptureOverlays();
    if (blurPreviewRestoreTimer) clearTimeout(blurPreviewRestoreTimer);
    // The background normally restores immediately after capture. This
    // fallback prevents a failed or cancelled screenshot from leaving the
    // author without their live privacy preview. A screenshot that is going to
    // happen has happened well inside this window; five seconds only meant a
    // lost restore message left the author staring at an unprotected page.
    blurPreviewRestoreTimer = setTimeout(() => {
      blurPreviewRestoreTimer = null;
      restoreBlurPreviewAfterCapture();
    }, 1_200);
  }

  function restoreBlurPreviewAfterCapture() {
    if (blurPreviewRestoreTimer) {
      clearTimeout(blurPreviewRestoreTimer);
      blurPreviewRestoreTimer = null;
    }
    blurPreviewSuspended = false;
    resumePrivacyVeilAfterCapture();
    if (blurPreviewRoot) blurPreviewRoot.style.visibility = "";
    for (const host of scrollerOverlayHosts.values()) {
      host.style.visibility = "";
    }
    // Put the hover reveal back where the pointer actually is, rather than
    // waiting for the next mouse move to notice.
    updateBlurReveal(lastPointerPoint);
    restoreCaptureOverlays();
  }

  function labelFor(element) {
    if (!(element instanceof Element)) return "";
    const labelledBy = element.getAttribute("aria-labelledby");
    const referencedLabel = labelledBy
      ? labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
      : "";
    // `element.labels` resolves both `label[for]` and wrapping labels natively,
    // with none of the escaping hazards of building an attribute selector.
    const explicitLabel = element.labels?.[0]?.textContent || "";
    return sanitizedText(
      element.getAttribute("aria-label") ||
      referencedLabel ||
      explicitLabel ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      element.textContent ||
      "",
    );
  }

  const CLICKABLE_TARGET_SELECTOR =
    "button,a,input,select,textarea,[role=button],[role=link],[role=tab],[tabindex]";

  function captureElement(target) {
    const candidates =
      typeof target?.composedPath === "function"
        ? target.composedPath()
        : [target];
    const element = candidates.find(
      (candidate) =>
        candidate instanceof Element &&
        !candidate.closest("[data-knowhow-ui],[data-knowhow-overlay]"),
    );
    return (
      element instanceof Element
        ? element.closest(CLICKABLE_TARGET_SELECTOR) || element
        : document.body
    );
  }

  /**
   * Names the clicked control the way a reader would say it out loud, so a
   * named button reads `Click "Support"` and a nameless one reads
   * `Click this button`. Labels are always sanitized first.
   */
  function targetName(element) {
    const label = labelFor(element);
    if (label) {
      const quoted = '"' + label.replace(/"/g, "'") + '"';
      return quoted;
    }
    const tag = element.tagName;
    const role = element.getAttribute("role");
    if (tag === "A" || role === "link") return "this link";
    if (
      tag === "BUTTON" ||
      role === "button" ||
      (tag === "INPUT" &&
        /^(?:button|submit|reset)$/i.test(element.type || ""))
    ) {
      return "this button";
    }
    if (tag === "SELECT" || role === "listbox" || role === "combobox") {
      return "this menu";
    }
    if (tag === "INPUT" || tag === "TEXTAREA") return "this field";
    return "here";
  }

  function targetContext(target, point, viewport = viewportSnapshot()) {
    const element = captureElement(target);
    const targetRect = rectFor(element, "click-target");
    const name = targetName(element);
    const clickPoint = {
      x: Math.min(viewport.width, Math.max(0, Number(point?.x) || 0)),
      y: Math.min(viewport.height, Math.max(0, Number(point?.y) || 0)),
    };
    return {
      targetRect,
      clickPoint,
      viewport,
      title: "Click " + name,
      instructions: "Click " + name + ".",
      sanitizedUrl: sanitizedPageUrl(),
      pageUrl: sanitizedPageUrl(),
      navigationKey: state.navigationKey,
      visualEpoch,
    };
  }

  function pageContext() {
    const safeTitle = sanitizedText(document.title) || "the next page";
    return {
      masks: serializableMasks(collectMasks()),
      targetRect: null,
      clickPoint: null,
      viewport: viewportSnapshot(),
      title: safeTitle,
      instructions: "Continue on " + safeTitle + ".",
      sanitizedUrl: sanitizedPageUrl(),
      pageUrl: sanitizedPageUrl(),
      navigationKey: state.navigationKey,
      visualEpoch,
      viewportKey: viewportKey(),
    };
  }

  let recordingFlashEl = null;
  let recordingFlashHideTimer = null;
  let recordingFlashUntilMs = 0;

  const RECORDING_FLASH_HOLD_MS = 1_100;
  const RECORDING_FLASH_FADE_MS = 450;

  /** True while the start-of-recording flash is still meant to be on screen. */
  function recordingFlashPlaying() {
    return Date.now() < recordingFlashUntilMs;
  }

  // A brief full-viewport dim + "Recording started/resumed" flash gives clear
  // feedback that capture is live, without leaving any persistent page UI
  // that could show up in later screenshots. It is force-removed immediately
  // before every screenshot opportunity below, so it can never be captured.
  function removeRecordingFlash() {
    if (recordingFlashHideTimer) {
      clearTimeout(recordingFlashHideTimer);
      recordingFlashHideTimer = null;
    }
    recordingFlashUntilMs = 0;
    if (recordingFlashEl) {
      recordingFlashEl.remove();
      recordingFlashEl = null;
    }
  }

  function showRecordingFlash(label) {
    if (state.policy.showRecordingIndicator === false) return;
    const root = document.body || document.documentElement;
    if (!root) return;
    removeRecordingFlash();
    // The dim is a background colour on the backdrop rather than an opacity on
    // the whole overlay, so the badge sitting on top of it stays at full
    // strength — the page recedes, the message does not.
    const flash = document.createElement("div");
    // Marked as KnowHow's own UI. Without this the blur observer counted the
    // flash appearing and disappearing as page work, bumped `visualEpoch`, and
    // threw away the pre-warmed frame the author's first click was meant to
    // adopt — and the detectors would happily try to cover its own text.
    flash.dataset.knowhowUi = "recording-flash";
    flash.setAttribute("aria-hidden", "true");
    flash.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:flex;" +
      "align-items:center;justify-content:center;" +
      "background:rgba(8,10,20,.58);opacity:1;pointer-events:none;" +
      "animation:knowhow-recording-in .22s ease both;";
    const badge = document.createElement("div");
    badge.style.cssText =
      "display:flex;align-items:center;gap:12px;padding:16px 28px;" +
      "border-radius:999px;background:rgba(17,20,30,.96);color:#fff;" +
      "font:650 17px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "box-shadow:0 18px 44px rgba(0,0,0,.45);letter-spacing:.01em;" +
      "animation:knowhow-recording-badge .22s cubic-bezier(.2,.8,.3,1) both;";
    const dot = document.createElement("span");
    dot.style.cssText =
      "width:11px;height:11px;border-radius:50%;background:#ef4444;" +
      "animation:knowhow-recording-pulse 1.4s ease-out infinite;";
    const style = document.createElement("style");
    // The fade-in is a CSS animation rather than a transition driven from
    // `requestAnimationFrame`. A deferred frame — a busy compositor, a tab that
    // has only just been shown — used to leave the whole overlay sitting at
    // zero opacity, so the announcement the author was supposed to see never
    // painted at all. An animation runs from the element's first frame.
    style.textContent =
      "@keyframes knowhow-recording-pulse{" +
      "0%{box-shadow:0 0 0 0 rgba(239,68,68,.55)}" +
      "70%{box-shadow:0 0 0 10px rgba(239,68,68,0)}" +
      "100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}" +
      "@keyframes knowhow-recording-in{from{opacity:0}to{opacity:1}}" +
      "@keyframes knowhow-recording-badge{" +
      "from{transform:scale(.96)}to{transform:scale(1)}}";
    const text = document.createElement("span");
    text.textContent = label;
    badge.append(dot, text);
    flash.append(style, badge);
    root.appendChild(flash);
    recordingFlashEl = flash;
    recordingFlashUntilMs =
      Date.now() + RECORDING_FLASH_HOLD_MS + RECORDING_FLASH_FADE_MS;
    recordingFlashHideTimer = setTimeout(() => {
      if (recordingFlashEl !== flash) return;
      flash.style.animation = "none";
      flash.style.transition = `opacity ${RECORDING_FLASH_FADE_MS}ms ease`;
      flash.style.opacity = "0";
      recordingFlashHideTimer = setTimeout(() => {
        if (recordingFlashEl !== flash) return;
        removeRecordingFlash();
        // Pre-warming was held back while this played; get a frame ready now
        // so the author's first click still has one to adopt.
        schedulePreparedFrame(0);
      }, RECORDING_FLASH_FADE_MS);
    }, RECORDING_FLASH_HOLD_MS);
  }

  /**
   * `announce` is the worker's decision, not this document's. Inferring it from
   * a local status change was wrong twice over: a page that had already carried
   * one capture reported the next one as "resumed", and every navigation during
   * a capture dimmed the whole destination page as if recording had just begun.
   * Only a real start or resume announces anything now.
   */
  function setStatus(status, { announce = null } = {}) {
    state.status = status;
    if (status !== "recording") {
      removeRecordingFlash();
      removeHoverTarget();
      if (pendingPointer) cancelStagedInteraction(pendingPointer);
      pendingPointer = null;
      // The worker stops accepting events before it tells the page, so an
      // in-flight edit cannot be turned into a step here. Drop it rather than
      // leave it to reappear against the next session.
      forgetTypedField();
      lastTypedStep = null;
      preparedFrames = [];
      clearPreparedFrameSchedule();
    }
    if (status === "recording" && announce) {
      showRecordingFlash(
        announce === "resumed" ? "Recording resumed" : "Recording started",
      );
    }
    if (status === "recording" || status === "paused") {
      startBlurPreviewTracking();
    } else {
      stopBlurPreviewTracking();
    }
  }

  function waitForPagePaint(maxMs = 80) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, Math.max(0, maxMs));
    });
  }

  // A screenshot request dispatched from a normal async call loses the race
  // against whatever this action is about to do to the page: `chrome.runtime
  // .sendMessage` returns immediately, but the browser still has to composite
  // and encode a frame before the page navigates, opens a dialog, or rewrites
  // itself out from under the shot. The fix is not a faster capture — it is
  // holding this document's own JavaScript still for a few milliseconds so
  // nothing on the page can run before the request has left it. The message
  // itself is not slowed by this: dispatching it to the browser process is a
  // native call that fires as part of the `sendMessage` call above, not
  // something gated behind this thread going idle.
  function stallForEarlyCapture(ms) {
    const until = performance.now() + Math.min(Math.max(0, Number(ms) || 0), 200);
    while (performance.now() < until) {
      // Intentionally busy: yielding would let the click's default action
      // repaint the page before the snapshot is taken. Do not preventDefault.
    }
  }

  const EARLY_CAPTURE_STALL_MS = 70;

  /**
   * The one place a step's own screenshot gets requested. Called first, before
   * any selector, label, or mask work — the only thing here that has to win a
   * race against the page's own JavaScript is the pixel grab; everything else
   * can happen once that race is already won. KnowHow's own panel comes out of
   * shot in the same breath, locally, so there is no round trip to hide it
   * before the capture that matters.
   */
  function requestInteractionFrame() {
    const frameId = crypto.randomUUID();
    removeRecordingFlash();
    hideCaptureChromeForCapture();
    void send({
      type: "REQUEST_INTERACTION_FRAME",
      sessionId: state.sessionId,
      frameId,
      navigationKey: state.navigationKey,
      viewport: viewportSnapshot(),
      masks: Array.isArray(lastSerializableMasks)
        ? lastSerializableMasks.slice()
        : [],
    });
    stallForEarlyCapture(EARLY_CAPTURE_STALL_MS);
    return frameId;
  }

  function stageInteraction(
    element,
    context,
    sourceEvent = "click",
    { frameId = null } = {},
  ) {
    const interactionId = crypto.randomUUID();
    const staged = {
      interactionId,
      element,
      context: {
        ...context,
        masks: Array.isArray(lastSerializableMasks)
          ? lastSerializableMasks.slice()
          : [],
      },
      sourceEvent,
      frameId,
      committed: false,
      cancelled: false,
      stagePromise: null,
    };
    // Reserve the feed card without walking the DOM. Cached masks from the
    // last remask are enough for bake; the worker's own screenshot for this
    // interaction is already in flight and only delays when the JPEG lands.
    staged.stagePromise = send({
      type: "STAGE_INTERACTION",
      sessionId: state.sessionId,
      interactionId,
      frameId,
      sourceEvent,
      navigationKey: state.navigationKey,
      visualEpoch,
      viewportKey: viewportKey(context.viewport),
      context: staged.context,
    });
    return staged;
  }

  function commitStagedInteraction(staged) {
    if (!staged || staged.cancelled || staged.committed) return;
    staged.committed = true;
    const commit = {
      type: "COMMIT_INTERACTION",
      sessionId: state.sessionId,
      interactionId: staged.interactionId,
    };
    // Dispatch immediately from the trusted click handler so a same-tab
    // navigation cannot destroy this document before the commit leaves it.
    // The acknowledgement retry makes this safe even if COMMIT reaches a
    // freshly awakened worker just ahead of STAGE; the ledger is idempotent.
    void send(commit);
    void staged.stagePromise.then((response) => {
      if (response?.ok !== true || staged.cancelled) return;
      return send(commit);
    });
    if (staged.sourceEvent !== "type") {
      lastCommittedClick = {
        interactionId: staged.interactionId,
        element: staged.element,
        context: staged.context,
        at: performance.now(),
      };
      // Once the author has done something else, coming back to a field is a
      // new instruction rather than a correction of the old one.
      lastTypedStep = null;
    }
    schedulePreparedFrame(160);
  }

  function cancelStagedInteraction(staged) {
    if (!staged || staged.cancelled) return;
    staged.cancelled = true;
    restoreCaptureOverlays();
    void staged.stagePromise.then(() =>
      send({
        type: "CANCEL_INTERACTION",
        sessionId: state.sessionId,
        interactionId: staged.interactionId,
      }),
    );
  }

  function upgradeLastClickToDouble(element) {
    const last = lastCommittedClick;
    if (
      !last ||
      last.element !== element ||
      performance.now() - last.at > DOUBLE_CLICK_WINDOW_MS
    ) {
      return false;
    }
    const name = last.context.title.replace(/^Click /, "");
    void send({
      type: "UPGRADE_INTERACTION",
      sessionId: state.sessionId,
      interactionId: last.interactionId,
      sourceEvent: "dblclick",
      title: "Double-click " + name,
      instructions: "Double-click " + name + ".",
    });
    lastCommittedClick = null;
    return true;
  }

  function upgradeLastClickToSelect(element) {
    const last = lastCommittedClick;
    if (!last) return false;
    const related =
      last.element === element ||
      (last.element instanceof Element &&
        (last.element.contains(element) ||
          (element instanceof Element && element.contains(last.element))));
    if (!related) return false;
    const optionText =
      element instanceof HTMLSelectElement
        ? sanitizedText(element.selectedOptions[0]?.textContent || "")
        : sanitizedText(
            element.querySelector?.("[aria-selected=true]")?.textContent ||
              element.textContent ||
              "",
          );
    if (!optionText) return false;
    const quoted = '"' + optionText.replace(/"/g, "'") + '"';
    void send({
      type: "UPGRADE_INTERACTION",
      sessionId: state.sessionId,
      interactionId: last.interactionId,
      sourceEvent: "select",
      title: "Select the " + quoted + " option",
      instructions: "Select the " + quoted + " option.",
    });
    return true;
  }

  function onSelectChange(event) {
    if (state.status !== "recording" || !event.isTrusted) return;
    const element = event.target;
    if (
      !(element instanceof HTMLSelectElement) &&
      element?.getAttribute?.("role") !== "listbox" &&
      element?.getAttribute?.("role") !== "combobox"
    ) {
      return;
    }
    upgradeLastClickToSelect(element);
  }

  // ---------------------------------------------------------------------------
  // Typed text
  //
  // A guide that says "click the search box" and stops is useless: the reader
  // needs to know what to type. KnowHow therefore records the text an author
  // enters into ordinary fields — and never the text of a credential field.
  // `editableFieldKind` classifies the field first, and `typedFieldText` is the
  // one place in this script that reads a field at all; it refuses every kind
  // except "text", so a password, a username, a one-time code or a card number
  // is recorded as an instruction ("Enter your password") with no value behind
  // it.
  // ---------------------------------------------------------------------------

  function fieldHintText(element) {
    return [
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
      element.labels?.[0]?.textContent,
    ]
      .filter(Boolean)
      .join(" ");
  }

  // How many fields in this form could hold typed text at all. A form with one
  // of them beside a password is a sign-in box; a form with six is a sign-up
  // page, where only the field that names the account is off limits.
  function typedFieldCount(form) {
    let count = 0;
    for (const field of form.querySelectorAll("input,textarea")) {
      const type = String(field.getAttribute("type") || "text").toLowerCase();
      if (
        field.tagName === "INPUT" &&
        (typedFields.untypedInputTypes.has(type) || type === "password")
      ) {
        continue;
      }
      count += 1;
    }
    return count;
  }

  // Reads the signals off the element; `classifyField` owns the rule itself so
  // the credential exclusions can be tested without a browser.
  function editableFieldKind(element) {
    if (!(element instanceof Element) || !element.isConnected) return null;
    if (element.closest("[data-knowhow-ui],[data-knowhow-overlay]")) return null;
    const tag = element.tagName;
    const form = tag === "INPUT" || tag === "TEXTAREA" ? element.form : null;
    return typedFields.classifyField({
      tag,
      inputType: element.getAttribute("type") || "text",
      autocomplete: element.getAttribute("autocomplete") || "",
      contentEditable: element.isContentEditable === true,
      redactAttribute: element.hasAttribute("data-knowhow-redact"),
      inCredentialForm: Boolean(form?.querySelector("input[type=password]")),
      formTextFieldCount: form ? typedFieldCount(form) : 0,
      hint: fieldHintText(element),
    });
  }

  /**
   * The only read of a field's contents in this script. Every classification
   * except "text" returns before the field is touched, and what comes back has
   * already been through the session's redaction policy.
   */
  function typedFieldText(element, kind) {
    if (kind !== "text") return "";
    const raw =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
        ? element.value
        : element.textContent;
    return sanitizedText(raw);
  }

  // The field the author is still typing into, and the step already minted for
  // it. Coming back to the same field rewrites that step instead of adding a
  // second one, so "acme" then "acme-invoices" stays one instruction.
  let pendingTypedField = null;
  let lastTypedStep = null;
  const TYPED_STEP_REUSE_MS = 60_000;

  function forgetTypedField() {
    pendingTypedField = null;
  }

  // A field is only read once the author has finished with it — on blur, on
  // `change`, or when they press on something else. There is deliberately no
  // idle timer: a pause in the middle of a word is not the end of a value, and
  // settling on one turned "test" into a step that said "te" and a screenshot
  // to match. Finishing a capture straight after typing is covered instead by
  // the worker asking this document to flush before it stops listening.
  function noteTypedInput(event) {
    if (state.status !== "recording" || !event.isTrusted) return;
    if (state.policy.captureTypedText === false) return;
    const element = event.target;
    const kind = editableFieldKind(element);
    if (!kind) return;
    if (pendingTypedField && pendingTypedField.element !== element) {
      flushTypedField();
    }
    pendingTypedField = { element, kind };
  }

  function flushTypedField() {
    const pending = pendingTypedField;
    forgetTypedField();
    if (!pending || pickerActive || state.status !== "recording") return null;
    if (state.policy.captureTypedText === false) return null;
    const { element, kind } = pending;
    if (!(element instanceof Element) || !element.isConnected) return null;

    // Coming back to the same field only ever rewords its existing step —
    // never worth spending a screenshot on.
    const reusable =
      lastTypedStep &&
      lastTypedStep.element === element &&
      performance.now() - lastTypedStep.at <= TYPED_STEP_REUSE_MS;
    if (reusable) {
      const text = typedFieldText(element, kind);
      const copy = typedFields.typedStepCopy(kind, text, targetName(element));
      if (lastTypedStep.title === copy.title) return null;
      lastTypedStep.title = copy.title;
      lastTypedStep.at = performance.now();
      void send({
        type: "UPGRADE_INTERACTION",
        sessionId: state.sessionId,
        interactionId: lastTypedStep.interactionId,
        sourceEvent: "type",
        title: copy.title,
        instructions: copy.instructions,
      });
      return null;
    }

    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    // Typing changes no attribute and adds no node, so the request goes out
    // before the label/selector lookups below just as it does for a click —
    // there is no visual-change signal to hang a screenshot on otherwise.
    const frameId = requestInteractionFrame();
    const text = typedFieldText(element, kind);
    const copy = typedFields.typedStepCopy(kind, text, targetName(element));
    const viewport = viewportSnapshot();
    const context = targetContext(
      element,
      { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      viewport,
    );
    const staged = stageInteraction(
      element,
      { ...context, title: copy.title, instructions: copy.instructions },
      "type",
      { frameId },
    );
    commitStagedInteraction(staged);
    lastTypedStep = {
      interactionId: staged.interactionId,
      element,
      title: copy.title,
      at: performance.now(),
    };
    return staged;
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  //
  // A guide that shows a copy and a paste but never says Ctrl+C is missing the
  // step. `classifyShortcut` decides what counts — chords, and the action keys
  // pressed outside a field — and refuses everything else, so ordinary typing
  // is never watched key by key and a password field is never read at all. The
  // key names it returns describe the chord, not anything the author entered.
  // ---------------------------------------------------------------------------
  function onShortcutKeyDown(event) {
    if (pickerActive || isKnowHowUiEvent(event)) return;
    if (state.status !== "recording" || !event.isTrusted) return;
    const focused = document.activeElement;
    const fieldKind = editableFieldKind(focused);
    const shortcut = typedFields.classifyShortcut({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      inEditableField: Boolean(fieldKind),
      fieldKind,
      isMac: /Mac|iPhone|iPad/i.test(navigator.platform || ""),
    });
    if (!shortcut) return;

    // A shortcut acting on a field the author just filled comes after it.
    if (pendingTypedField) flushTypedField();

    const frameId = requestInteractionFrame();
    const copy = typedFields.shortcutStepCopy(shortcut);
    const staged = stageInteraction(
      focused instanceof Element ? focused : document.body,
      {
        targetRect: null,
        clickPoint: null,
        viewport: viewportSnapshot(),
        title: copy.title,
        instructions: copy.instructions,
        keys: shortcut.keys,
        sanitizedUrl: sanitizedPageUrl(),
        pageUrl: sanitizedPageUrl(),
        navigationKey: state.navigationKey,
        visualEpoch,
      },
      "shortcut",
      { frameId },
    );
    commitStagedInteraction(staged);
  }

  function isKnowHowUiEvent(event) {
    return event.composedPath().some(
      (item) => item instanceof Element && item.closest("[data-knowhow-ui]"),
    );
  }

  function onPointerDown(event) {
    if (pickerActive) {
      if (!isKnowHowUiEvent(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        updatePickerHighlight(pickerElementFromEvent(event));
      }
      return;
    }
    if (isKnowHowUiEvent(event)) return;
    // A pointer down on anything else ends the edit in progress. Flushing here
    // rather than on blur keeps the typed step ahead of the click that submits
    // it, which is the order the reader has to follow them in.
    if (pendingTypedField && pendingTypedField.element !== event.target) {
      flushTypedField();
    }
    if (pendingPointer) cancelStagedInteraction(pendingPointer);
    pendingPointer = null;
    if (state.status !== "recording" || !event.isTrusted) return;
    if (event.isPrimary === false || ![0, 2].includes(event.button)) return;

    // Requested before touching the DOM: the target, its label, and the click
    // point are bookkeeping the page cannot outrun. Only the pixel grab can be
    // outrun, so it is the only thing dispatched before any of that work.
    const frameId = requestInteractionFrame();
    const element = captureElement(event);
    const viewport = viewportSnapshot();
    let context = targetContext(
      element,
      { x: event.clientX, y: event.clientY },
      viewport,
    );
    if (!context.targetRect) {
      restoreCaptureOverlays();
      return;
    }
    const sourceEvent = event.button === 2 ? "contextmenu" : "click";
    if (sourceEvent === "contextmenu") {
      const name = context.title.replace(/^Click /, "");
      context = {
        ...context,
        title: "Right-click " + name,
        instructions: "Right-click " + name + ".",
      };
    }
    pendingPointer = Object.assign(
      stageInteraction(element, context, sourceEvent, { frameId }),
      {
        pointerId: event.pointerId,
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        startedAt: performance.now(),
      },
    );
  }

  function onPointerMove(event) {
    if (onPickerPointerMove(event)) return;
    lastPointerPoint = { x: event.clientX, y: event.clientY };
    const overKnowHowUi = isKnowHowUiEvent(event);
    if (overKnowHowUi) {
      clearPreparedFrameSchedule();
      updateHoverTarget(null);
      clearBlurReveal();
    } else {
      updateBlurReveal(lastPointerPoint);
    }
    if (state.status === "recording" && !overKnowHowUi) {
      updateHoverTarget(captureElement(event));
    } else if (!overKnowHowUi) {
      updateHoverTarget(null);
    }
    const active = pendingPointer;
    if (!active || event.pointerId !== active.pointerId) return;
    if (
      Math.hypot(
        event.clientX - active.clientX,
        event.clientY - active.clientY,
      ) <= POINTER_MOVE_TOLERANCE
    ) {
      return;
    }
    pendingPointer = null;
    cancelStagedInteraction(active);
  }

  function onPointerCancel(event) {
    if (pendingPointer && event.pointerId === pendingPointer.pointerId) {
      cancelStagedInteraction(pendingPointer);
      pendingPointer = null;
    }
  }

  function onPickerPointerUp(event) {
    if (!pickerActive || isKnowHowUiEvent(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  // A right-click that opens the native context menu is captured as its own
  // step, matching the extension's right-click capture behavior.
  function onContextMenu(event) {
    if (pickerActive) {
      if (!isKnowHowUiEvent(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (isKnowHowUiEvent(event)) return;
    if (state.status !== "recording" || !event.isTrusted) return;
    const staged = pendingPointer;
    pendingPointer = null;
    if (staged?.button === 2) commitStagedInteraction(staged);
  }

  function onClick(event) {
    if (onPickerClick(event)) {
      pendingPointer = null;
      return;
    }
    if (isKnowHowUiEvent(event)) {
      pendingPointer = null;
      return;
    }
    if (state.status !== "recording" || !event.isTrusted) {
      pendingPointer = null;
      return;
    }
    if (event.detail === 0) {
      pendingPointer = null;
      // A keyboard activation (Enter/Space on a focused control) has no
      // pointerdown to hang the request on; the click event is the earliest
      // hook there is.
      const frameId = requestInteractionFrame();
      const element = captureElement(event);
      const viewport = viewportSnapshot();
      const targetRect = rectFor(element, "click-target");
      if (!targetRect) {
        restoreCaptureOverlays();
        return;
      }
      const staged = stageInteraction(
        element,
        targetContext(
          element,
          {
            x: targetRect.x + targetRect.width / 2,
            y: targetRect.y + targetRect.height / 2,
          },
          viewport,
        ),
        "click",
        { frameId },
      );
      commitStagedInteraction(staged);
      return;
    }

    const staged = pendingPointer;
    pendingPointer = null;
    if (!staged) return;
    if (
      performance.now() - staged.startedAt > POINTER_COMMIT_WINDOW_MS ||
      !event.composedPath().includes(staged.element)
    ) {
      cancelStagedInteraction(staged);
      return;
    }
    if (event.detail > 1) {
      cancelStagedInteraction(staged);
      upgradeLastClickToDouble(staged.element);
      return;
    }
    commitStagedInteraction(staged);
  }

  function onDoubleClick(event) {
    if (isKnowHowUiEvent(event)) return;
    if (state.status !== "recording" || !event.isTrusted) return;
    upgradeLastClickToDouble(captureElement(event));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "KNOWHOW_CONFIGURE") {
      if (
        state.navigationKey &&
        message.navigationKey &&
        state.navigationKey !== message.navigationKey
      ) {
        clearManualSelections();
        preparedFrameNeedsSettle = true;
      }
      state.sessionId = message.sessionId;
      state.policy = message.policy || {};
      state.documentId = message.documentId || null;
      state.navigationKey = message.navigationKey || sanitizedPageUrl();
      preparedFrameNeedsSettle = true;
      setStatus(message.status || "recording");
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KNOWHOW_UPDATE_POLICY") {
      state.policy = message.policy || {};
      syncSmartBlurUi();
      noteVisualChange(0);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KNOWHOW_WAKE_SMART_BLUR") {
      if (
        state.sessionId &&
        (state.status === "recording" || state.status === "paused")
      ) {
        showPrivacyVeil();
        startBlurPreviewTracking();
        renderBlurPreview();
        sendResponse({ ok: true });
        return false;
      }
      sendResponse({ ok: false });
      return false;
    }
    if (message?.type === "KNOWHOW_SET_STATUS") {
      setStatus(message.status, { announce: message.announce });
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KNOWHOW_TOGGLE_SMART_BLUR_PANEL") {
      smartBlurPanelOpen = !smartBlurPanelOpen;
      clearPreparedFrameSchedule();
      syncSmartBlurUi();
      if (!smartBlurPanelOpen) schedulePreparedFrame(0);
      sendResponse({ ok: true, open: smartBlurPanelOpen });
      return false;
    }
    if (message?.type === "KNOWHOW_RESET_PAGE_SESSION") {
      state.navigationKey = message.navigationKey || sanitizedPageUrl();
      preparedFrameNeedsSettle = true;
      clearManualSelections();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KNOWHOW_WAIT_PAGE_SETTLED") {
      void (async () => {
        const waiter = globalThis.__KNOWHOW_PAGE_SETTLED__;
        if (typeof waiter?.waitForPageSettled === "function") {
          await waiter.waitForPageSettled();
        }
        preparedFrameNeedsSettle = false;
        sendResponse({ ok: true });
      })();
      return true;
    }
    if (message?.type === "KNOWHOW_PREPARE_SCREENSHOT") {
      removeRecordingFlash();
      const context = pageContext();
      // A pre-warm leaves the blur preview in the shot on purpose — the bake
      // re-applies every mask from its own coordinates, and tearing the largest
      // overlay down and back up is the flicker that made Smart Blur look
      // broken. Only KnowHow's own panel has to go.
      if (message.chromeOnly === true && smartBlurUiIsEngaged()) {
        sendResponse({ ok: false, busy: true });
        return false;
      }
      if (message.chromeOnly === true) hideCaptureChromeForCapture();
      else hideBlurPreviewForCapture();
      void waitForPagePaint().then(() => {
        sendResponse({ ok: true, context });
      });
      return true;
    }
    if (message?.type === "KNOWHOW_CAPTURE_SETTLED_FRAME") {
      void (async () => {
        const waiter = globalThis.__KNOWHOW_PAGE_SETTLED__;
        if (typeof waiter?.waitForPageSettled === "function") {
          await waiter.waitForPageSettled();
        }
        removeRecordingFlash();
        const context = pageContext();
        hideBlurPreviewForCapture();
        await waitForPagePaint();
        sendResponse({ ok: true, context });
      })();
      return true;
    }
    if (message?.type === "KNOWHOW_RESTORE_PRIVACY_PREVIEW") {
      restoreBlurPreviewAfterCapture();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KNOWHOW_FLUSH_PENDING_INPUT") {
      // Sent while the worker is still accepting events, so a value the author
      // typed and never blurred out of — because they went straight for Finish
      // or Pause — becomes a step before the door closes. Answering only once
      // the stage message has landed is what makes that safe.
      const staged = flushTypedField();
      if (!staged?.stagePromise) {
        sendResponse({ ok: true, flushed: false });
        return false;
      }
      void staged.stagePromise.then(() =>
        sendResponse({ ok: true, flushed: true }),
      );
      return true;
    }
    if (message?.type === "KNOWHOW_RESTORE_CAPTURE_CHROME") {
      // The light counterpart to the hide requestInteractionFrame() applies
      // locally: only KnowHow's own panel came out of shot, so only that comes
      // back. A missed message is already covered by hideCaptureChromeForCapture's
      // own timer, so there is nothing to verify here.
      restoreCaptureOverlays();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KNOWHOW_GET_PAGE_CONTEXT") {
      removeRecordingFlash();
      const context = pageContext();
      hideBlurPreviewForCapture();
      void waitForPagePaint().then(() => {
        sendResponse({ ok: true, context });
      });
      return true;
    }
    if (message?.type === "KNOWHOW_VERIFY_DOCUMENT") {
      sendResponse({
        ok: true,
        sanitizedUrl: sanitizedPageUrl(),
        visualEpoch,
        viewportKey: viewportKey(),
        navigationKey: state.navigationKey,
      });
      return false;
    }
    return false;
  });

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPickerPointerUp, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("dblclick", onDoubleClick, true);
  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("keydown", onPickerKeyDown, true);
  document.addEventListener("keydown", onShortcutKeyDown, true);
  document.addEventListener("pointerleave", () => {
    lastPointerPoint = null;
    updateBlurReveal(null);
    updateHoverTarget(null);
  }, true);
  document.addEventListener("scroll", onLiveOverlayScroll, true);
  addEventListener("scroll", onLiveOverlayScroll, true);
  addEventListener("resize", () => {
    visualEpoch += 1;
    occluderBoxes = null;
    scheduleBlurPreview(0);
    schedulePreparedFrame(200);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      schedulePreparedFrame();
    } else {
      clearPreparedFrameSchedule();
    }
  });
  document.addEventListener("input", (event) => {
    noteTypedInput(event);
    noteVisualChange(140);
  }, true);
  document.addEventListener("change", (event) => {
    onSelectChange(event);
    // `change` on a text field is the browser telling us the edit is final:
    // it fires on Enter as well as on blur, so this covers a form submitted
    // straight from the keyboard.
    if (pendingTypedField?.element === event.target) flushTypedField();
    noteVisualChange(140);
  }, true);
  document.addEventListener("focusout", (event) => {
    if (pendingTypedField?.element === event.target) flushTypedField();
  }, true);

  globalThis[INSTANCE_KEY] = {
    announce() {
      void send({ type: "CONTENT_READY", sessionId: state.sessionId });
    },
  };
  void send({ type: "CONTENT_READY", sessionId: state.sessionId });
})();
