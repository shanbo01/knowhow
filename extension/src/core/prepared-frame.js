function sameValue(left, right) {
  return String(left ?? "") === String(right ?? "");
}

export function preparedFrameEligible(
  frame,
  candidate,
  {
    now = Date.now(),
    maxAgeMs = 2_000,
    ignoreVisualEpoch = false,
    ignoreNavigationKey = false,
    ignoreViewportKey = false,
    ignoreDocumentId = false,
  } = {},
) {
  if (!frame || !candidate) return false;
  const age = now - Number(frame.capturedAtMs || 0);
  return Boolean(
    age >= 0 &&
      age <= maxAgeMs &&
      sameValue(frame.sessionId, candidate.sessionId) &&
      Number(frame.tabId) === Number(candidate.tabId) &&
      (ignoreDocumentId || sameValue(frame.documentId, candidate.documentId)) &&
      (ignoreNavigationKey ||
        sameValue(frame.navigationKey, candidate.navigationKey)) &&
      (ignoreVisualEpoch ||
        Number(frame.visualEpoch) === Number(candidate.visualEpoch)) &&
      (ignoreViewportKey || sameValue(frame.viewportKey, candidate.viewportKey)),
  );
}

export function newestEligiblePreparedFrame(frames, candidate, options) {
  return [...(Array.isArray(frames) ? frames : [])]
    .filter((frame) => preparedFrameEligible(frame, candidate, options))
    .sort(
      (left, right) =>
        Number(right.capturedAtMs || 0) - Number(left.capturedAtMs || 0),
    )[0] || null;
}

export function newestSameTabPreparedFrame(frames, candidate, options = {}) {
  return newestEligiblePreparedFrame(frames, candidate, {
    maxAgeMs: 12_000,
    ...options,
    ignoreVisualEpoch: true,
    ignoreNavigationKey: true,
    ignoreViewportKey: true,
    ignoreDocumentId: true,
  });
}

export function retainPreparedFrameMetadata(
  frames,
  {
    now = Date.now(),
    retentionMs = 12_000,
    maximumUnclaimed = 2,
    pinnedIds = [],
  } = {},
) {
  const pinned = new Set(pinnedIds.filter(Boolean));
  const current = (Array.isArray(frames) ? frames : []).filter(
    (frame) =>
      pinned.has(frame.id) ||
      now - Number(frame.capturedAtMs || 0) <= retentionMs,
  );
  const unclaimed = current
    .filter((frame) => !pinned.has(frame.id))
    .sort(
      (left, right) =>
        Number(right.capturedAtMs || 0) - Number(left.capturedAtMs || 0),
    )
    .slice(0, Math.max(0, maximumUnclaimed));
  const retained = [
    ...current.filter((frame) => pinned.has(frame.id)),
    ...unclaimed,
  ];
  return [...new Map(retained.map((frame) => [frame.id, frame])).values()].sort(
    (left, right) => Number(left.capturedAtMs || 0) - Number(right.capturedAtMs || 0),
  );
}
