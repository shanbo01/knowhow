"use client";

import { ImageOff, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { loadAuthorizedMediaUrl } from "../../lib/rivet-client";

export function AuthorizedMedia({
  workspaceId,
  mediaId,
  alt,
  compact = false,
  overlay,
}: {
  workspaceId: string;
  mediaId: string;
  alt: string;
  compact?: boolean;
  overlay?: ReactNode;
}) {
  const mediaKey = `${workspaceId}:${mediaId}`;
  const [media, setMedia] = useState({ key: "", url: "", error: "" });

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    void loadAuthorizedMediaUrl(workspaceId, mediaId)
      .then((nextUrl) => {
        objectUrl = nextUrl;
        if (active) setMedia({ key: mediaKey, url: nextUrl, error: "" });
        else URL.revokeObjectURL(nextUrl);
      })
      .catch((nextError: unknown) => {
        if (active) {
          setMedia({
            key: mediaKey,
            url: "",
            error:
              nextError instanceof Error
                ? nextError.message
                : "The protected screenshot could not be loaded.",
          });
        }
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mediaId, mediaKey, workspaceId]);

  const url = media.key === mediaKey ? media.url : "";
  const error = media.key === mediaKey ? media.error : "";

  if (error) {
    return (
      <div className={`authorized-media-state${compact ? " compact" : ""}`} role="status">
        <ImageOff />
        <span>{error}</span>
      </div>
    );
  }
  if (!url) {
    return (
      <div className={`authorized-media-state${compact ? " compact" : ""}`} role="status">
        <LoaderCircle className="spin" />
        <span>Loading protected screenshot</span>
      </div>
    );
  }
  return (
    <figure className={`authorized-media${compact ? " compact" : ""}`}>
      {/* The server returns only audience-authorized, locally redacted media. */}
      <div className="authorized-media-frame">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={alt} />
        {overlay ? <div className="authorized-media-overlay" aria-hidden="true">{overlay}</div> : null}
      </div>
      <figcaption><ShieldCheck /> Locally redacted before upload</figcaption>
    </figure>
  );
}
