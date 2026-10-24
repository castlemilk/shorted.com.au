import type { Metadata } from "next";
import { AlertUnsubscribeConfirm } from "./unsubscribe-confirm";

// A one-click pause link from an alert email. Account-free and single-purpose:
// nothing here indexes, and GET changes nothing. The pause happens only when the
// reader presses the button.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pause alert",
  robots: { index: false, follow: false },
};

export default function AlertUnsubscribePage({
  searchParams,
}: {
  searchParams: { t?: string | string[] };
}) {
  const raw = searchParams.t;
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? "";

  return (
    <main className="container mx-auto max-w-xl px-4 py-24 text-center">
      <AlertUnsubscribeConfirm token={token} />
    </main>
  );
}
