import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Sign in | KnowHow",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  redirect("/app?mode=sign-in");
}
