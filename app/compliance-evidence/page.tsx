import type { Metadata } from "next";
import { ClipboardCheck, ScrollText, ShieldCheck } from "lucide-react";
import { UseCasePage } from "../components/use-case-page";

export const metadata: Metadata = {
  title: "Operational compliance evidence | KnowHow",
  description:
    "Connect approved procedures, publication history, scoped access, and completion events into reviewable operational evidence.",
};

export default function ComplianceEvidencePage() {
  return (
    <UseCasePage
      eyebrow="Compliance evidence"
      title="Show how an approved process reached the people expected to follow it."
      intro="KnowHow connects procedure ownership, review and publication state, audience controls, and content-free adoption events so evidence starts with the work—not a last-minute evidence hunt."
      sectionId="compliance-evidence"
      framing={{
        label: "Evidence grounded in operations",
        title:
          "Keep the procedure, decision trail, and adoption signal connected.",
        copy: "Instead of rebuilding context for every review, teams can point to the approved revision, its accountable owners, its intended audience, and the events that show it was viewed or completed.",
      }}
      phases={[
        {
          icon: ScrollText,
          title: "Define the controlled procedure",
          copy: "Assign ownership, document the approved steps, complete privacy review, and publish only after the required responsibilities are satisfied.",
        },
        {
          icon: ShieldCheck,
          title: "Preserve the control context",
          copy: "Keep workspace membership, guide audiences, publication transitions, and exceptional-access decisions inside an auditable authorization model.",
        },
        {
          icon: ClipboardCheck,
          title: "Export the right evidence",
          copy: "Use authorized exports and content-free audit events to support a review without turning analytics or notification systems into copies of customer content.",
        },
      ]}
      outcomesTitle="Evidence that is easier to explain because it follows the process."
      outcomesIntro="Reviewers get a clearer operational story while workspace owners keep control of private guide content and authorized exports."
      outcomes={[
        "Named ownership and review state for published guidance",
        "Revision and publication history tied to the controlled guide",
        "Audience and membership boundaries visible as part of the record",
        "Views and completions measured without guide text in analytics",
      ]}
      boundary={{
        title: "KnowHow supports evidence; it does not certify compliance.",
        copy: "Your organization remains responsible for control design, legal interpretation, audit scope, and whether evidence is sufficient. Product events and exports must be reviewed in the context of the applicable requirement.",
      }}
      relatedHref="/trust"
      relatedLabel="Visit the trust center"
    />
  );
}
