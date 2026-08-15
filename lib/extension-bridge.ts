import type { Guide } from "./knowhow-types";
import { guideHref } from "./workspace-routes";

export const KNOWHOW_EXTENSION_ID = "phbofjenfnnnnndghhinoldlfbpaedpo";

export type ExtensionCompanionRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Everything the extension side panel needs to draw a step screenshot the same
 * way the app does: the private media object to request, the author's crop, the
 * click ring, and the blur regions that are still overlays.
 */
export type ExtensionCompanionMedia = {
  mediaId: string;
  crop?: ExtensionCompanionRegion;
  click?: { x: number; y: number; radius: number; color?: string };
  redactions?: ExtensionCompanionRegion[];
};

export type ExtensionCompanionStep = {
  id: string;
  kind: "action" | "heading" | "note" | "warning";
  title: string;
  description: string;
  media?: ExtensionCompanionMedia;
};

export type ExtensionCompanionGuide = {
  id: string;
  title: string;
  summary: string;
  status: "draft" | "review" | "published" | "archived";
  restricted: boolean;
  updatedAt: string;
  href: string;
  steps: ExtensionCompanionStep[];
};

export type ExtensionCompanion = {
  workspaceId: string;
  workspaceName: string;
  userName: string;
  theme: "light" | "dark";
  guides: ExtensionCompanionGuide[];
};

export function companionGuidesFromWorkspace(
  guides: Guide[],
  workspaceSlug: string,
): ExtensionCompanionGuide[] {
  return guides.flatMap((guide) => {
    const revision = guide.publishedRevision ?? guide.workingRevision;
    if (!revision) return [];
    const mode = guide.publishedRevision ? "published" : "working";
    return [
      {
        id: guide.id,
        title: revision.title || guide.title,
        summary: revision.summary,
        status: guide.status,
        restricted: guide.restricted,
        updatedAt: guide.updatedAt,
        href: guideHref(workspaceSlug, guide.id, mode),
        steps: revision.steps.map((step) => {
          const click = step.annotations?.find(
            (annotation) => annotation.kind === "click",
          );
          const pendingRedactions = (step.redactions ?? []).filter(
            (region) => !region.applied,
          );
          return {
            id: step.id,
            kind: step.kind,
            title: step.title,
            description: step.description,
            ...(step.screenshotMediaId
              ? {
                  media: {
                    mediaId: step.screenshotMediaId,
                    ...(step.crop ? { crop: step.crop } : {}),
                    ...(click
                      ? {
                          click: {
                            x: click.x,
                            y: click.y,
                            radius: click.width ?? 0.035,
                            ...(click.color ? { color: click.color } : {}),
                          },
                        }
                      : {}),
                    ...(pendingRedactions.length
                      ? {
                          redactions: pendingRedactions.map((region) => ({
                            x: region.x,
                            y: region.y,
                            width: region.width,
                            height: region.height,
                          })),
                        }
                      : {}),
                  },
                }
              : {}),
          };
        }),
      },
    ];
  });
}

type ExternalResponse = {
  ok?: boolean;
  error?: string;
  connection?: { connected?: boolean; workspaceId?: string | null };
  version?: string;
};

type ChromeRuntimeBridge = {
  lastError?: { message?: string };
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback: (response?: ExternalResponse) => void,
  ) => void;
};

function chromeRuntime(): ChromeRuntimeBridge | null {
  const browserGlobal = globalThis as typeof globalThis & {
    chrome?: { runtime?: ChromeRuntimeBridge };
  };
  return browserGlobal.chrome?.runtime ?? null;
}

function extensionMessage(message: unknown): Promise<ExternalResponse> {
  const runtime = chromeRuntime();
  if (!runtime?.sendMessage) {
    return Promise.reject(new Error("KnowHow Capture is not installed in this browser."));
  }
  return new Promise((resolve, reject) => {
    try {
      runtime.sendMessage(KNOWHOW_EXTENSION_ID, message, (response) => {
        const runtimeError = runtime.lastError?.message;
        if (runtimeError) {
          reject(new Error("KnowHow Capture is not installed or needs to be reloaded."));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "KnowHow Capture did not accept the request."));
          return;
        }
        resolve(response);
      });
    } catch {
      reject(new Error("KnowHow Capture is not available in this browser."));
    }
  });
}

export async function inspectKnowHowExtension() {
  const response = await extensionMessage({ type: "KNOWHOW_WEB_PING" });
  return {
    installed: true as const,
    version: response.version ?? "",
    connected: response.connection?.connected === true,
    workspaceId: response.connection?.workspaceId ?? null,
  };
}

export async function syncKnowHowExtension(companion: ExtensionCompanion) {
  await extensionMessage({ type: "KNOWHOW_WEB_SYNC", companion });
}

export async function connectKnowHowExtension(
  pairingCode: string,
  companion: ExtensionCompanion,
) {
  await extensionMessage({
    type: "KNOWHOW_WEB_CONNECT",
    pairingCode,
    companion,
  });
}

function httpsPublicUrl(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.startsWith("https://") ? trimmed : null;
}

export function extensionStoreUrls() {
  return {
    chrome: httpsPublicUrl(process.env.NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL),
    edge: httpsPublicUrl(process.env.NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL),
  };
}

export function chromiumExtensionHost() {
  return Boolean(chromeRuntime()?.sendMessage);
}

export type ExtensionLinkState =
  | { installed: false; reason: "missing" | "unavailable" }
  | { installed: true; connected: boolean; workspaceId: string | null; paired: boolean };

/**
 * Hands the signed-in workspace to the installed extension without asking
 * anyone to copy a code. Pairing credentials are minted only when the extension
 * is installed and not already holding this workspace, so a returning browser
 * costs one ping and a content refresh.
 */
export async function ensureKnowHowExtension(
  companion: ExtensionCompanion,
  mintPairingCode: () => Promise<{ code: string }>,
  { force = false }: { force?: boolean } = {},
): Promise<ExtensionLinkState> {
  if (!chromiumExtensionHost()) {
    return { installed: false, reason: "unavailable" };
  }
  let status: Awaited<ReturnType<typeof inspectKnowHowExtension>>;
  try {
    status = await inspectKnowHowExtension();
  } catch {
    return { installed: false, reason: "missing" };
  }
  if (!force && status.connected && status.workspaceId === companion.workspaceId) {
    await syncKnowHowExtension(companion);
    return {
      installed: true,
      connected: true,
      workspaceId: status.workspaceId,
      paired: false,
    };
  }
  const pairing = await mintPairingCode();
  await connectKnowHowExtension(pairing.code, companion);
  return {
    installed: true,
    connected: true,
    workspaceId: companion.workspaceId,
    paired: true,
  };
}
