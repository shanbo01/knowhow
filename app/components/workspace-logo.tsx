"use client";

import { ImageOff, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { loadAuthorizedWorkspaceLogoUrl } from "../../lib/knowhow-client";
import { normalizeLogoRaster, type LogoRaster } from "../../lib/logo-raster";

type WorkspaceLogoProps = {
  workspaceId: string;
  workspaceName: string;
  logoKey?: string | null;
  className?: string;
  size?: "sm" | "md" | "lg";
};

/**
 * Widest and narrowest box a logo may claim, as a multiple of its row height.
 * Wordmarks are usually 2:1 to 3:1, so the cap keeps a banner from crowding
 * the row while still letting it read at full height.
 */
const WIDEST_RATIO = 3.2;
const NARROWEST_RATIO = 0.7;

/**
 * One fetch, decode and trim per logo, shared by every place the mark appears
 * at once — the sidebar switcher, the top bar and the branding preview.
 */
const rasters = new Map<string, Promise<LogoRaster>>();

function loadRaster(workspaceId: string, requestKey: string) {
  const cached = rasters.get(requestKey);
  if (cached) return cached;
  const pending = loadAuthorizedWorkspaceLogoUrl(workspaceId)
    .then(async (objectUrl) => {
      let raster: LogoRaster;
      try {
        raster = await normalizeLogoRaster(objectUrl);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }
      // A logo that is already tight, or that could not be measured, is served
      // straight from the source blob. Only revoke once the result no longer
      // points at it, or the mark renders as a broken image.
      if (raster.url !== objectUrl) URL.revokeObjectURL(objectUrl);
      return raster;
    })
    .catch((error) => {
      rasters.delete(requestKey);
      throw error;
    });
  rasters.set(requestKey, pending);
  return pending;
}

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
  const [state, setState] = useState<{
    key: string;
    raster: LogoRaster | null;
    failed: boolean;
  }>({ key: "", raster: null, failed: false });
  const requestKey = useMemo(() => `${workspaceId}:${logoKey ?? "none"}`, [logoKey, workspaceId]);

  useEffect(() => {
    if (!logoKey) return;

    let active = true;
    void loadRaster(workspaceId, requestKey)
      .then((raster) => {
        if (active) setState({ key: requestKey, raster, failed: false });
      })
      .catch(() => {
        if (active) setState({ key: requestKey, raster: null, failed: true });
      });

    return () => {
      active = false;
    };
  }, [logoKey, requestKey, workspaceId]);

  const settled = state.key === requestKey;
  const isLoading = Boolean(logoKey) && !settled;
  const raster = settled ? state.raster : null;
  const failed = settled && state.failed;
  // Stay square until the raster reports its own shape, so the row never
  // reflows through an intermediate width.
  const ratio = raster
    ? Math.min(WIDEST_RATIO, Math.max(NARROWEST_RATIO, raster.ratio))
    : 1;

  return (
    <span
      className={cn("workspace-logo", `workspace-logo-${size}`, className)}
      data-plated={raster?.plate ? "true" : undefined}
      style={
        {
          "--workspace-logo-ratio": ratio,
          ...(raster?.plate ? { "--workspace-logo-plate": raster.plate } : {}),
        } as React.CSSProperties
      }
    >
      {raster ? (
        // The source is an authenticated, workspace-scoped raster.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={raster.url} alt={`${workspaceName} logo`} />
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
