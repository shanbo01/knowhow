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
    scopeLabel: "Current tab",
    policy: {},
    indicatorHidden: false,
  };
  let host;
  let statusText;
  let scopeText;
  let pauseButton;

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
        parent.closest("script,style,noscript,svg") ||
        (host && (parent === host || host.contains(parent)))
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

  function targetContext(target) {
    const element =
      target instanceof Element
        ? target.closest(
            "button,a,input,select,textarea,[role=button],[role=link],[tabindex]",
          ) || target
        : document.body;
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
    return {
      masks: collectMasks(),
      targetRect,
      viewport: {
        width: Math.max(1, document.documentElement.clientWidth || innerWidth),
        height: Math.max(1, document.documentElement.clientHeight || innerHeight),
      },
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
      viewport: {
        width: Math.max(1, document.documentElement.clientWidth || innerWidth),
        height: Math.max(1, document.documentElement.clientHeight || innerHeight),
      },
      title: safeTitle,
      instructions: "Continue on " + safeTitle + ".",
      sanitizedUrl: sanitizedPageUrl(),
      pageUrl: sanitizedPageUrl(),
    };
  }

  function renderIndicator() {
    if (!host) {
      host = document.createElement("div");
      host.id = "rivet-capture-indicator";
      host.style.all = "initial";
      host.style.position = "fixed";
      host.style.right = "16px";
      host.style.bottom = "16px";
      host.style.zIndex = "2147483647";
      host.style.fontFamily =
        "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif";
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML =
        "<style>" +
        ":host{all:initial}.bar{display:flex;align-items:center;gap:9px;padding:9px 10px;background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.35);font:12px/1.25 Inter,system-ui,sans-serif}" +
        ".dot{width:9px;height:9px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.2)}.copy{display:grid;gap:2px;max-width:190px}.copy strong{font-size:12px}.copy span{color:#cbd5e1;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
        "button{appearance:none;border:1px solid #475569;background:#1e293b;color:#f8fafc;border-radius:7px;padding:6px 8px;font:600 10px Inter,system-ui,sans-serif;cursor:pointer}button:hover{background:#334155}.danger{color:#fecaca}.paused .dot{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.2)}" +
        "</style>" +
        "<div class=bar><span class=dot></span><span class=copy><strong data-status>Recording</strong><span data-scope>Current tab</span></span><button data-pause>Pause</button><button data-finish>Finish</button><button class=danger data-discard>Discard</button></div>";
      statusText = shadow.querySelector("[data-status]");
      scopeText = shadow.querySelector("[data-scope]");
      pauseButton = shadow.querySelector("[data-pause]");
      pauseButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        const type =
          state.status === "paused" ? "RESUME_CAPTURE" : "PAUSE_CAPTURE";
        const response = await send({ type });
        if (response?.ok) setStatus(response.state.status, response.state.pausedReason);
      });
      shadow.querySelector("[data-finish]").addEventListener("click", (event) => {
        event.stopPropagation();
        void send({ type: "FINISH_CAPTURE" });
      });
      shadow.querySelector("[data-discard]").addEventListener("click", (event) => {
        event.stopPropagation();
        if (confirm("Discard this capture and all locally stored screenshots?")) {
          void send({ type: "DISCARD_CAPTURE" });
        }
      });
      (document.documentElement || document.body).append(host);
    }
    host.style.display =
      state.status === "recording" || state.status === "paused"
        ? "block"
        : "none";
    if (scopeText) scopeText.textContent = state.scopeLabel;
    if (statusText) {
      statusText.textContent =
        state.status === "paused" ? "Capture paused" : "Rivet recording";
    }
    if (pauseButton) {
      pauseButton.textContent = state.status === "paused" ? "Resume" : "Pause";
      pauseButton.closest(".bar")?.classList.toggle(
        "paused",
        state.status === "paused",
      );
    }
  }

  function setStatus(status, reason) {
    state.status = status;
    renderIndicator();
    if (reason && statusText) statusText.title = reason;
  }

  async function hideIndicatorForScreenshot() {
    if (host) host.style.display = "none";
    state.indicatorHidden = true;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }

  function restoreIndicator() {
    state.indicatorHidden = false;
    renderIndicator();
  }

  function onClick(event) {
    if (state.status !== "recording" || !event.isTrusted) return;
    if (host && event.composedPath().includes(host)) return;
    const context = targetContext(event.target);
    if (!context.targetRect) return;
    void send({
      type: "CAPTURE_EVENT",
      sessionId: state.sessionId,
      context,
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RIVET_CONFIGURE") {
      state.sessionId = message.sessionId;
      state.scopeLabel = message.scopeLabel || "Current tab";
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
      void hideIndicatorForScreenshot().then(() =>
        sendResponse({ ok: true, context: pageContext() }),
      );
      return true;
    }
    if (message?.type === "RIVET_RESTORE_INDICATOR") {
      restoreIndicator();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "RIVET_GET_PAGE_CONTEXT") {
      sendResponse({ ok: true, context: pageContext() });
      return false;
    }
    return false;
  });

  document.addEventListener("click", onClick, true);

  globalThis[INSTANCE_KEY] = {
    announce() {
      void send({ type: "CONTENT_READY", sessionId: state.sessionId });
    },
  };
  void send({ type: "CONTENT_READY", sessionId: state.sessionId });
})();
