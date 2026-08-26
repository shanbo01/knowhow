import type { AppSnapshot } from "./types";

// Shared between the footer button's title and the Settings screen's update
// section, so both surfaces describe the same state the same way.
export function updateStatusLabel(update: AppSnapshot["update"], updateError: string) {
  switch (update.status) {
    case "checking":
      return "Checking for updates…";
    case "available":
      // check_for_updates always installs once it finds an update — there is
      // no separate "available, not yet installed" state to represent.
      return update.version
        ? `Update v${update.version} found — installing…`
        : "Update found — installing…";
    case "deferred":
      return "Update check paused until the current capture finishes.";
    case "current":
      return "You're up to date.";
    case "error":
      return updateError
        ? `Couldn't check for updates: ${updateError}`
        : "Couldn't check for updates.";
    default:
      return "Not checked yet.";
  }
}
