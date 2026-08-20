import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";

export const metadata: Metadata = {
  title: "Product Roadmap | Shorted Feature Development",
  description:
    "Explore the Shorted product roadmap, including completed free tools, Premium investor workflows, API Access, and planned monetisation features.",
  keywords: [
    "Shorted roadmap",
    "ASX short selling features",
    "product development",
    "upcoming features",
    "short position tools",
    "market analysis tools",
  ],
  openGraph: {
    title: "Product Roadmap | Shorted Feature Development",
    description:
      "Explore the Shorted product roadmap and see what features are coming next.",
    url: `${siteConfig.url}/roadmap`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "Product Roadmap | Shorted Feature Development",
    description:
      "Explore the Shorted product roadmap and see what features are coming next.",
  },
  alternates: {
    canonical: `${siteConfig.url}/roadmap`,
  },
};

export default function RoadmapLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
