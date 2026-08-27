"use client";

import type { PublicGuideBundle } from "../../lib/knowhow-types";
import { GuideReaderView } from "./guide-reader-view";

export function PublicGuideView({ bundle }: { bundle: PublicGuideBundle }) {
  const liveUrl =
    typeof window === "undefined"
      ? `/share/${encodeURIComponent(bundle.token)}`
      : window.location.href;

  return (
    <div className="public-guide-shell">
      <GuideReaderView
        guide={bundle.guide}
        revision={bundle.revision}
        revisionMode="published"
        workspaceId={bundle.workspace.id}
        workspaceName={bundle.workspace.name}
        accentColor={bundle.workspace.settings.accentColor}
        clickTargetColor={bundle.workspace.settings.clickTargetColor}
        liveUrl={liveUrl}
        audienceLabel="Anyone with the link"
        closeLabel="KnowHow home"
        showEngagement={false}
        onClose={() => window.location.assign("/")}
        mediaSourceUrl={(step) =>
          step.screenshotMediaId
            ? `/api/public/guides/${encodeURIComponent(bundle.token)}/media/${encodeURIComponent(step.screenshotMediaId)}`
            : undefined
        }
      />
    </div>
  );
}
