import { type Metadata } from "next";
import { PricingContent } from "./pricing-content";

export const metadata: Metadata = {
  title: "Pricing — Shorted",
  description:
    "Upgrade to Shorted Premium for $4/mo. Get AI Chat, Market Pulse, alerts, and advanced dashboards.",
};

export default function PricingPage() {
  return <PricingContent />;
}
