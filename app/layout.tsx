import type { Metadata } from "next";
import { headers } from "next/headers";
import "@fontsource-variable/google-sans-flex/wght.css";
import { ThemeProvider } from "./components/theme-provider";
import "./globals.css";
import "./auth-experience.css";
import "./workspace-experience.css";
import "./administration-experience.css";
import "./ui-system.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

const title = "KnowHow — process knowledge that stays useful";
const description =
  "Capture real browser work, turn it into a trusted guide, and see whether the team finished it.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3001";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const imageUrl = `${origin}/og.png`;

  return {
    metadataBase: new URL(origin),
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      siteName: "KnowHow",
      images: [
        {
          url: imageUrl,
          width: 1732,
          height: 909,
          alt: "KnowHow IT operations documentation workspace",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <ThemeProvider>
          <TooltipProvider delay={200}>{children}</TooltipProvider>
          <Toaster position="bottom-right" closeButton richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
