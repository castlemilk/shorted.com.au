"use client";

import { useState } from "react";

interface UnsubscribeConfirmProps {
  token: string;
}

export default function UnsubscribeConfirm({ token }: UnsubscribeConfirmProps) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  if (!token) {
    return (
      <>
        <h1 className="text-2xl font-bold text-foreground">Unsubscribe</h1>
        <p className="mt-4 text-muted-foreground">
          This unsubscribe link is invalid or has expired. If you keep receiving emails, contact{" "}
          <a href="mailto:support@shorted.com.au" className="text-primary hover:underline">
            support@shorted.com.au
          </a>
          .
        </p>
      </>
    );
  }

  if (state === "done") {
    return (
      <>
        <h1 className="text-2xl font-bold text-foreground">{"You've been unsubscribed"}</h1>
        <p className="mt-4 text-muted-foreground">
          You won&apos;t receive any more newsletter emails from Shorted. You can resubscribe any
          time from the site.
        </p>
        <a href="/" className="mt-8 inline-block text-primary hover:underline">
          Return to Shorted →
        </a>
      </>
    );
  }

  if (state === "error") {
    return (
      <>
        <h1 className="text-2xl font-bold text-foreground">Something went wrong</h1>
        <p className="mt-4 text-muted-foreground">
          We couldn&apos;t process your unsubscribe request. Please try again or contact{" "}
          <a href="mailto:support@shorted.com.au" className="text-primary hover:underline">
            support@shorted.com.au
          </a>
          .
        </p>
      </>
    );
  }

  async function handleUnsubscribe() {
    setState("loading");
    try {
      const res = await fetch(
        `/api/unsubscribe?t=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      if (res.ok) {
        setState("done");
      } else {
        setState("error");
      }
    } catch {
      setState("error");
    }
  }

  return (
    <>
      <h1 className="text-2xl font-bold text-foreground">Unsubscribe</h1>
      <p className="mt-4 text-muted-foreground">
        Click the button below to unsubscribe from Shorted newsletters.
      </p>
      <button
        onClick={handleUnsubscribe}
        disabled={state === "loading"}
        className="mt-8 inline-flex items-center rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {state === "loading" ? "Unsubscribing…" : "Unsubscribe me"}
      </button>
    </>
  );
}
