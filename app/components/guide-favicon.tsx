"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  acquireAuthorizedFaviconUrl,
  releaseAuthorizedFaviconUrl,
} from "../../lib/knowhow-client";

export function GuideFavicon({
  workspaceId,
  guideId,
  revisionId,
  mediaId,
  fallback,
}: {
  workspaceId: string;
  guideId: string;
  revisionId?: string;
  mediaId?: string;
  fallback: ReactNode;
}) {
  const request = useMemo(
    () =>
      mediaId && revisionId
        ? { workspaceId, guideId, revisionId, mediaId }
        : null,
    [guideId, mediaId, revisionId, workspaceId],
  );
  const [state, setState] = useState({ key: "", url: "", failed: false });
  const requestKey = request
    ? `${request.workspaceId}:${request.mediaId}:${request.revisionId}`
    : "";

  useEffect(() => {
    if (!request) return;
    let active = true;
    void acquireAuthorizedFaviconUrl(request)
      .then((url) => {
        if (active) setState({ key: requestKey, url, failed: false });
      })
      .catch(() => {
        if (active) setState({ key: requestKey, url: "", failed: true });
      });
    return () => {
      active = false;
      releaseAuthorizedFaviconUrl(request);
    };
  }, [request, requestKey]);

  const ready = state.key === requestKey && state.url && !state.failed;
  if (!ready) return fallback;
  return (
    // Favicons are decorative here; the adjacent guide title is the label.
    <img
      className="guide-favicon"
      src={state.url}
      alt=""
      aria-hidden="true"
      onError={() => setState({ key: requestKey, url: "", failed: true })}
    />
  );
}
