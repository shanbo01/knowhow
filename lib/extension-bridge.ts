export const KNOWHOW_EXTENSION_ID = "phbofjenfnnnnndghhinoldlfbpaedpo";

export type ExtensionCompanionStep = {
  id: string;
  kind: "action" | "heading" | "note" | "warning";
  title: string;
  description: string;
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
  theme: "light" | "dark";
  guides: ExtensionCompanionGuide[];
};

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
