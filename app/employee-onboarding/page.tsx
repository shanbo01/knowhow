import type { Metadata } from "next";
import { BadgeCheck, MonitorSmartphone, UserRoundPlus } from "lucide-react";
import { UseCasePage } from "../components/use-case-page";

export const metadata: Metadata = {
  title: "Employee onboarding procedures | KnowHow",
  description:
    "Create consistent, governed employee onboarding guides across People Operations, IT, and hiring teams.",
};

export default function EmployeeOnboardingPage() {
  return (
    <UseCasePage
      eyebrow="Employee onboarding"
      title="Give every new starter the same clear path—without freezing it in a checklist."
      intro="Bring People Operations, IT, and team-specific onboarding steps into governed guides that explain what to do, who owns it, and when the procedure was last approved."
      sectionId="employee-onboarding"
      framing={{
        label: "One journey, accountable handoffs",
        title: "Standardize the setup work that crosses teams and systems.",
        copy: "Capture the browser-based parts of onboarding, add the human decisions around them, and publish role-appropriate guidance without exposing a new starter’s personal information.",
      }}
      phases={[
        {
          icon: UserRoundPlus,
          title: "Map each responsibility",
          copy: "Separate manager, People Operations, IT, and employee actions so every handoff has an owner instead of disappearing inside a shared checklist.",
        },
        {
          icon: MonitorSmartphone,
          title: "Capture system setup safely",
          copy: "Record the approved path through identity, application, and device consoles while masking personal fields and leaving credentials outside the guide.",
        },
        {
          icon: BadgeCheck,
          title: "Confirm readiness",
          copy: "Publish the reviewed guide to the right audience and use completion signals to see whether onboarding reached the people responsible for each step.",
        },
      ]}
      outcomesTitle="A calmer first day for the employee and the teams behind it."
      outcomesIntro="Onboarding becomes a maintained operating process rather than a chain of messages that has to be rediscovered for every hire."
      outcomes={[
        "Visible ownership across People Operations, IT, and the hiring team",
        "Role-specific guidance instead of one oversized onboarding document",
        "A controlled revision path when systems or policies change",
        "Completion evidence without copying personal data into analytics",
      ]}
      boundary={{
        title: "Document the procedure, never the person.",
        copy: "Use synthetic examples and redacted screenshots. Do not place identity documents, health information, national IDs, passwords, or employee records inside a KnowHow guide.",
      }}
    />
  );
}
