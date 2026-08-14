import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Contact | KnowHow",
  robots: { index: false, follow: true },
};

export default function RequestDemoPage() {
  redirect("/contact");
}
