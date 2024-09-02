import "~/styles/globals.css";

import { Inter as FontSans } from "next/font/google";

import { cn } from "../@/lib/utils";
import { type Viewport } from "next";
import { ThemeProvider } from "~/@/components/providers";
import { ThemeSwitcher } from "~/@/components/theme-switcher";
import SiteHeader from "~/@/components/ui/site-header";
import SiteFooter from "~/@/components/ui/site-footer";

const fontSans = FontSans({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata = {
  title: "Shorted",
  description: "Discover the most shorted stocks on the ASX.",
  keywords: [
    "ASX",
    "Australian Stock Exchange",
    "Australian Short Positions",
    "Share Market Short Positions",
    "shorted",
    "shorts",
    "bearish stocks on the ASX",
    "bear market",
    "bearish stocks",
    "bearish",
    "shorting stocks",
    "short stocks",
    "short positions",
    "short interest",
  ],
  openGraph: {
    title: "Shorted",
    description: "Discover the most shorted stocks on the ASX.",
    url: "https://shorted.com.au",
    siteName: "Shorted",
    images: [
      {
        url: "https://shorted.com.au/logo.png", // Replace with your actual image URL
        width: 1200,
        height: 630,
      },
    ],
    locale: "en_AU",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Shorted",
    description: "Discover the most shorted stocks on the ASX.",
    images: ["https://shorted.com.au/logo.png"], // Replace with your actual image URL
  },
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "white" },
    { media: "(prefers-color-scheme: dark)", color: "black" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={fontSans.variable}>
      <body
        className={cn(
          "min-h-screen bg-background font-sans antialiased"
        )}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <SiteHeader />
          {/* <NextAuthProvider> */}
          {children}
          {/* </NextAuthProvider> */}
          <SiteFooter />
          <ThemeSwitcher />
        </ThemeProvider>
      </body>
    </html>
  );
}
