import type { Metadata } from "next";
import "@fontsource-variable/google-sans-flex/wght.css";
import { ThemeProvider } from "./components/theme-provider";
import "./globals.css";
import "./auth-experience.css";
import "./workspace-experience.css";
import "./administration-experience.css";
import "./ui-system.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/lib/marketing-content";
import { resolveSiteOrigin } from "@/lib/server/site-origin";

const title = `${PRODUCT_NAME} — ${PRODUCT_TAGLINE}`;
const description =
  "Capture a task as you do it, turn it into a reviewed step-by-step guide, and publish it where your team will look for it.";

export async function generateMetadata(): Promise<Metadata> {
  const origin = await resolveSiteOrigin();

  return {
    metadataBase: new URL(origin),
    title: {
      default: title,
      // Page titles read as "Pricing | KnowHow" without each page repeating the
      // product name; the home page overrides this with an absolute title.
      template: `%s | ${PRODUCT_NAME}`,
    },
    applicationName: PRODUCT_NAME,
    description,
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
    openGraph: {
      title,
      description,
      type: "website",
      siteName: PRODUCT_NAME,
      locale: "en",
    },
    // No image is advertised until there is one worth sharing. A card with a
    // title and description degrades cleanly; a card pointing at a missing
    // file renders as broken, so `summary` rather than `summary_large_image`.
    twitter: {
      card: "summary",
      title,
      description,
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
