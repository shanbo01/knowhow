import { describe, expect, it } from "vitest";
import {
  selectedTarget,
  targetsForScope,
  typedTextEnabled,
} from "./setup";
import type { CaptureTarget, RecorderSettings } from "./types";

const targets: CaptureTarget[] = [
  {
    id: "protected-window",
    kind: "window",
    label: "Windows Security",
    detail: "Credential surface",
    protected: true,
  },
  {
    id: "notepad-window",
    kind: "window",
    label: "Notes",
    detail: "Notepad",
    protected: false,
  },
  {
    id: "notepad-app",
    kind: "application",
    label: "Notepad",
    detail: "Notes",
    protected: false,
  },
];

describe("capture setup guards", () => {
  it("never auto-selects a protected target", () => {
    expect(selectedTarget(targetsForScope(targets, "window"), "")).toMatchObject({
      id: "notepad-window",
    });
    expect(
      selectedTarget(targetsForScope(targets, "window"), "protected-window"),
    ).toMatchObject({ id: "notepad-window" });
  });

  it("keeps application and window scopes distinct", () => {
    expect(targetsForScope(targets, "application").map((target) => target.id)).toEqual([
      "notepad-app",
    ]);
  });

  it("fails typed text closed when workspace policy disables it", () => {
    const settings: RecorderSettings = {
      captureTypedText: true,
      desktopTypedTextPolicy: "disabled",
      smartBlur: {
        emails: false,
        phoneNumbers: false,
        financialNumbers: false,
        identifiers: false,
        formFields: false,
        images: false,
        tableRows: false,
        longText: false,
      },
    };
    expect(typedTextEnabled(settings)).toBe(false);
  });
});
