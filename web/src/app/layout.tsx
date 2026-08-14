import { IBM_Plex_Mono } from "next/font/google";
import localFont from "next/font/local";
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
import { Suspense } from "react";
import { DeferredGoogleAnalytics } from "~/@/components/deferred-google-analytics";
import { CloudflareWebAnalytics } from "~/@/components/cloudflare-web-analytics";
import { CloudflareJsDetections } from "~/@/components/cloudflare-js-detections";

// Client-only: uses Connect-RPC streaming which breaks SSR
const ChatSidebar = dynamic(
  () => import("~/@/components/chat/chat-sidebar").then((mod) => ({ default: mod.ChatSidebar })),
  { ssr: false },
);

// IBM Plex Mono - Primary monospace for terminal aesthetic
// Weights audited 2026-07: 400/500/600/700 in active use; 300 had 3 usages
// (2 admin-only, since normalised; 1 serif blockquote covered by the
// Newsreader variable font). Every weight here is a preloaded file on the
// LCP critical path of every route — don't add weights without checking use.
const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
  display: "swap",
  preload: true,
  fallback: ["JetBrains Mono", "Fira Code", "ui-monospace", "monospace"],
});

// Newsreader - Serif display face for the editorial masthead (/news).
// Only applied via explicit `font-serif` classes — no global effect.
// Vendored locally (OFL, web/src/fonts/newsreader): next/font/google broke the
// Vercel build — Next 14.2 has no fallback-metrics entry for Newsreader and the
// gstatic fetch failed in CI. adjustFontFallback off for the same reason.
const fontSerif = localFont({
  src: [
    { path: "../fonts/newsreader/Newsreader-Variable.woff2", style: "normal", weight: "200 800" },
    { path: "../fonts/newsreader/Newsreader-Italic-Variable.woff2", style: "italic", weight: "200 800" },
  ],
  variable: "--font-serif",
  display: "swap",
  // Editorial accent face only (font-serif surfaces: /news masthead, featured
  // cards). Not preloaded: ~290KB of woff2 on EVERY route's critical path was
  // the single largest preload cost (Lighthouse LCP dependency chain); Georgia
  // fallback + swap covers the brief gap on the pages that use it.
  preload: false,
  fallback: ["Georgia", "serif"],
  adjustFontFallback: false,
});

// Space Grotesk (display headings) was removed 2026-07: zero usages of the
// `font-display` class or `--font-display` var anywhere in src, yet its files
// were preloaded on every route. globals.css still defines --font-display
// with a system-ui fallback chain if a design ever wants it back.

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
    title: siteConfig.socialTitle,
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
    title: siteConfig.socialTitle,
    description: siteConfig.description,
    images: [siteConfig.ogImage],
    creator: "@shorted___",
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
    <html lang="en-AU" className={`${fontMono.variable} ${fontSerif.variable}`} suppressHydrationWarning>
      <head>
        {/* Inline critical CSS to prevent render-blocking */}
        <style dangerouslySetInnerHTML={{ __html: criticalCSS }} />
        {/* Pre-paint session sniff: mark html.anon when no next-auth cookie is
            present so critical CSS can reserve space for client-gated
            signed-out UI (login banner) without layout shift. Synchronous and
            tiny by design — must run before first paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{/(?:^|; ?)(?:__Secure-)?next-auth\\.session-token=/.test(document.cookie)||document.documentElement.classList.add("anon")}catch(e){}',
          }}
        />
        {/* Non-critical CSS will be loaded by Next.js automatically */}
        {/* No fonts.googleapis/gstatic preconnects: next/font self-hosts all
            fonts at build time, so those origins are never contacted. */}
        <link
          rel="alternate"
          type="application/rss+xml"
          title="Shorted Blog RSS Feed"
          href="/feed.xml"
        />
        {/* GCS images are served via /_next/image (same-origin), so the
            browser never opens a direct connection to storage.googleapis.com
            on first paint — a preconnect there is wasted (Lighthouse flag).
            Keep the near-free dns-prefetch as a hint for any direct fetch. */}
        {/* gtag.js is idle-deferred (DeferredGoogleAnalytics), so a first-paint
            preconnect would open a connection ~seconds before it's used —
            dns-prefetch alone is the right hint now. */}
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
              "@id": "https://shorted.com.au/#website",
              name: "Shorted",
              alternateName: "Shorted.com.au",
              url: "https://shorted.com.au",
              description:
                "Australia's ASX short-selling data platform — ASIC short positions, sentiment, and analysis.",
              inLanguage: "en-AU",
              publisher: {
                "@type": "Organization",
                "@id": "https://shorted.com.au/#organization",
                name: "Shorted",
                url: "https://shorted.com.au",
                logo: {
                  "@type": "ImageObject",
                  url: siteConfig.logo.url,
                  width: siteConfig.logo.width,
                  height: siteConfig.logo.height,
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
          // Suspense: useSearchParams inside requires a boundary in a layout.
          <Suspense fallback={null}>
            <DeferredGoogleAnalytics
              gaId={process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID}
            />
          </Suspense>
        )}
        <CloudflareWebAnalytics />
        <CloudflareJsDetections />
      </body>
    </html>
  );
}
