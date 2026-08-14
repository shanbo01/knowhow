import type { Metadata } from "next";
import { GraduationCap, MonitorPlay, MousePointerClick } from "lucide-react";
import { UseCasePage } from "../components/use-case-page";

export const metadata: Metadata = {
  title: "Workflow-based software training | KnowHow",
  description:
    "Teach repeatable software workflows with captured, reviewed, role-scoped guides and completion signals.",
};

export default function SoftwareTrainingPage() {
  return (
    <UseCasePage
      eyebrow="Software training"
      title="Teach the workflow people need to finish—not every menu in the product."
      intro="Capture task-specific browser paths, add the decisions an experienced teammate makes, and publish focused guidance that stays connected to ownership and review."
      sectionId="software-training"
      framing={{
        label: "Learning attached to the task",
        title: "Move from passive walkthroughs to guided, repeatable work.",
        copy: "KnowHow helps trainers and application owners build concise guides from the real interface, then target those guides to the roles that perform the work.",
      }}
      phases={[
        {
          icon: MonitorPlay,
          title: "Demonstrate a real outcome",
          copy: "Capture a complete workflow using a safe training record so the guide begins with the same sequence a teammate will perform.",
        },
        {
          icon: MousePointerClick,
          title: "Explain the decisions",
          copy: "Refine each step with purpose, prerequisites, choices, and exception guidance instead of leaving learners to interpret a silent click path.",
        },
        {
          icon: GraduationCap,
          title: "Publish and reinforce",
          copy: "Assign the right audience, release the reviewed revision, and use views or completions to understand whether the training reached its intended team.",
        },
      ]}
      outcomesTitle="Training that remains useful after the session ends."
      outcomesIntro="The team receives a current reference for the job while application owners keep a visible maintenance and approval path."
      outcomes={[
        "Focused guidance organized around outcomes rather than feature tours",
        "A repeatable handoff from subject-matter expert to learner",
        "Role-appropriate audiences for different software responsibilities",
        "Clear ownership when an interface or business rule changes",
      ]}
      boundary={{
        title: "Use training data from the start.",
        copy: "Record synthetic examples and mask sensitive fields before screenshots leave the browser. Training guides must never contain production passwords, secrets, payment information, regulated data, or private customer records.",
      }}
    />
  );
}
