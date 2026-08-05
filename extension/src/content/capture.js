(() => {
  "use strict";

  const INSTANCE_KEY = "__RIVET_CAPTURE_INSTANCE_V1__";
  if (globalThis[INSTANCE_KEY]) {
    globalThis[INSTANCE_KEY].announce();
    return;
  }

  const state = {
    sessionId: null,
    status: "idle",
    policy: {},
  };
  let pendingPointer = null;
  let deferredClick = null;
  let interactionSequence = 0;

  const POINTER_MOVE_TOLERANCE = 6;
  const POINTER_COMMIT_WINDOW_MS = 3_000;
  const DEFERRED_REPLY_TIMEOUT_MS = 2_500;

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  function sanitizedText(value) {
    let output = String(value || "").replace(/\s+/g, " ").trim();
    const replacements = [
      [
        state.policy.redactEmails !== false,
        /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
      ],
      [
        state.policy.redactPhoneNumbers !== false,
        /(?:\+?\d[\d\s().-]{7,}\d)/g,
      ],
      [
        state.policy.redactFinancialNumbers !== false,
        /(?:\b\d[ -]*?){13,19}\b/g,
      ],
      [
        state.policy.redactIds !== false,
        /\b(?=[A-Z0-9-]{8,}\b)(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,}\b/gi,
      ],
      [state.policy.redactAllNumbers === true, /\d+/g],
      [
        state.policy.redactCommonNames === true,
        /\b[A-Z][a-z]{1,30}(?:[-'][A-Z]?[a-z]+)?\s+[A-Z][a-z]{1,30}(?:[-'][A-Z]?[a-z]+)?\b/g,
      ],
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
      return rangeFindings(decoded).length
        ? "[redacted]"
        : encodeURIComponent(decoded.slice(0, 100));
    });
    return location.origin + segments.join("/");
  }

  function rectFor(element, reason) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right);
    const bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return null;
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      reason,
    };
  }

  function viewportSnapshot() {
    const visual = globalThis.visualViewport;
    return {
      width: Math.max(1, innerWidth),
      height: Math.max(1, innerHeight),
      devicePixelRatio: Math.max(1, Number(globalThis.devicePixelRatio) || 1),
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

  function visible(element) {
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
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    );
  }

  function formFieldMasks() {
    const selectors = state.policy.redactFormFields
      ? [
          "input:not([type=button]):not([type=submit]):not([type=reset])",
          "textarea",
          "select",
          "[contenteditable=true]",
        ]
      : [
          "input[type=password]",
          "[autocomplete*=password]",
          "[autocomplete=one-time-code]",
          "[autocomplete=cc-number]",
        ];
    if (state.policy.redactEmails !== false) {
      selectors.push("input[type=email]", "[autocomplete=email]");
    }
    if (state.policy.redactPhoneNumbers !== false) {
      selectors.push("input[type=tel]", "[autocomplete=tel]");
    }
    selectors.push("[data-rivet-redact]");
    const selector = selectors.join(",");
    return Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .map((element) =>
        rectFor(
          element,
          element.matches("input[type=password],[autocomplete*=password]")
            ? "password-field"
            : "form-field",
        ),
      )
      .filter(Boolean);
  }

  function rangeFindings(text) {
    const findings = [];
    const detectors = [
      [
        state.policy.redactEmails !== false,
        "email",
        /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
      ],
      [
        state.policy.redactPhoneNumbers !== false,
        "phone",
        /(?:\+?\d[\d\s().-]{7,}\d)/g,
      ],
      [
        state.policy.redactFinancialNumbers !== false,
        "financial-number",
        /(?:\b\d[ -]*?){13,19}\b/g,
      ],
      [
        state.policy.redactIds !== false,
        "identifier",
        /\b(?=[A-Z0-9-]{8,}\b)(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,}\b/gi,
      ],
      [state.policy.redactAllNumbers === true, "number", /\d+/g],
      [
        state.policy.redactCommonNames === true,
        "common-name",
        /\b[A-Z][a-z]{1,30}(?:[-'][A-Z]?[a-z]+)?\s+[A-Z][a-z]{1,30}(?:[-'][A-Z]?[a-z]+)?\b/g,
      ],
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

  function textMasks() {
    const masks = [];
    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_TEXT,
    );
    let node;
    let visited = 0;
    while ((node = walker.nextNode()) && visited < 1_500) {
      visited += 1;
      const parent = node.parentElement;
      if (
        !parent ||
        !visible(parent) ||
        parent.closest("script,style,noscript,svg")
      ) {
        continue;
      }
      const value = node.nodeValue || "";
      if (!value.trim()) continue;
      if (state.policy.redactLongText && value.trim().length >= 100) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          const mask = rectFor(
            {
              getBoundingClientRect: () => rect,
            },
            "long-text",
          );
          if (mask) masks.push(mask);
        }
        range.detach();
        continue;
      }
      for (const finding of rangeFindings(value)) {
        const range = document.createRange();
        range.setStart(node, finding.start);
        range.setEnd(node, finding.end);
        for (const rect of range.getClientRects()) {
          const mask = rectFor(
            {
              getBoundingClientRect: () => rect,
            },
            finding.reason,
          );
          if (mask) masks.push(mask);
        }
        range.detach();
      }
    }
    return masks;
  }

  function embeddedFrameMasks() {
    return Array.from(document.querySelectorAll("iframe"))
      .filter(visible)
      .map((frame) => rectFor(frame, "embedded-frame"))
      .filter(Boolean);
  }

  function optionalSurfaceMasks() {
    const masks = [];
    if (state.policy.redactImages) {
      for (const image of document.querySelectorAll("img,picture,canvas,video")) {
        if (visible(image)) {
          const mask = rectFor(image, "image");
          if (mask) masks.push(mask);
        }
      }
    }
    if (state.policy.redactTableRows) {
      for (const row of document.querySelectorAll("tr")) {
        if (visible(row)) {
          const mask = rectFor(row, "table-row");
          if (mask) masks.push(mask);
        }
      }
    }
    return masks;
  }

  function collectMasks() {
    return [
      ...formFieldMasks(),
      ...textMasks(),
      ...embeddedFrameMasks(),
      ...optionalSurfaceMasks(),
    ];
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
    const explicitLabel =
      element.id &&
      globalThis.CSS?.escape
        ? document.querySelector(
            "label[for=" + JSON.stringify(CSS.escape(element.id)) + "]",
          )?.textContent
        : "";
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

  function captureElement(target) {
    return (
      target instanceof Element
        ? target.closest(
            "button,a,input,select,textarea,[role=button],[role=link],[tabindex]",
          ) || target
        : document.body
    );
  }

  function targetContext(target, point, viewport = viewportSnapshot()) {
    const element = captureElement(target);
    const targetRect = rectFor(element, "click-target");
    const label = labelFor(element);
    const role =
      element.getAttribute("role") ||
      (element.tagName === "A"
        ? "link"
        : element.tagName === "BUTTON"
          ? "button"
          : element.tagName === "INPUT"
            ? "field"
            : "control");
    const safeRole = sanitizedText(role) || "control";
    const name = label || "the highlighted " + safeRole;
    const clickPoint = {
      x: Math.min(viewport.width, Math.max(0, Number(point?.x) || 0)),
      y: Math.min(viewport.height, Math.max(0, Number(point?.y) || 0)),
    };
    return {
      targetRect,
      clickPoint,
      viewport,
      title: "Select " + name,
      instructions: "Select " + name + ".",
      sanitizedUrl: sanitizedPageUrl(),
      pageUrl: sanitizedPageUrl(),
    };
  }

  function pageContext() {
    const safeTitle = sanitizedText(document.title) || "the next page";
    return {
      masks: collectMasks(),
      targetRect: null,
      clickPoint: null,
      viewport: viewportSnapshot(),
      title: safeTitle,
      instructions: "Continue on " + safeTitle + ".",
      sanitizedUrl: sanitizedPageUrl(),
      pageUrl: sanitizedPageUrl(),
    };
  }

  function setStatus(status) {
    state.status = status;
  }

  function waitForPagePaint() {
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }

  function sendCapturedInteraction(context, options = {}) {
    interactionSequence += 1;
    void send({
      type: "CAPTURE_EVENT",
      sessionId: state.sessionId,
      interactionSequence,
      preflight: options.preflight === true,
      context,
    });
  }

  // A pointerdown on an interactive control is deferred until the pre-click
  // screenshot is ready, so transient UI (menus, popovers) is still visible in
  // the captured step. Canceling pointerdown suppresses the compatibility
  // mousedown/mouseup/click events, then the click is synthesized after the
  // screenshot so the page still reacts normally.
  function deferrableTarget(element) {
    if (!(element instanceof Element)) return false;
    if (
      !element.matches(
        "button,a,input,select,textarea,[role=button],[role=link],[tabindex]",
      )
    ) {
      return false;
    }
    // Text-entry fields keep native behavior: caret placement and typing
    // matter more than transient UI, and their pickers open on click.
    if (
      element.matches(
        "textarea,[contenteditable=true],input:not([type]),input[type=text]," +
          "input[type=search],input[type=email],input[type=password]," +
          "input[type=tel],input[type=url],input[type=number]",
      )
    ) {
      return false;
    }
    return true;
  }

  function tryCommitDeferredClick(deferred) {
    if (deferred.cancelled || !deferred.released) return;
    if (!deferred.screenshotReady && !deferred.preflightFailed) return;
    commitDeferredClick(deferred);
  }

  function commitDeferredClick(deferred) {
    if (deferredClick === deferred) deferredClick = null;
    if (deferred.timer) clearTimeout(deferred.timer);
    const hit =
      document.elementFromPoint(deferred.clientX, deferred.clientY) ||
      deferred.element;
    try {
      hit.click();
    } catch {
      // Some pages reject programmatic activation; the page stays unchanged.
    }
    if (deferred.element instanceof HTMLElement) {
      try {
        deferred.element.focus({ preventScroll: true });
      } catch {
        // Focus restoration is best-effort for inputs clicked during capture.
      }
    }
    sendCapturedInteraction(deferred.context, {
      preflight: deferred.screenshotReady === true,
    });
  }

  function beginDeferredClick(event, element, context) {
    const deferred = {
      pointerId: event.pointerId,
      element,
      clientX: event.clientX,
      clientY: event.clientY,
      context,
      screenshotReady: false,
      preflightFailed: false,
      released: false,
      cancelled: false,
      timer: null,
    };
    deferredClick = deferred;
    deferred.timer = setTimeout(() => {
      if (deferredClick !== deferred) return;
      deferred.preflightFailed = true;
      tryCommitDeferredClick(deferred);
    }, DEFERRED_REPLY_TIMEOUT_MS);
    void send({
      type: "PREFLIGHT_CAPTURE",
      sessionId: state.sessionId,
      context: {
        ...context,
        masks: collectMasks(),
      },
      viewport: context.viewport,
    }).then((response) => {
      if (deferredClick !== deferred || deferred.cancelled) return;
      if (deferred.timer) clearTimeout(deferred.timer);
      deferred.screenshotReady = response?.ok === true;
      deferred.preflightFailed = response?.ok !== true;
      tryCommitDeferredClick(deferred);
    });
  }

  function onPointerDown(event) {
    pendingPointer = null;
    if (state.status !== "recording" || !event.isTrusted) return;
    if (event.isPrimary === false || event.button !== 0) return;
    const element = captureElement(event.target);
    const viewport = viewportSnapshot();
    const context = targetContext(
      element,
      { x: event.clientX, y: event.clientY },
      viewport,
    );
    if (!context.targetRect) return;
    if (deferrableTarget(element)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      beginDeferredClick(event, element, context);
      return;
    }
    pendingPointer = {
      pointerId: event.pointerId,
      element,
      clientX: event.clientX,
      clientY: event.clientY,
      startedAt: performance.now(),
      context,
    };
  }

  function onPointerMove(event) {
    const active = pendingPointer || deferredClick;
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
    if (deferredClick === active) {
      deferredClick = null;
      if (active.timer) clearTimeout(active.timer);
      void send({ type: "PREFLIGHT_DISCARD", sessionId: state.sessionId });
    }
  }

  function onPointerCancel(event) {
    if (pendingPointer && event.pointerId === pendingPointer.pointerId) {
      pendingPointer = null;
    }
    if (deferredClick && event.pointerId === deferredClick.pointerId) {
      if (deferredClick.timer) clearTimeout(deferredClick.timer);
      deferredClick = null;
      void send({ type: "PREFLIGHT_DISCARD", sessionId: state.sessionId });
    }
  }

  function onPointerUp(event) {
    if (event.isPrimary === false || event.button !== 0) return;
    const deferred = deferredClick;
    if (!deferred || event.pointerId !== deferred.pointerId) return;
    deferred.released = true;
    tryCommitDeferredClick(deferred);
  }

  function onClick(event) {
    if (state.status !== "recording" || !event.isTrusted) {
      pendingPointer = null;
      return;
    }
    if (event.detail === 0) {
      pendingPointer = null;
      const element = captureElement(event.target);
      const viewport = viewportSnapshot();
      const targetRect = rectFor(element, "click-target");
      if (!targetRect) return;
      sendCapturedInteraction(
        targetContext(
          element,
          {
            x: targetRect.x + targetRect.width / 2,
            y: targetRect.y + targetRect.height / 2,
          },
          viewport,
        ),
      );
      return;
    }

    const staged = pendingPointer;
    pendingPointer = null;
    if (!staged) return;
    if (performance.now() - staged.startedAt > POINTER_COMMIT_WINDOW_MS) return;
    if (!event.composedPath().includes(staged.element)) return;
    sendCapturedInteraction(staged.context);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RIVET_CONFIGURE") {
      state.sessionId = message.sessionId;
      state.policy = message.policy || {};
      setStatus(message.status || "recording");
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "RIVET_SET_STATUS") {
      setStatus(message.status, message.reason);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "RIVET_PREPARE_SCREENSHOT") {
      void waitForPagePaint().then(() =>
        sendResponse({ ok: true, context: pageContext() }),
      );
      return true;
    }
    if (message?.type === "RIVET_RESTORE_INDICATOR") {
      // Kept as a no-op for compatibility with capture jobs started by an
      // older service worker. Rivet no longer injects page UI to restore.
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "RIVET_GET_PAGE_CONTEXT") {
      sendResponse({ ok: true, context: pageContext() });
      return false;
    }
    if (message?.type === "RIVET_VERIFY_DOCUMENT") {
      sendResponse({ ok: true, sanitizedUrl: sanitizedPageUrl() });
      return false;
    }
    return false;
  });

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("click", onClick, true);

  globalThis[INSTANCE_KEY] = {
    announce() {
      void send({ type: "CONTENT_READY", sessionId: state.sessionId });
    },
  };
  void send({ type: "CONTENT_READY", sessionId: state.sessionId });
})();
