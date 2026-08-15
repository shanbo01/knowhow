export const CaptureEntryStatus = Object.freeze({
  CAPTURING: "capturing",
  READY: "ready",
  NEEDS_ATTENTION: "needs_attention",
  CANCELLED: "cancelled",
});

function timestamp(now) {
  return new Date(now).toISOString();
}

function entriesOf(state) {
  return Array.isArray(state?.captureEntries) ? state.captureEntries : [];
}

function derive(state, captureEntries, now = Date.now()) {
  const ready = [...captureEntries]
    .filter(
      (entry) =>
        entry.status === CaptureEntryStatus.READY &&
        typeof entry.stepId === "string" &&
        entry.stepId,
    )
    .sort((left, right) => left.order - right.order);
  return {
    ...state,
    captureEntries: [...captureEntries].sort(
      (left, right) => left.order - right.order,
    ),
    stepIds: ready.map((entry) => entry.stepId),
    stepCount: ready.length,
    updatedAt: timestamp(now),
  };
}

export function initializeCaptureCoordinator(state, now = Date.now()) {
  return derive(
    {
      ...state,
      acceptingEvents: state?.acceptingEvents === true,
      nextEventSequence: Math.max(0, Number(state?.nextEventSequence) || 0),
      nextNavigationSequence: Math.max(
        0,
        Number(state?.nextNavigationSequence) || 0,
      ),
      navigationKeys: Array.isArray(state?.navigationKeys)
        ? state.navigationKeys.slice(-40)
        : [],
      preparedFrames: Array.isArray(state?.preparedFrames)
        ? state.preparedFrames.slice(-2)
        : [],
      tabDocumentSessions:
        state?.tabDocumentSessions && typeof state.tabDocumentSessions === "object"
          ? state.tabDocumentSessions
          : {},
      pendingNavigationTargets: Array.isArray(state?.pendingNavigationTargets)
        ? state.pendingNavigationTargets.slice(-20)
        : [],
      diagnostics: {
        accepted: 0,
        ready: 0,
        failed: 0,
        cancelled: 0,
        deduplicated: 0,
        prepared: 0,
        ...(state?.diagnostics || {}),
      },
    },
    entriesOf(state),
    now,
  );
}

export function reserveCaptureEntry(state, entry, now = Date.now()) {
  if (!entry?.id || !entry?.stepId) {
    throw new TypeError("A capture entry requires stable entry and step IDs.");
  }
  const existing = entriesOf(state).find((candidate) => candidate.id === entry.id);
  if (existing) return initializeCaptureCoordinator(state, now);
  const order = Math.max(0, Number(state?.nextEventSequence) || 0);
  const captureEntries = [
    ...entriesOf(state),
    {
      ...entry,
      order,
      status: CaptureEntryStatus.CAPTURING,
      acceptedAtMs: now,
      updatedAt: timestamp(now),
    },
  ];
  return derive(
    {
      ...state,
      nextEventSequence: order + 1,
      diagnostics: {
        ...(state.diagnostics || {}),
        accepted: Number(state.diagnostics?.accepted || 0) + 1,
      },
    },
    captureEntries,
    now,
  );
}

export function updateCaptureEntry(state, entryId, patch, now = Date.now()) {
  let changed = false;
  const captureEntries = entriesOf(state).map((entry) => {
    if (entry.id !== entryId) return entry;
    changed = true;
    return { ...entry, ...patch, id: entry.id, updatedAt: timestamp(now) };
  });
  return changed ? derive(state, captureEntries, now) : state;
}

export function markCaptureEntryReady(state, entryId, now = Date.now()) {
  const entry = entriesOf(state).find((candidate) => candidate.id === entryId);
  if (!entry || entry.status === CaptureEntryStatus.READY) return state;
  return updateCaptureEntry(
    {
      ...state,
      diagnostics: {
        ...(state.diagnostics || {}),
        ready: Number(state.diagnostics?.ready || 0) + 1,
      },
    },
    entryId,
    {
      status: CaptureEntryStatus.READY,
      committed: true,
      frameId: null,
      context: undefined,
      error: null,
    },
    now,
  );
}

export function markCaptureEntryFailed(
  state,
  entryId,
  error,
  now = Date.now(),
) {
  const entry = entriesOf(state).find((candidate) => candidate.id === entryId);
  if (!entry || entry.status === CaptureEntryStatus.READY) return state;
  return updateCaptureEntry(
    {
      ...state,
      diagnostics: {
        ...(state.diagnostics || {}),
        failed: Number(state.diagnostics?.failed || 0) + 1,
      },
    },
    entryId,
    {
      status: CaptureEntryStatus.NEEDS_ATTENTION,
      error: String(error || "Screenshot capture failed.").slice(0, 500),
      frameId: null,
    },
    now,
  );
}

export function removeCaptureEntry(state, entryId, now = Date.now()) {
  const current = entriesOf(state);
  const removed = current.find((entry) => entry.id === entryId);
  if (!removed) return state;
  return derive(
    {
      ...state,
      diagnostics: {
        ...(state.diagnostics || {}),
        cancelled: Number(state.diagnostics?.cancelled || 0) + 1,
      },
    },
    current.filter((entry) => entry.id !== entryId),
    now,
  );
}

export function captureEntry(state, entryId) {
  return entriesOf(state).find((entry) => entry.id === entryId) || null;
}

export function unresolvedCaptureEntries(state) {
  return entriesOf(state).filter(
    (entry) => entry.status !== CaptureEntryStatus.READY,
  );
}

export function resetCaptureEntryForRetry(
  state,
  entryId,
  patch = {},
  now = Date.now(),
) {
  const entry = captureEntry(state, entryId);
  if (!entry || entry.status !== CaptureEntryStatus.NEEDS_ATTENTION) {
    return state;
  }
  return updateCaptureEntry(
    state,
    entryId,
    {
      ...patch,
      status: CaptureEntryStatus.CAPTURING,
      error: null,
      frameId: null,
      capturePending: true,
      committed: true,
      acceptedAtMs: now,
    },
    now,
  );
}

export function recoverCaptureLedger(
  state,
  {
    availableFrameIds = [],
    now = Date.now(),
    abandonedStageAgeMs = 10_000,
  } = {},
) {
  const available = new Set(availableFrameIds.filter(Boolean));
  let recovered = initializeCaptureCoordinator(state, now);
  for (const entry of [...recovered.captureEntries]) {
    if (entry.status !== CaptureEntryStatus.CAPTURING) continue;
    if (!entry.committed) {
      if (now - Number(entry.acceptedAtMs || 0) > abandonedStageAgeMs) {
        recovered = removeCaptureEntry(recovered, entry.id, now);
      }
      continue;
    }
    if (entry.frameId && available.has(entry.frameId)) continue;
    recovered = markCaptureEntryFailed(
      recovered,
      entry.id,
      "The pre-action screenshot was interrupted before it could be preserved.",
      now,
    );
  }
  return recovered;
}

export function rememberNavigationKey(state, key, now = Date.now()) {
  if (!key) return { state, duplicate: false };
  const keys = Array.isArray(state?.navigationKeys) ? state.navigationKeys : [];
  if (keys.includes(key)) {
    return {
      state: {
        ...state,
        diagnostics: {
          ...(state.diagnostics || {}),
          deduplicated: Number(state.diagnostics?.deduplicated || 0) + 1,
        },
      },
      duplicate: true,
    };
  }
  return {
    state: {
      ...state,
      navigationKeys: [...keys, key].slice(-40),
      updatedAt: timestamp(now),
    },
    duplicate: false,
  };
}

export function navigationKey(details, kind = "document") {
  const tabId = Number.isInteger(details?.tabId) ? details.tabId : "tab";
  const documentId = details?.documentId || "document";
  const transitionId = Number.isInteger(details?.transitionId)
    ? details.transitionId
    : "transition";
  const url = String(details?.sanitizedUrl || details?.url || "");
  return `${kind}:${tabId}:${documentId}:${transitionId}:${url}`;
}

export function recentHandoffMatches(
  state,
  details,
  { now = Date.now(), maxAgeMs = 10_000 } = {},
) {
  const handoff = state?.lastNavigationHandoff;
  if (!handoff || !details?.documentId) return false;
  const age = now - Number(handoff.recordedAtMs || 0);
  return Boolean(
    age >= 0 &&
      age <= maxAgeMs &&
      Number(handoff.tabId) === Number(details.tabId) &&
      String(handoff.documentId || "") === String(details.documentId) &&
      String(handoff.sanitizedUrl || "") ===
        String(details.sanitizedUrl || ""),
  );
}

export const CLICK_NAVIGATION_ABSORB_MS = 1_500;
export const SAME_TAB_DESTINATION_DEDUPE_MS = 2_000;
const CLICK_SOURCE_EVENTS = new Set(["click", "contextmenu", "dblclick"]);

export function noteClickInteraction(state, { tabId, now = Date.now() } = {}) {
  return {
    ...state,
    lastInteractionAt: now,
    lastInteractionTabId: Number.isInteger(tabId) ? tabId : Number(tabId) || 0,
    updatedAt: timestamp(now),
  };
}

export function switchNavigationCopy(pageTitle) {
  const title = String(pageTitle || "").replace(/\s+/g, " ").trim();
  const googleQuery = title.match(/^(.*?)\s[-–—]\s+Google (Search|Images)$/i);
  if (googleQuery) {
    const query = googleQuery[1].trim();
    const surface =
      googleQuery[2].toLowerCase() === "images"
        ? "Google Images"
        : "Google Search";
    return {
      title: `Switch to ${surface}`,
      instructions: query ? `Results for "${query}".` : "Continue on this tab.",
    };
  }
  if (/^Google(?: Search| Images)?$/i.test(title)) {
    return {
      title: `Switch to ${title}`,
      instructions: "Continue on this tab.",
    };
  }
  return {
    title: title ? `Switch to ${title}` : "Switch to this tab",
    instructions: "Continue on this tab.",
  };
}

export function shouldMintNavigationStep(titleMode) {
  return titleMode === "new-tab" || titleMode === "switch";
}

export function lastClickCaptureEntry(state) {
  const entries = entriesOf(state).filter((entry) =>
    CLICK_SOURCE_EVENTS.has(entry.sourceEvent || entry.kind),
  );
  return entries.at(-1) || null;
}

export function shouldDropTrailingTabSwitch(
  state,
  details,
  { titleMode } = {},
) {
  if (titleMode !== "switch") return false;
  const last = entriesOf(state).at(-1);
  return Boolean(last && Number(last.tabId) === Number(details?.tabId));
}

export function clickEntryNeedsSettledFrame(state, details) {
  const last = lastClickCaptureEntry(state);
  if (!last || last.additionalFrameId) return false;
  if (
    Number.isInteger(details?.tabId) &&
    Number(last.tabId) !== Number(details.tabId)
  ) {
    return false;
  }
  return true;
}

export function shouldAbsorbClickNavigation(
  state,
  details,
  { now = Date.now(), maxAgeMs = CLICK_NAVIGATION_ABSORB_MS, titleMode = "navigation" } = {},
) {
  if (titleMode !== "navigation") return false;
  const at = Number(state?.lastInteractionAt || 0);
  if (!at) return false;
  const age = now - at;
  return Boolean(
    age >= 0 &&
      age <= maxAgeMs &&
      Number(state?.lastInteractionTabId) === Number(details?.tabId),
  );
}

export function recentSameTabDestination(
  state,
  sanitizedUrl,
  { now = Date.now(), maxAgeMs = SAME_TAB_DESTINATION_DEDUPE_MS } = {},
) {
  const recorded = String(state?.lastRecordedDestinationUrl || "");
  const at = Number(state?.lastRecordedDestinationAt || 0);
  if (!recorded || !sanitizedUrl || !at) return false;
  const age = now - at;
  return recorded === String(sanitizedUrl) && age >= 0 && age <= maxAgeMs;
}

export function rememberRecordedDestination(
  state,
  sanitizedUrl,
  now = Date.now(),
) {
  if (!sanitizedUrl) return state;
  return {
    ...state,
    lastRecordedDestinationUrl: String(sanitizedUrl),
    lastRecordedDestinationAt: now,
    updatedAt: timestamp(now),
  };
}
