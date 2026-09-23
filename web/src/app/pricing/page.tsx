import { type Metadata } from "next";
import { PricingContent } from "./pricing-content";
import { planPricePerMonth } from "~/@/config/pricing";

export const metadata: Metadata = {
  title: "Pricing — Shorted",
  description:
    `Upgrade to Shorted Premium for ${planPricePerMonth("premium")}. Get AI Chat, Market Pulse, alerts, and advanced dashboards.`,
};

export default function PricingPage() {
  return <PricingContent />;
}
