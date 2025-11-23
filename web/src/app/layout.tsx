import { Inter as FontSans } from "next/font/google";
import "~/styles/globals.css";

import { cn } from "../@/lib/utils";
import { type Viewport } from "next";
import { ThemeProvider } from "~/@/components/providers";
import { ThemeSwitcher } from "~/@/components/theme-switcher";
import SiteHeader from "~/@/components/ui/site-header";
import SiteFooter from "~/@/components/ui/site-footer";
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

const fontSans = FontSans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap", // Optimize font loading
  preload: true,
  fallback: ["system-ui", "arial"],
});

export const metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.name,
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
    title: siteConfig.name,
    description: siteConfig.description,
    siteName: siteConfig.name,
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: `${siteConfig.name} - ${siteConfig.description}`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.name,
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
    { media: "(prefers-color-scheme: light)", color: "white" },
    { media: "(prefers-color-scheme: dark)", color: "black" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

// Critical CSS inlined for production build
// This prevents build-time file reading issues in Vercel
const criticalCSS = `
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --font-sans: 'Inter', sans-serif;
}
.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
}
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
body {
  margin: 0;
  padding: 0;
  font-family: var(--font-sans), system-ui, -apple-system, sans-serif;
  background-color: hsl(var(--background));
  color: hsl(var(--foreground));
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.min-h-screen { min-height: 100vh; }
.flex { display: flex; }
.flex-col { flex-direction: column; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.w-full { width: 100%; }
.h-full { height: 100%; }
.m-2 { margin: 0.5rem; }
.p-4 { padding: 1rem; }
.text-base { font-size: 1rem; line-height: 1.5; }
.font-sans { font-family: var(--font-sans), system-ui, -apple-system, sans-serif; }
.animate-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.rounded-md { border-radius: 0.375rem; }
.bg-muted { background-color: hsl(var(--muted, 210 40% 96.1%)); }
@media (min-width: 1024px) {
  .lg\\:flex-row { flex-direction: row; }
  .lg\\:w-2\\/5 { width: 40%; }
  .lg\\:w-3\\/5 { width: 60%; }
}
`.replace(/\s+/g, " ").trim();

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
    <html lang="en" className={fontSans.variable} suppressHydrationWarning>
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
            <EnvironmentBanner />
            <DevelopmentBanner />
            <SiteHeader />
            {children}
            <SiteFooter />
            <ThemeSwitcher />
            <StructuredData />
            <EnhancedOrganizationSchema />
            <Toaster />
          </ThemeProvider>
        </NextAuthProvider>
      </body>
    </html>
  );
}
