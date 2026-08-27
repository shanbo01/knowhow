export type StepLink = {
  href: string;
  label: string;
  before: string;
  after: string;
};

export function parseStepLink(value: string): StepLink | null {
  const match = value.match(/https?:\/\/[^\s<>"']+/i);
  const candidate = match?.[0]?.replace(/[),.;!?]+$/, "");
  if (!candidate || match?.index === undefined) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    return {
      href: parsed.href,
      label: candidate,
      before: value.slice(0, match.index),
      after: value.slice(match.index + candidate.length),
    };
  } catch {
    return null;
  }
}
