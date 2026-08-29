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

/**
 * A capture an author asked to retake. That covers a screenshot that failed and
 * a step KnowHow kept without one, because an action always becomes a step even
 * when its picture could not be taken.
 */
export function captureEntryIsRetakeable(entry) {
  // A note never had a picture by design — offering to retake one would be
  // offering to break it.
  if (!entry || entry.textOnly === true) return false;
  return Boolean(
    entry.status === CaptureEntryStatus.NEEDS_ATTENTION ||
      entry.screenshotMissing === true ||
      entry.showsResultOfAction === true,
  );
}

export function resetCaptureEntryForRetry(
  state,
  entryId,
  patch = {},
  now = Date.now(),
) {
  const entry = captureEntry(state, entryId);
  if (!captureEntryIsRetakeable(entry)) return state;
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

// Steps an author performs on the page, as opposed to a navigation KnowHow
// records for them. A typed value belongs here: pressing Enter in a field is
// just as likely to navigate as clicking a link is.
const CLICK_SOURCE_EVENTS = new Set([
  "click",
  "contextmenu",
  "dblclick",
  "type",
]);

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

// A click that navigates can destroy its own document before the commit
// message leaves it. The pointer-down half of that click is already in the
// ledger, uncommitted, and would otherwise be swept away as abandoned — the
// author would see the navigation recorded but not the click that caused it.
export function unconfirmedClickEntryAt(
  state,
  { tabId, now = Date.now(), maxAgeMs = 4_000 } = {},
) {
  const candidates = entriesOf(state).filter(
    (entry) =>
      entry.committed !== true &&
      entry.status === CaptureEntryStatus.CAPTURING &&
      CLICK_SOURCE_EVENTS.has(entry.sourceEvent || entry.kind) &&
      Number(entry.tabId) === Number(tabId) &&
      now - Number(entry.acceptedAtMs || 0) <= maxAgeMs,
  );
  return candidates.at(-1) || null;
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
