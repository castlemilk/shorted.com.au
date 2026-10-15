import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";
import { PricingContent } from "./pricing-content";
import { planPricePerMonth } from "~/@/config/pricing";

export const metadata: Metadata = {
  // The root template appends " | Shorted".
  title: "Pricing",
  description:
    `Upgrade to Shorted Premium for ${planPricePerMonth("premium")}. Get AI Chat, Market Pulse, alerts, and advanced dashboards.`,
  alternates: { canonical: `${siteConfig.url}/pricing` },
};

export default function PricingPage() {
  return <PricingContent />;
}
