import type { SmartBlurSettings } from "./types";

// The eight Smart Blur detectors, in the order the capture picker and
// Settings both present them. Shared here so both surfaces render the exact
// same list, in the exact same order.
const SMART_BLUR_FIELDS = [
  ["emails", "Email addresses"],
  ["phoneNumbers", "Phone numbers"],
  ["financialNumbers", "Financial numbers"],
  ["identifiers", "Long identifiers"],
  ["formFields", "Form fields"],
  ["images", "Images"],
  ["tableRows", "Table rows"],
  ["longText", "Long text regions"],
] as const;

export function SmartBlurToggles({
  settings,
  onChange,
}: {
  settings: SmartBlurSettings;
  onChange: (next: SmartBlurSettings) => void;
}) {
  return (
    <div className="blur-options">
      {SMART_BLUR_FIELDS.map(([key, label]) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={settings[key]}
            onChange={(event) => onChange({ ...settings, [key]: event.target.checked })}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}
