import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicGuideView } from "../../components/public-guide-view";
import type { PublicGuideBundle } from "../../../lib/knowhow-types";
import { createRequestServices } from "../../../lib/server/request-services";
import { loadPublicGuide } from "../../../lib/server/public-guide-service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared guide — KnowHow",
  robots: { index: false, follow: false },
};

export default async function SharedGuidePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  let bundle: PublicGuideBundle;
  try {
    bundle = await loadPublicGuide(createRequestServices().store, token);
  } catch {
    notFound();
  }
  return <PublicGuideView bundle={bundle} />;
}
