"use client";

import { ImageOff, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  acquireAuthorizedMediaUrl,
  refreshAuthorizedMediaUrl,
  releaseAuthorizedMediaUrl,
} from "../../lib/knowhow-client";

export function AuthorizedMedia({
  workspaceId,
  mediaId,
  alt,
  compact = false,
  crop,
  overlay,
}: {
  workspaceId: string;
  mediaId: string;
  alt: string;
  compact?: boolean;
  crop?: { x: number; y: number; width: number; height: number };
  overlay?: ReactNode;
}) {
  const mediaKey = `${workspaceId}:${mediaId}`;
  const [media, setMedia] = useState({ key: "", url: "", error: "" });
  const [dimensions, setDimensions] = useState({ key: "", width: 0, height: 0 });
  const decodeRetryRef = useRef("");

  useEffect(() => {
    let active = true;
    decodeRetryRef.current = "";
    void acquireAuthorizedMediaUrl(workspaceId, mediaId)
      .then((nextUrl) => {
        if (active) setMedia({ key: mediaKey, url: nextUrl, error: "" });
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
      releaseAuthorizedMediaUrl(workspaceId, mediaId);
    };
  }, [mediaId, mediaKey, workspaceId]);

  const url = media.key === mediaKey ? media.url : "";
  const error = media.key === mediaKey ? media.error : "";
  const normalizedCrop = crop &&
    Number.isFinite(crop.x) &&
    Number.isFinite(crop.y) &&
    Number.isFinite(crop.width) &&
    Number.isFinite(crop.height) &&
    crop.width > 0 &&
    crop.height > 0
      ? {
          x: Math.max(0, Math.min(1, crop.x)),
          y: Math.max(0, Math.min(1, crop.y)),
          width: Math.max(0.01, Math.min(1 - Math.max(0, crop.x), crop.width)),
          height: Math.max(0.01, Math.min(1 - Math.max(0, crop.y), crop.height)),
        }
      : null;
  const natural = dimensions.key === mediaKey ? dimensions : null;
  const croppedAspectRatio = normalizedCrop && natural?.width && natural.height
    ? (natural.width * normalizedCrop.width) /
      (natural.height * normalizedCrop.height)
    : normalizedCrop
      ? 16 / 9
      : undefined;
  const stageStyle = normalizedCrop
    ? {
        left: `${(-normalizedCrop.x / normalizedCrop.width) * 100}%`,
        top: `${(-normalizedCrop.y / normalizedCrop.height) * 100}%`,
        width: `${100 / normalizedCrop.width}%`,
      }
    : undefined;

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
      <div
        className={`authorized-media-frame${normalizedCrop ? " cropped" : ""}`}
        style={croppedAspectRatio ? { aspectRatio: String(croppedAspectRatio) } : undefined}
      >
        <div className="authorized-media-stage" style={stageStyle}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={alt}
            onLoad={(event) => {
              setDimensions({
                key: mediaKey,
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
            }}
            onError={() => {
              if (decodeRetryRef.current === mediaKey) {
                setMedia({
                  key: mediaKey,
                  url: "",
                  error: "The protected screenshot could not be displayed.",
                });
                return;
              }
              decodeRetryRef.current = mediaKey;
              void refreshAuthorizedMediaUrl(workspaceId, mediaId)
                .then((nextUrl) => {
                  setMedia({ key: mediaKey, url: nextUrl, error: "" });
                })
                .catch((nextError: unknown) => {
                  setMedia({
                    key: mediaKey,
                    url: "",
                    error:
                      nextError instanceof Error
                        ? nextError.message
                        : "The protected screenshot could not be loaded.",
                  });
                });
            }}
          />
          {overlay ? <div className="authorized-media-overlay" aria-hidden="true">{overlay}</div> : null}
        </div>
      </div>
      <figcaption><ShieldCheck /> Locally redacted before upload</figcaption>
    </figure>
  );
}
