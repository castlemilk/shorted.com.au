import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";

export const metadata: Metadata = {
  title: "Custom Dashboards | Build Your Short Position View",
  description:
    "Create personalized dashboards to track ASX short positions. Add widgets for top shorts, industry treemaps, watchlists, and more. Save and customize your market view.",
  keywords: [
    "ASX dashboard",
    "short position dashboard",
    "custom stock dashboard",
    "short selling widgets",
    "ASX market view",
    "personalized stock tracker",
    "short interest dashboard",
  ],
  openGraph: {
    title: "Custom Dashboards | Build Your Short Position View",
    description:
      "Create personalized dashboards to track ASX short positions with customizable widgets.",
    url: `${siteConfig.url}/dashboards`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "Custom Dashboards | Build Your Short Position View",
    description:
      "Create personalized dashboards to track ASX short positions.",
  },
  alternates: {
    canonical: `${siteConfig.url}/dashboards`,
  },
};

export default function DashboardsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
