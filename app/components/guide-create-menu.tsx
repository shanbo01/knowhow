"use client";

import {
  ChevronDown,
  ChevronRight,
  Globe2,
  Laptop,
  PenLine,
  Plus,
  ShieldCheck,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProBadge } from "./pro-badge";

type ExtensionState =
  | "checking"
  | "missing"
  | "error"
  | "unavailable"
  | "connected";

type MenuAppearance = "topbar" | "button" | "card";

type CaptureStatus = {
  label: string;
  tone: "ready" | "setup" | "pro" | "muted";
};

function CaptureStatusChip({ status }: { status: CaptureStatus }) {
  if (status.tone === "pro") return <ProBadge size="sm" />;
  return (
    <span className="guide-create-status" data-tone={status.tone}>
      {status.label}
    </span>
  );
}

export function GuideCreateMenu({
  appearance = "topbar",
  label = "New guide",
  className,
  busy,
  browserPlanEnabled,
  browserAvailable,
  desktopPlanEnabled,
  desktopAvailable,
  extensionState,
  desktopDeviceCount,
  onManual,
  onBrowser,
  onDesktop,
  onOpenPlan,
}: {
  appearance?: MenuAppearance;
  label?: string;
  className?: string;
  busy: boolean;
  browserPlanEnabled: boolean;
  browserAvailable: boolean;
  desktopPlanEnabled: boolean;
  desktopAvailable: boolean;
  extensionState: ExtensionState;
  desktopDeviceCount: number;
  onManual: () => void;
  onBrowser: () => void;
  onDesktop: () => void;
  onOpenPlan?: () => void;
}) {
  const browserStatus: CaptureStatus = !browserPlanEnabled
    ? { label: "Pro", tone: "pro" }
    : !browserAvailable
      ? { label: "Unavailable", tone: "muted" }
      : extensionState === "connected"
        ? { label: "Ready", tone: "ready" }
        : extensionState === "checking"
          ? { label: "Checking…", tone: "muted" }
          : { label: "Set up", tone: "setup" };
  const desktopStatus: CaptureStatus = !desktopPlanEnabled
    ? { label: "Pro", tone: "pro" }
    : !desktopAvailable
      ? { label: "Unavailable", tone: "muted" }
      : desktopDeviceCount > 0
        ? {
            label:
              desktopDeviceCount === 1
                ? "Connected"
                : `${desktopDeviceCount} connected`,
            tone: "ready",
          }
        : { label: "Install", tone: "setup" };
  const browserCanUpgrade = !browserPlanEnabled && Boolean(onOpenPlan);
  const desktopCanUpgrade = !desktopPlanEnabled && Boolean(onOpenPlan);
  const isCard = appearance === "card";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        disabled={busy}
        aria-label="Create a new guide"
        data-slot={isCard ? undefined : "button"}
        data-size={appearance === "topbar" ? "sm" : undefined}
        data-variant={isCard ? undefined : "default"}
        className={cn(
          !isCard &&
            buttonVariants({
              size: appearance === "topbar" ? "sm" : "default",
            }),
          appearance === "topbar" &&
            "top-create topbar-primary-action new-guide-trigger",
          appearance === "button" && "new-guide-trigger new-guide-button",
          isCard && "new-guide-card-trigger",
          className,
        )}
      >
        {isCard ? (
          <>
            <span className="new-guide-card-icon">
              <Plus />
            </span>
            <span className="new-guide-card-copy">
              <strong>Create a guide</strong>
              <small>Record a workflow or build one from scratch.</small>
            </span>
            <ChevronRight className="new-guide-card-arrow" />
          </>
        ) : (
          <>
            <Plus />
            <span>{label}</span>
            <ChevronDown className="new-guide-chevron" />
          </>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="guide-create-menu"
        align={appearance === "topbar" ? "end" : "start"}
        sideOffset={8}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="guide-create-menu-label">
            Record a workflow
          </DropdownMenuLabel>
          <DropdownMenuItem
            className="guide-create-option"
            disabled={
              busy || (!browserAvailable && !browserCanUpgrade)
            }
            onClick={browserAvailable ? onBrowser : onOpenPlan}
          >
            <span className="guide-create-option-icon" data-kind="browser">
              <Globe2 />
            </span>
            <span className="guide-create-option-copy">
              <strong>Browser extension</strong>
              <small>Capture clicks and pages in Chrome or Edge.</small>
            </span>
            <CaptureStatusChip status={browserStatus} />
          </DropdownMenuItem>
          <DropdownMenuItem
            className="guide-create-option"
            disabled={
              busy || (!desktopAvailable && !desktopCanUpgrade)
            }
            onClick={desktopAvailable ? onDesktop : onOpenPlan}
          >
            <span className="guide-create-option-icon" data-kind="desktop">
              <Laptop />
            </span>
            <span className="guide-create-option-copy">
              <strong>Desktop app</strong>
              <small>Capture steps across Windows apps.</small>
            </span>
            <CaptureStatusChip status={desktopStatus} />
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator className="guide-create-separator" />

        <DropdownMenuGroup>
          <DropdownMenuLabel className="guide-create-menu-label">
            Build manually
          </DropdownMenuLabel>
          <DropdownMenuItem
            className="guide-create-option"
            disabled={busy}
            onClick={onManual}
          >
            <span className="guide-create-option-icon" data-kind="manual">
              <PenLine />
            </span>
            <span className="guide-create-option-copy">
              <strong>Manual guide</strong>
              <small>Write steps and add screenshots at your own pace.</small>
            </span>
            <ChevronRight className="guide-create-option-arrow" />
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <div className="guide-create-menu-note">
          <ShieldCheck />
          <span>Every option starts as a private, editable draft.</span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
