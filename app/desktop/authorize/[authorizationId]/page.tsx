import type { Metadata } from "next";
import { notFound } from "next/navigation";
import DesktopAuthorizationClient from "./desktop-authorization-client";

export const metadata: Metadata = {
  title: "Connect KnowHow Capture | KnowHow",
  description: "Approve a named Windows device for private workflow capture.",
  robots: { index: false, follow: false },
};

export default async function DesktopAuthorizationPage({
  params,
}: {
  params: Promise<{ authorizationId: string }>;
}) {
  const { authorizationId } = await params;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(authorizationId)) {
    notFound();
  }
  return <DesktopAuthorizationClient authorizationId={authorizationId} />;
}
