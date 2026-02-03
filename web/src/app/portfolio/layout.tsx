import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";

export const metadata: Metadata = {
  title: "Portfolio Tracker | Monitor Short Interest in Your Holdings",
  description:
    "Track short selling activity across your ASX portfolio. Monitor short interest percentages, get alerts on position changes, and analyze bearish sentiment for your holdings.",
  keywords: [
    "ASX portfolio tracker",
    "short interest portfolio",
    "stock portfolio short positions",
    "bearish sentiment tracker",
    "portfolio short selling",
    "ASX holdings monitor",
  ],
  openGraph: {
    title: "Portfolio Tracker | Monitor Short Interest in Your Holdings",
    description:
      "Track short selling activity across your ASX portfolio with real-time ASIC data.",
    url: `${siteConfig.url}/portfolio`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "Portfolio Tracker | Monitor Short Interest in Your Holdings",
    description:
      "Track short selling activity across your ASX portfolio.",
  },
  alternates: {
    canonical: `${siteConfig.url}/portfolio`,
  },
};

export default function PortfolioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
