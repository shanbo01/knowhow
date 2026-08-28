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
  /** Drops the tile background so the mark sits directly on the surface. */
  bare?: boolean;
};

/**
 * Widest and narrowest box a logo may claim, as a multiple of its row height.
 * Wordmarks are usually 2:1 to 3:1, so the cap keeps a banner from crowding
 * the row while still letting it read at full height.
 */
const WIDEST_RATIO = 3.2;
const NARROWEST_RATIO = 0.7;

function initials(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "W";
}

function clampedRatio(width: number, height: number) {
  if (!width || !height) return 1;
  return Math.min(WIDEST_RATIO, Math.max(NARROWEST_RATIO, width / height));
}

/** Shows the private workspace logo when present and a stable initial fallback otherwise. */
export function WorkspaceLogo({
  workspaceId,
  workspaceName,
  logoKey,
  className,
  size = "md",
  bare = false,
}: WorkspaceLogoProps) {
  const [state, setState] = useState({ key: "", url: "", failed: false });
  const [ratio, setRatio] = useState({ key: "", value: 1 });
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
  // Stay square until the raster reports its own shape, so the row never
  // reflows through an intermediate width.
  const shape = ratio.key === requestKey ? ratio.value : 1;

  return (
    <span
      className={cn(
        "workspace-logo",
        `workspace-logo-${size}`,
        bare && "workspace-logo-bare",
        className,
      )}
      style={{ "--workspace-logo-ratio": shape } as React.CSSProperties}
    >
      {url ? (
        // The source is an authenticated, workspace-scoped object URL.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={`${workspaceName} logo`}
          onLoad={(event) =>
            setRatio({
              key: requestKey,
              value: clampedRatio(
                event.currentTarget.naturalWidth,
                event.currentTarget.naturalHeight,
              ),
            })
          }
        />
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
