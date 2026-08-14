import type { Metadata } from "next";
import { FileCheck2, RefreshCw, Route } from "lucide-react";
import { UseCasePage } from "../components/use-case-page";

export const metadata: Metadata = {
  title: "Operational procedures and playbooks | KnowHow",
  description:
    "Turn repeatable browser workflows into owned, reviewed, audience-scoped operational procedures.",
};

export default function OperationalProceduresPage() {
  return (
    <UseCasePage
      eyebrow="Operational procedures"
      title="Make repeatable work resilient to handoffs, change, and time."
      intro="KnowHow turns the steps operators perform in real systems into controlled procedures with a working revision, review status, publication history, and a clear audience."
      sectionId="operational-procedures"
      framing={{
        label: "Designed for work that keeps moving",
        title: "A procedure should evolve without losing its source of truth.",
        copy: "Capture the current path quickly, refine it with the people responsible for the outcome, and publish one approved version without leaving stale copies across folders and chat threads.",
      }}
      phases={[
        {
          icon: Route,
          title: "Follow the real workflow",
          copy: "Capture the browser sequence where the work occurs, then add context for prerequisites, decisions, exceptions, and safe stopping points.",
        },
        {
          icon: FileCheck2,
          title: "Review before release",
          copy: "Keep changes in a working revision, complete privacy review, assign the right reviewer and publisher, and scope the final guide to its intended audience.",
        },
        {
          icon: RefreshCw,
          title: "Maintain the standard",
          copy: "Use ownership, review dates, version history, and adoption signals to identify procedures that need attention before teams work around them.",
        },
      ]}
      outcomesTitle="One operating standard that remains practical to use."
      outcomesIntro="The published guide stays close to the task while governance remains visible to the people accountable for quality and access."
      outcomes={[
        "A traceable path from captured draft to approved publication",
        "Fewer uncontrolled copies of the same operational instruction",
        "Explicit audiences for procedures with different responsibilities",
        "Review and adoption signals that make maintenance actionable",
      ]}
      boundary={{
        title: "Governance supports judgment; it does not replace it.",
        copy: "Critical changes still need accountable human review. KnowHow records ownership, state, and history so operators know which procedure is approved and when to escalate an exception.",
      }}
    />
  );
}
