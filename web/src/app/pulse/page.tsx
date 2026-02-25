import { type Metadata } from "next";
import { PulseContent } from "./pulse-content";

export const metadata: Metadata = {
  title: "Market Pulse — Shorted",
  description: "Real-time market pulse and sentiment dashboard for ASX short positions.",
};

export default function PulsePage() {
  return <PulseContent />;
}
