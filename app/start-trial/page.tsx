import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Start free trial | KnowHow",
  robots: { index: false, follow: false },
};

export default async function StartTrialPage({
  searchParams,
}: {
  searchParams: Promise<{ beta?: string | string[] }>;
}) {
  const candidate = (await searchParams).beta;
  const beta = Array.isArray(candidate) ? candidate[0] : candidate;
  redirect(
    beta
      ? `/app?mode=sign-up&beta=${encodeURIComponent(beta)}`
      : "/app?mode=sign-up",
  );
}
