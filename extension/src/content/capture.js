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
  };
  let pendingPointer = null;
  let pendingSingleClick = null;
  let interactionSequence = 0;

  const POINTER_MOVE_TOLERANCE = 6;
  const POINTER_COMMIT_WINDOW_MS = 3_000;
  const DOUBLE_CLICK_WINDOW_MS = 260;

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
    const smartBlurEnabled = state.policy.smartBlurEnabled === true;
    const selectors = [
      "input[type=password]",
      "[autocomplete*=password]",
      "[autocomplete=one-time-code]",
      "[autocomplete=cc-number]",
      "[data-knowhow-redact]",
    ];
    if (smartBlurEnabled && state.policy.redactFormFields) {
      selectors.push(
        "input:not([type=button]):not([type=submit]):not([type=reset])",
        "textarea",
        "select",
        "[contenteditable=true]",
      );
    }
    if (smartBlurEnabled && state.policy.redactEmails !== false) {
      selectors.push("input[type=email]", "[autocomplete=email]");
    }
    if (smartBlurEnabled && state.policy.redactPhoneNumbers !== false) {
      selectors.push("input[type=tel]", "[autocomplete=tel]");
    }
    const selector = selectors.join(",");
    return Array.from(document.querySelectorAll(selector))
      .filter(
        (element) =>
          visible(element) &&
          !element.closest("[data-knowhow-ui],[data-knowhow-overlay]"),
      )
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
    if (state.policy.smartBlurEnabled !== true) return [];
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
        parent.closest("script,style,noscript,svg,[data-knowhow-ui],[data-knowhow-overlay]")
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
    if (state.policy.smartBlurEnabled !== true) return masks;
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

  let blurPreviewRoot = null;
  let blurPreviewTimer = null;
  let blurPreviewFrame = null;
  let blurPreviewInterval = null;
  let blurPreviewObserver = null;
  let blurPreviewRestoreTimer = null;
  let blurPreviewSuspended = false;
  let smartBlurUiRoot = null;
  let smartBlurPanelOpen = false;

  const SMART_BLUR_OPTIONS = [
    ["redactEmails", "Email addresses"],
    ["redactPhoneNumbers", "Phone numbers"],
    ["redactFinancialNumbers", "Financial numbers"],
    ["redactIds", "Long IDs"],
    ["redactFormFields", "Form fields"],
    ["redactAllNumbers", "All numbers"],
    ["redactCommonNames", "Common names"],
    ["redactLongText", "Long text"],
    ["redactTableRows", "Table rows"],
    ["redactImages", "Images and video"],
  ];

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

  function removeBlurPreview() {
    clearBlurPreviewSchedule();
    blurPreviewRoot?.remove();
    blurPreviewRoot = null;
  }

  function ensureBlurPreviewRoot() {
    if (blurPreviewRoot?.isConnected) return blurPreviewRoot;
    const root = document.createElement("div");
    root.dataset.knowhowOverlay = "smart-blur-preview";
    root.setAttribute("aria-hidden", "true");
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483645;pointer-events:none;contain:strict;";
    (document.body || document.documentElement).append(root);
    blurPreviewRoot = root;
    return root;
  }

  function renderBlurPreview() {
    clearBlurPreviewSchedule();
    if (
      !captureSessionVisible() ||
      blurPreviewSuspended ||
      state.policy.smartBlurEnabled !== true
    ) {
      blurPreviewRoot?.replaceChildren();
      return;
    }
    const masks = collectMasks();
    const root = ensureBlurPreviewRoot();
    const fragment = document.createDocumentFragment();
    for (const mask of masks.slice(0, 300)) {
      const region = document.createElement("span");
      region.style.cssText =
        "position:absolute;display:block;box-sizing:border-box;" +
        "border:1px solid rgba(255,255,255,.66);border-radius:6px;" +
        "background:rgba(24,24,27,.10);backdrop-filter:blur(13px) saturate(.65);" +
        "-webkit-backdrop-filter:blur(13px) saturate(.65);" +
        "box-shadow:0 0 0 1px rgba(24,24,27,.26),0 3px 12px rgba(0,0,0,.15);" +
        `left:${mask.x}px;top:${mask.y}px;width:${mask.width}px;height:${mask.height}px;`;
      fragment.append(region);
    }
    root.replaceChildren(fragment);
  }

  function scheduleBlurPreview(delay = 0) {
    if (blurPreviewSuspended) return;
    clearBlurPreviewSchedule();
    const queueFrame = () => {
      blurPreviewTimer = null;
      blurPreviewFrame = requestAnimationFrame(() => {
        blurPreviewFrame = null;
        renderBlurPreview();
      });
    };
    if (delay > 0) blurPreviewTimer = setTimeout(queueFrame, delay);
    else queueFrame();
  }

  function setPagePolicy(key, checked) {
    state.policy = { ...state.policy, [key]: checked };
    syncSmartBlurUi();
    scheduleBlurPreview();
    void send({ type: "UPDATE_CAPTURE_POLICY", policy: { [key]: checked } });
  }

  function smartBlurSwitch(key, label) {
    const row = document.createElement("label");
    row.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:16px;" +
      "min-height:34px;color:#f4f4f5;font-size:14px;font-weight:600;cursor:pointer;";
    const text = document.createElement("span");
    text.textContent = label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.knowhowPolicy = key;
    input.style.cssText = "position:absolute;opacity:0;pointer-events:none;";
    const track = document.createElement("span");
    track.dataset.knowhowSwitch = "";
    track.style.cssText =
      "position:relative;display:block;width:40px;height:22px;flex:0 0 auto;" +
      "border-radius:999px;background:#52525b;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);";
    const thumb = document.createElement("i");
    thumb.style.cssText =
      "position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;" +
      "background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.38);transition:transform .14s ease;";
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
      "position:fixed;right:18px;bottom:18px;z-index:2147483647;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;";
    const panel = document.createElement("section");
    panel.dataset.knowhowBlurPanel = "";
    panel.style.cssText =
      "display:none;width:min(320px,calc(100vw - 36px));max-height:min(540px,calc(100vh - 92px));" +
      "margin-bottom:10px;overflow:auto;border:1px solid rgba(255,255,255,.10);" +
      "border-radius:16px;background:#171717;box-shadow:0 18px 50px rgba(0,0,0,.36);";
    const heading = document.createElement("div");
    heading.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:16px;" +
      "padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);";
    const title = document.createElement("strong");
    title.textContent = "Smart Blur";
    title.style.cssText = "font-size:17px;letter-spacing:-.02em;";
    heading.append(title, smartBlurSwitch("smartBlurEnabled", ""));
    const options = document.createElement("div");
    options.dataset.knowhowBlurOptions = "";
    options.style.cssText = "display:grid;padding:10px 16px 14px;";
    for (const [key, label] of SMART_BLUR_OPTIONS) {
      options.append(smartBlurSwitch(key, label));
    }
    const note = document.createElement("p");
    note.textContent = "Protected regions update live and are hidden from the final screenshot overlay.";
    note.style.cssText =
      "margin:0;padding:0 16px 15px;color:#a1a1aa;font-size:11px;line-height:1.45;";
    panel.append(heading, options, note);
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.dataset.knowhowBlurTrigger = "";
    trigger.style.cssText =
      "display:flex;align-items:center;gap:9px;margin-left:auto;padding:10px 14px;" +
      "border:1px solid rgba(255,255,255,.12);border-radius:999px;background:#171717;" +
      "color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.28);font:700 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer;";
    const triggerIcon = document.createElement("span");
    triggerIcon.textContent = "✦";
    triggerIcon.style.cssText = "color:#fb923c;font-size:15px;";
    const triggerLabel = document.createElement("span");
    triggerLabel.dataset.knowhowBlurLabel = "";
    trigger.append(triggerIcon, triggerLabel);
    trigger.addEventListener("click", () => {
      smartBlurPanelOpen = !smartBlurPanelOpen;
      syncSmartBlurUi();
    });
    root.append(panel, trigger);
    (document.body || document.documentElement).append(root);
    smartBlurUiRoot = root;
    return root;
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
    const label = root.querySelector("[data-knowhow-blur-label]");
    label.textContent = enabled ? "Smart Blur on" : "Smart Blur off";
    for (const input of root.querySelectorAll("[data-knowhow-policy]")) {
      input.checked = state.policy[input.dataset.knowhowPolicy] === true;
      const track = input.nextElementSibling;
      if (track) {
        track.style.background = input.checked ? "#10b981" : "#52525b";
        const thumb = track.firstElementChild;
        if (thumb) thumb.style.transform = input.checked ? "translateX(18px)" : "none";
      }
    }
    const options = root.querySelector("[data-knowhow-blur-options]");
    if (options) options.style.opacity = enabled ? "1" : ".58";
  }

  function hideCaptureOverlays() {
    if (smartBlurUiRoot) smartBlurUiRoot.style.visibility = "hidden";
  }

  function restoreCaptureOverlays() {
    if (smartBlurUiRoot) smartBlurUiRoot.style.visibility = "visible";
  }

  function startBlurPreviewTracking() {
    blurPreviewSuspended = false;
    if (!blurPreviewInterval) {
      blurPreviewInterval = setInterval(() => scheduleBlurPreview(), 1_500);
    }
    if (!blurPreviewObserver && (document.body || document.documentElement)) {
      blurPreviewObserver = new MutationObserver((mutations) => {
        const pageChanged = mutations.some((mutation) => {
          const target = mutation.target instanceof Element
            ? mutation.target
            : mutation.target.parentElement;
          return !target?.closest("[data-knowhow-ui],[data-knowhow-overlay]");
        });
        if (pageChanged) scheduleBlurPreview();
      });
      blurPreviewObserver.observe(document.body || document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-hidden", "value"],
      });
    }
    syncSmartBlurUi();
    scheduleBlurPreview();
  }

  function stopBlurPreviewTracking() {
    if (blurPreviewInterval) {
      clearInterval(blurPreviewInterval);
      blurPreviewInterval = null;
    }
    blurPreviewObserver?.disconnect();
    blurPreviewObserver = null;
    blurPreviewSuspended = false;
    if (blurPreviewRestoreTimer) {
      clearTimeout(blurPreviewRestoreTimer);
      blurPreviewRestoreTimer = null;
    }
    removeBlurPreview();
    syncSmartBlurUi();
  }

  function hideBlurPreviewForCapture() {
    blurPreviewSuspended = true;
    removeBlurPreview();
    hideCaptureOverlays();
    if (blurPreviewRestoreTimer) clearTimeout(blurPreviewRestoreTimer);
    // The background normally restores immediately after capture. This
    // fallback prevents a failed or cancelled screenshot from leaving the
    // author without their live privacy preview.
    blurPreviewRestoreTimer = setTimeout(() => {
      blurPreviewRestoreTimer = null;
      restoreBlurPreviewAfterCapture();
    }, 5_000);
  }

  function restoreBlurPreviewAfterCapture() {
    if (blurPreviewRestoreTimer) {
      clearTimeout(blurPreviewRestoreTimer);
      blurPreviewRestoreTimer = null;
    }
    blurPreviewSuspended = false;
    restoreCaptureOverlays();
    scheduleBlurPreview();
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
      title: "Click " + name,
      instructions: "Click " + name + ".",
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

  let recordingFlashEl = null;
  let recordingFlashHideTimer = null;
  let recordingActivationCount = 0;

  // A brief full-viewport dim + "Recording started/resumed" flash gives clear
  // feedback that capture is live, without leaving any persistent page UI
  // that could show up in later screenshots. It is force-removed immediately
  // before every screenshot opportunity below, so it can never be captured.
  function removeRecordingFlash() {
    if (recordingFlashHideTimer) {
      clearTimeout(recordingFlashHideTimer);
      recordingFlashHideTimer = null;
    }
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
    const flash = document.createElement("div");
    flash.setAttribute("aria-hidden", "true");
    flash.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:flex;" +
      "align-items:center;justify-content:center;" +
      "background:rgba(8,10,20,.55);opacity:1;" +
      "transition:opacity .45s ease;pointer-events:none;";
    const badge = document.createElement("div");
    badge.style.cssText =
      "display:flex;align-items:center;gap:10px;padding:14px 22px;" +
      "border-radius:999px;background:rgba(17,20,30,.94);color:#fff;" +
      "font:600 15px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "box-shadow:0 12px 32px rgba(0,0,0,.35);letter-spacing:.01em;";
    const dot = document.createElement("span");
    dot.style.cssText =
      "width:10px;height:10px;border-radius:50%;background:#ef4444;" +
      "animation:knowhow-recording-pulse 1.4s ease-out infinite;";
    const style = document.createElement("style");
    style.textContent =
      "@keyframes knowhow-recording-pulse{" +
      "0%{box-shadow:0 0 0 0 rgba(239,68,68,.55)}" +
      "70%{box-shadow:0 0 0 10px rgba(239,68,68,0)}" +
      "100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}";
    const text = document.createElement("span");
    text.textContent = label;
    badge.append(dot, text);
    flash.append(style, badge);
    root.appendChild(flash);
    recordingFlashEl = flash;
    recordingFlashHideTimer = setTimeout(() => {
      if (recordingFlashEl !== flash) return;
      flash.style.opacity = "0";
      recordingFlashHideTimer = setTimeout(() => {
        if (recordingFlashEl === flash) removeRecordingFlash();
      }, 450);
    }, 1100);
  }

  function setStatus(status) {
    const enteringRecording =
      status === "recording" && state.status !== "recording";
    state.status = status;
    if (status !== "recording") {
      removeRecordingFlash();
      clearPendingSingleClick();
      pendingPointer = null;
    }
    if (enteringRecording) {
      recordingActivationCount += 1;
      showRecordingFlash(
        recordingActivationCount === 1 ? "Recording started" : "Recording resumed",
      );
    }
    if (status === "recording" || status === "paused") {
      startBlurPreviewTracking();
    } else {
      stopBlurPreviewTracking();
    }
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
      sourceEvent: options.sourceEvent || "click",
      context,
    });
  }

  // Native click behavior is never cancelled or replayed. The old preflight
  // path synthesized a second click, which made dropdowns open and close in a
  // single frame on frameworks that already handled the real click. We wait
  // for the page to paint, then record the resulting UI state.
  function emitAfterPaint(context, options = {}) {
    void waitForPagePaint().then(() => {
      if (state.status === "recording") {
        sendCapturedInteraction(context, options);
      }
    });
  }

  function clearPendingSingleClick() {
    if (pendingSingleClick?.timer) clearTimeout(pendingSingleClick.timer);
    pendingSingleClick = null;
  }

  function flushPendingSingleClick({ afterPaint = false } = {}) {
    const pending = pendingSingleClick;
    if (!pending) return;
    clearPendingSingleClick();
    if (afterPaint) emitAfterPaint(pending.context);
    else sendCapturedInteraction(pending.context);
  }

  function scheduleSingleClick(element, context) {
    clearPendingSingleClick();
    const pending = { element, context, timer: null };
    pending.timer = setTimeout(() => {
      if (pendingSingleClick !== pending) return;
      pendingSingleClick = null;
      emitAfterPaint(context);
    }, DOUBLE_CLICK_WINDOW_MS);
    pendingSingleClick = pending;
  }

  function isKnowHowUiEvent(event) {
    return event.composedPath().some(
      (item) => item instanceof Element && item.closest("[data-knowhow-ui]"),
    );
  }

  function onPointerDown(event) {
    pendingPointer = null;
    if (isKnowHowUiEvent(event)) return;
    if (state.status !== "recording" || !event.isTrusted) return;
    if (event.isPrimary === false || event.button !== 0) return;
    const element = captureElement(event.target);
    if (pendingSingleClick && pendingSingleClick.element !== element) {
      // Queue the previous action before this new element changes the page.
      flushPendingSingleClick();
    }
    const viewport = viewportSnapshot();
    const context = targetContext(
      element,
      { x: event.clientX, y: event.clientY },
      viewport,
    );
    if (!context.targetRect) return;
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
  }

  function onPointerCancel(event) {
    if (pendingPointer && event.pointerId === pendingPointer.pointerId) {
      pendingPointer = null;
    }
  }

  // A right-click that opens the native context menu is captured as its own
  // step, matching how Scribe documents "right-click X" actions.
  function onContextMenu(event) {
    if (isKnowHowUiEvent(event)) return;
    if (state.status !== "recording" || !event.isTrusted) return;
    const element = captureElement(event.target);
    const viewport = viewportSnapshot();
    const targetRect = rectFor(element, "click-target");
    if (!targetRect) return;
    const point = { x: event.clientX, y: event.clientY };
    const context = targetContext(element, point, viewport);
    const name = context.title.replace(/^Click /, "");
    sendCapturedInteraction(
      {
        ...context,
        title: "Right-click " + name,
        instructions: "Right-click " + name + ".",
      },
      { sourceEvent: "contextmenu" },
    );
  }

  function onClick(event) {
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
      const element = captureElement(event.target);
      const viewport = viewportSnapshot();
      const targetRect = rectFor(element, "click-target");
      if (!targetRect) return;
      emitAfterPaint(
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
    if (event.detail > 1) {
      if (pendingSingleClick?.element === staged.element) {
        clearPendingSingleClick();
      }
      return;
    }
    scheduleSingleClick(staged.element, staged.context);
  }

  function onDoubleClick(event) {
    if (isKnowHowUiEvent(event)) return;
    if (state.status !== "recording" || !event.isTrusted) return;
    const element = captureElement(event.target);
    if (pendingSingleClick?.element === element) clearPendingSingleClick();
    const viewport = viewportSnapshot();
    const context = targetContext(
      element,
      { x: event.clientX, y: event.clientY },
      viewport,
    );
    if (!context.targetRect) return;
    const name = context.title.replace(/^Click /, "");
    emitAfterPaint(
      {
        ...context,
        title: "Double-click " + name,
        instructions: "Double-click " + name + ".",
      },
      { sourceEvent: "dblclick" },
    );
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "KNOWHOW_CONFIGURE") {
      state.sessionId = message.sessionId;
      state.policy = message.policy || {};
      setStatus(message.status || "recording");
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KNOWHOW_UPDATE_POLICY") {
      state.policy = message.policy || {};
      syncSmartBlurUi();
      scheduleBlurPreview();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KNOWHOW_SET_STATUS") {
      setStatus(message.status, message.reason);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KNOWHOW_TOGGLE_SMART_BLUR_PANEL") {
      smartBlurPanelOpen = !smartBlurPanelOpen;
      syncSmartBlurUi();
      sendResponse({ ok: true, open: smartBlurPanelOpen });
      return false;
    }
    if (message?.type === "KNOWHOW_PREPARE_SCREENSHOT") {
      removeRecordingFlash();
      const context = pageContext();
      hideBlurPreviewForCapture();
      void waitForPagePaint().then(() => {
        sendResponse({ ok: true, context });
      });
      return true;
    }
    if (message?.type === "KNOWHOW_RESTORE_INDICATOR") {
      // Kept as a no-op for compatibility with capture jobs started by an
      // older service worker. KnowHow no longer injects page UI to restore.
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KNOWHOW_RESTORE_PRIVACY_PREVIEW") {
      restoreBlurPreviewAfterCapture();
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
      sendResponse({ ok: true, sanitizedUrl: sanitizedPageUrl() });
      return false;
    }
    return false;
  });

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("dblclick", onDoubleClick, true);
  document.addEventListener("contextmenu", onContextMenu, true);
  addEventListener("scroll", () => scheduleBlurPreview(), true);
  addEventListener("resize", () => scheduleBlurPreview());
  document.addEventListener("input", () => scheduleBlurPreview(), true);
  document.addEventListener("change", () => scheduleBlurPreview(), true);

  globalThis[INSTANCE_KEY] = {
    announce() {
      void send({ type: "CONTENT_READY", sessionId: state.sessionId });
    },
  };
  void send({ type: "CONTENT_READY", sessionId: state.sessionId });
})();
