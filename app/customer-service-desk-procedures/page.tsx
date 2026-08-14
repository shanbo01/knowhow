import type { Metadata } from "next";
import { BookCheck, Headphones, Workflow } from "lucide-react";
import { UseCasePage } from "../components/use-case-page";

export const metadata: Metadata = {
  title: "Customer and service-desk procedures | KnowHow",
  description:
    "Give customer and service-desk teams clear, governed procedures for triage, resolution, and escalation.",
};

export default function ServiceDeskProceduresPage() {
  return (
    <UseCasePage
      eyebrow="Customer and service-desk procedures"
      title="Help every responder reach the next safe action with confidence."
      intro="Turn repeat incident, request, and customer-support workflows into concise guides that distinguish routine resolution from the moment a teammate should stop and escalate."
      sectionId="service-desk"
      framing={{
        label: "Consistency without scripting the conversation",
        title:
          "Give responders a dependable path through the systems behind service.",
        copy: "KnowHow captures the browser workflow around a request while leaving room for judgment, customer context, and explicit escalation boundaries.",
      }}
      phases={[
        {
          icon: Headphones,
          title: "Capture the resolution path",
          copy: "Record the structure of repeat ticket, identity, application, and service workflows using synthetic examples and redacted screenshots.",
        },
        {
          icon: Workflow,
          title: "Mark decisions and escalation",
          copy: "Explain prerequisites, approval points, safe stopping conditions, ownership transfers, and the situations that require a specialist instead of silent improvisation.",
        },
        {
          icon: BookCheck,
          title: "Publish to the responder group",
          copy: "Target each guide to the right audience, keep one approved version, and use completion signals to support coaching and rollout of changed procedures.",
        },
      ]}
      outcomesTitle="Faster consistency without weakening escalation discipline."
      outcomesIntro="Responders spend less time hunting for the next system step while owners retain a controlled path for changes and review."
      outcomes={[
        "A current resolution guide available at the moment of work",
        "Clear stopping and escalation points for non-routine cases",
        "Audience-scoped rollout when a service procedure changes",
        "A practical foundation for onboarding and quality coaching",
      ]}
      boundary={{
        title: "Customer data does not belong in a reusable guide.",
        copy: "Capture only synthetic or safely redacted examples. Tickets, credentials, payment details, health information, identity documents, and other customer-specific values must remain in their approved systems of record.",
      }}
    />
  );
}
