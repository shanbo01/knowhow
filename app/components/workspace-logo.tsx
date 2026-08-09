"use client";

import { ImageOff, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { loadAuthorizedWorkspaceLogoUrl } from "../../lib/knowhow-client";

type WorkspaceLogoProps = {
  workspaceId: string;
  workspaceName: string;
  logoKey?: string | null;
  className?: string;
  size?: "sm" | "md" | "lg";
};

function initials(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "W";
}

/** Shows the private workspace logo when present and a stable initial fallback otherwise. */
export function WorkspaceLogo({
  workspaceId,
  workspaceName,
  logoKey,
  className,
  size = "md",
}: WorkspaceLogoProps) {
  const [state, setState] = useState({ key: "", url: "", failed: false });
  const requestKey = useMemo(() => `${workspaceId}:${logoKey ?? "none"}`, [logoKey, workspaceId]);

  useEffect(() => {
    if (!logoKey) return;

    let active = true;
    let objectUrl = "";
    void loadAuthorizedWorkspaceLogoUrl(workspaceId)
      .then((url) => {
        objectUrl = url;
        if (active) setState({ key: requestKey, url, failed: false });
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (active) setState({ key: requestKey, url: "", failed: true });
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [logoKey, requestKey, workspaceId]);

  const isLoading = Boolean(logoKey) && state.key !== requestKey;
  const url = state.key === requestKey ? state.url : "";
  const failed = state.key === requestKey && state.failed;

  return (
    <span className={cn("workspace-logo", `workspace-logo-${size}`, className)}>
      {url ? (
        // The source is an authenticated, workspace-scoped object URL.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`${workspaceName} logo`} />
      ) : isLoading ? (
        <LoaderCircle className="workspace-logo-loading spin" aria-label="Loading workspace logo" />
      ) : failed ? (
        <ImageOff aria-label="Workspace logo unavailable" />
      ) : (
        <span aria-label={`${workspaceName} initial`}>{initials(workspaceName)}</span>
      )}
    </span>
  );
}
