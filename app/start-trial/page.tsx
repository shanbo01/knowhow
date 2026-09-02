import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { redirectSignedInToApp } from "../../lib/server/signed-in-redirect";

export const metadata: Metadata = {
  title: "Start free trial",
  robots: { index: false, follow: false },
};

export default async function StartTrialPage({
  searchParams,
}: {
  searchParams: Promise<{ beta?: string | string[] }>;
}) {
  await redirectSignedInToApp();
  const candidate = (await searchParams).beta;
  const beta = Array.isArray(candidate) ? candidate[0] : candidate;
  redirect(
    beta
      ? `/app?mode=sign-up&plan=pro_trial&beta=${encodeURIComponent(beta)}`
      : "/app?mode=sign-up&plan=pro_trial",
  );
}
