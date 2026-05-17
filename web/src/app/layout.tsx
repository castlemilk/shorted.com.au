import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "~/styles/globals.css";
import { criticalCSS } from "~/styles/critical-css";

import dynamic from "next/dynamic";
import { cn } from "../@/lib/utils";
import { type Viewport } from "next";
import { ThemeProvider } from "~/@/components/providers";
import { ThemeSwitcher } from "~/@/components/theme-switcher";
import { ConditionalHeader } from "./conditional-header";
import { ConditionalFooter } from "./conditional-footer";
import { NextAuthProvider } from "./next-auth-provider";
import { siteConfig } from "~/@/config/site";
import { Toaster } from "~/@/components/ui/toaster";
import {
  EnvironmentBanner,
  DevelopmentBanner,
} from "~/@/components/ui/environment-banner";
import { WebVitalsReporter } from "~/@/components/web-vitals-reporter";
import { GoogleAnalytics } from "@next/third-parties/google";

// Client-only: uses Connect-RPC streaming which breaks SSR
const ChatSidebar = dynamic(
  () => import("~/@/components/chat/chat-sidebar").then((mod) => ({ default: mod.ChatSidebar })),
  { ssr: false },
);

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
    google: "jk574DQKIqA97yDXw873BVts2Z9Yz_FxmGZCmXYsv9c",
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
    apple: "/apple-touch-icon.png",
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {

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
        <link
          rel="alternate"
          type="application/rss+xml"
          title="Shorted Blog RSS Feed"
          href="/feed.xml"
        />
        <link rel="preconnect" href="https://storage.googleapis.com" />
        <link rel="preconnect" href="https://www.googletagmanager.com" />
        <link rel="dns-prefetch" href="https://storage.googleapis.com" />
        <link rel="dns-prefetch" href="https://www.googletagmanager.com" />
        {/* News-card image CDNs — improves LCP on /news + per-stock /news. */}
        <link rel="dns-prefetch" href="https://kalkinemedia.com" />
        <link rel="dns-prefetch" href="https://stockhead.com.au" />
        <link rel="dns-prefetch" href="https://www.fool.com.au" />
        <link rel="dns-prefetch" href="https://smallcaps.com.au" />
        {/* WebSite schema with Sitelinks Search Action — Google may render
            a search box directly in SERPs for shorted.com.au. The action
            target is the /search page (also added in this batch). */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "Shorted",
              alternateName: "Shorted.com.au",
              url: "https://shorted.com.au",
              description:
                "Australia's ASX short-selling data platform — ASIC short positions, sentiment, and analysis.",
              inLanguage: "en-AU",
              publisher: {
                "@type": "Organization",
                name: "Shorted",
                url: "https://shorted.com.au",
                logo: {
                  "@type": "ImageObject",
                  url: "https://shorted.com.au/icon.png",
                },
              },
              potentialAction: {
                "@type": "SearchAction",
                target: {
                  "@type": "EntryPoint",
                  urlTemplate:
                    "https://shorted.com.au/search?q={search_term_string}",
                },
                "query-input": "required name=search_term_string",
              },
            }),
          }}
        />
        {/* Mark HTML as loaded to prevent FOUC */}
        <script
          dangerouslySetInnerHTML={{
            __html: inlineLoadScript,
          }}
        />
      </head>
      <body className={cn("min-h-screen bg-background font-sans antialiased")}>
        <NextAuthProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <div className="relative z-10">
              <EnvironmentBanner />
              <DevelopmentBanner />
              <ConditionalHeader />
              {children}
              <ConditionalFooter />
              <ThemeSwitcher />
              <Toaster />
              <WebVitalsReporter />
              <ChatSidebar />
            </div>
          </ThemeProvider>
        </NextAuthProvider>
      {process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID && (
        <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID} />
      )}
      </body>
    </html>
  );
}
