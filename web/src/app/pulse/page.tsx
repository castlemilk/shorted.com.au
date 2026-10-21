import { type Metadata } from "next";
import { PulseContent } from "./pulse-content";

export const metadata: Metadata = {
  // No brand: the root layout's `%s | Shorted` template appends it.
  title: "Market Pulse",
  description: "Real-time market pulse and sentiment dashboard for ASX short positions.",
};

export default function PulsePage() {
  return <PulseContent />;
}
