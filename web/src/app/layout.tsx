import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "~/styles/globals.css";
import { criticalCSS } from "~/styles/critical-css";

import { cn } from "../@/lib/utils";
import { type Viewport } from "next";
import { ThemeProvider } from "~/@/components/providers";
import { ThemeSwitcher } from "~/@/components/theme-switcher";
import SiteHeader from "~/@/components/ui/site-header";
import { ConditionalFooter } from "./conditional-footer";
import { NextAuthProvider } from "./next-auth-provider";
import { siteConfig } from "~/@/config/site";
import { StructuredData } from "~/@/components/seo/structured-data";
import { EnhancedOrganizationSchema } from "~/@/components/seo/enhanced-structured-data";
import { Toaster } from "~/@/components/ui/toaster";
import {
  EnvironmentBanner,
  DevelopmentBanner,
} from "~/@/components/ui/environment-banner";
import { auth } from "~/server/auth";

// IBM Plex Mono - Primary monospace for terminal aesthetic
const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  preload: true,
  fallback: ["JetBrains Mono", "Fira Code", "ui-monospace", "monospace"],
});

// Space Grotesk - Display font for headings (optional, geometric sans)
const fontDisplay = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400", "500", "600", "700"],
  display: "swap",
  preload: true,
  fallback: ["system-ui", "sans-serif"],
});

export const metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.fullTitle,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  keywords: siteConfig.keywords,
  authors: [
    {
      name: siteConfig.author,
      url: siteConfig.url,
    },
  ],
  creator: siteConfig.creator,
  publisher: siteConfig.publisher,
  openGraph: {
    type: "website",
    locale: "en_AU",
    url: siteConfig.url,
    title: "Shorted - Official ASIC Short Position Data",
    description: siteConfig.description,
    siteName: siteConfig.name,
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Shorted - Official ASIC short selling data for ASX stocks with T+4 delay",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Shorted - Official ASIC Short Position Data",
    description: siteConfig.description,
    images: [siteConfig.ogImage],
    creator: "@shorted",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  verification: {
    google: "google-site-verification-code", // Replace with actual verification code
  },
  alternates: {
    canonical: siteConfig.url,
    languages: {
      "en-AU": siteConfig.url,
      "en": siteConfig.url,
      "x-default": siteConfig.url,
    },
  },
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/icon-1.webp",
  },
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F8F7F4" },  // Subtle warm white
    { media: "(prefers-color-scheme: dark)", color: "#0C0C0C" },   // Terminal black
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

// Critical CSS is imported from a TypeScript module
// This allows the CSS to be bundled properly in production

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  const inlineLoadScript = `
    if (typeof document !== "undefined") {
      document.documentElement.classList.add('loaded');
    }
  `.replace(/\s+/g, " ");

  return (
    <html lang="en-AU" className={`${fontMono.variable} ${fontDisplay.variable}`} suppressHydrationWarning>
      <head>
        {/* Inline critical CSS to prevent render-blocking */}
        <style dangerouslySetInnerHTML={{ __html: criticalCSS }} />
        {/* Non-critical CSS will be loaded by Next.js automatically */}
        {/* Resource hints for performance - preconnect to external domains */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link rel="preconnect" href="https://storage.googleapis.com" />
        <link rel="preconnect" href="https://www.googletagmanager.com" />
        <link rel="dns-prefetch" href="https://storage.googleapis.com" />
        <link rel="dns-prefetch" href="https://www.googletagmanager.com" />
        {/* Mark HTML as loaded to prevent FOUC */}
        <script
          dangerouslySetInnerHTML={{
            __html: inlineLoadScript,
          }}
        />
      </head>
      <body className={cn("min-h-screen bg-background font-sans antialiased")}>
        <NextAuthProvider session={session}>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <div className="relative z-10">
              <EnvironmentBanner />
              <DevelopmentBanner />
              <SiteHeader />
              {children}
              <ConditionalFooter />
              <ThemeSwitcher />
              <StructuredData />
              <EnhancedOrganizationSchema />
              <Toaster />
            </div>
          </ThemeProvider>
        </NextAuthProvider>
      </body>
    </html>
  );
}
