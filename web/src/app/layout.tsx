import "~/styles/globals.css";
import "prismjs/themes/prism-tomorrow.css"; // Import the Prism CSS theme

import { Inter as FontSans } from "next/font/google";

import { cn } from "../@/lib/utils";
import { type Viewport } from "next";
import { ThemeProvider } from "~/@/components/providers";
import { ThemeSwitcher } from "~/@/components/theme-switcher";
import SiteHeader from "~/@/components/ui/site-header";
import SiteFooter from "~/@/components/ui/site-footer";
import { NextAuthProvider } from "./next-auth-provider";
import { siteConfig } from "~/@/config/site";
import { StructuredData } from "~/@/components/seo/structured-data";
import { Toaster } from "~/@/components/ui/toaster";
import {
  EnvironmentBanner,
  DevelopmentBanner,
} from "~/@/components/ui/environment-banner";

const fontSans = FontSans({
  subsets: ["latin"],
  variable: "--font-sans",
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={fontSans.variable} suppressHydrationWarning>
      <body className={cn("min-h-screen bg-background font-sans antialiased")}>
        <NextAuthProvider>
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
            <Toaster />
          </ThemeProvider>
        </NextAuthProvider>
      </body>
    </html>
  );
}
