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
  keywords: [
    "ASX",
    "Australian Stock Exchange",
    "Australian Short Positions",
    "Share Market Short Positions",
    "shorted",
    "shorts",
    "bearish stocks on the ASX",
  ],
  description: "Discover the most shorted stocks on the ASX.",
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
    <html lang="en">
      <body
        className={cn(
          "min-h-screen bg-background font-sans antialiased",
          fontSans.variable,
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
