import { type Metadata } from "next";
import { AlertsContent } from "./alerts-content";

export const metadata: Metadata = {
  title: "Alerts — Shorted",
  description: "Set price and short position alerts for ASX stocks.",
};

export default function AlertsPage() {
  return <AlertsContent />;
}
