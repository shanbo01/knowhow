import type { Metadata } from "next";
import { BookOpenCheck, KeyRound, Wrench } from "lucide-react";
import { UseCasePage } from "../components/use-case-page";

export const metadata: Metadata = {
  title: "Internal IT process knowledge | KnowHow",
  description:
    "Capture, govern, and share internal IT procedures without losing ownership, access control, or review history.",
};

export default function InternalItPage() {
  return (
    <UseCasePage
      eyebrow="Internal IT operations"
      title="Turn the way IT actually works into guidance the whole team can trust."
      intro="Capture identity, endpoint, application, and service procedures while the work is happening—then give every guide an owner, audience, review path, and measurable completion trail."
      sectionId="internal-it"
      framing={{
        label: "From specialist knowledge to team practice",
        title:
          "Keep the speed of a walkthrough without inheriting its ambiguity.",
        copy: "KnowHow joins browser-first capture with the publishing controls internal IT needs when a process spans privileged tools, handoffs, and changing interfaces.",
      }}
      phases={[
        {
          icon: Wrench,
          title: "Capture the working path",
          copy: "Record the structure of a real browser workflow while excluding unsafe hosts, blocking password fields, and masking selected screenshot regions before upload.",
        },
        {
          icon: KeyRound,
          title: "Scope access deliberately",
          copy: "Assign ownership, reviewer and publisher responsibilities, workspace membership, and guide audiences without giving organization administrators automatic content access.",
        },
        {
          icon: BookOpenCheck,
          title: "Publish one current answer",
          copy: "Release the approved revision, track teammate views and completion, and return the guide to review when the process or interface changes.",
        },
      ]}
      outcomesTitle="Less tribal knowledge. Fewer risky improvisations."
      outcomesIntro="The goal is not more documentation. It is a maintained operating path that is easy to find at the moment of need."
      outcomes={[
        "A clear owner and review state for every published procedure",
        "Exact workspace and audience boundaries around operational content",
        "A faster handoff from experienced operators to new teammates",
        "Content-free adoption events that show whether guidance reached the team",
      ]}
      boundary={{
        title: "Operational guidance is not a secret store.",
        copy: "Credentials, recovery codes, private keys, payment data, health data, national IDs, and other sensitive values must never be captured. KnowHow records the approved process—not the secret used to perform it.",
      }}
    />
  );
}
