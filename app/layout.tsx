import type { Metadata } from "next";
import { headers } from "next/headers";
import { ThemeProvider } from "./components/theme-provider";
import "./globals.css";

const title = "KnowHow — SOPs captured, governed, and shared";
const description =
  "A privacy-first SOP capture and publishing workspace for MSPs and multi-entity teams.";

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
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
