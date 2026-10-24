"use client";

import Link from "next/link";
import { useState } from "react";

import {
  pauseAlertByToken,
  type PauseAlertByTokenResult,
} from "~/app/actions/alert-unsubscribe";
import { buildMonitorSummary } from "~/app/alerts/alert-model";

type ViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "paused"; summary: string }
  | { kind: "already-paused"; summary: string }
  | { kind: "invalid" }
  | { kind: "gone" }
  | { kind: "error" };

const SUPPORT_EMAIL = "support@shorted.com.au";

/**
 * Asks before it pauses. The button calls the server action directly (a POST
 * under the hood), so the page can say what happened: paused, already paused,
 * or an invalid link. Rendering never calls it.
 */
export function AlertUnsubscribeConfirm({ token }: { token: string }) {
  const [state, setState] = useState<ViewState>(
    token ? { kind: "idle" } : { kind: "invalid" },
  );

  async function handlePause() {
    setState({ kind: "loading" });
    let result: PauseAlertByTokenResult;
    try {
      result = await pauseAlertByToken(token);
    } catch {
      setState({ kind: "error" });
      return;
    }

    if (!result.ok) {
      setState(
        result.reason === "invalid"
          ? { kind: "invalid" }
          : result.reason === "gone"
            ? { kind: "gone" }
            : { kind: "error" },
      );
      return;
    }

    const summary = buildMonitorSummary({
      target: result.monitor.target,
      scope: result.monitor.scope,
      condition: result.monitor.condition,
      threshold: result.monitor.threshold,
      cadence: result.monitor.cadence,
    });
    setState(
      result.alreadyPaused
        ? { kind: "already-paused", summary }
        : { kind: "paused", summary },
    );
  }

  switch (state.kind) {
    case "invalid":
      return (
        <>
          <h1 className="text-2xl font-bold text-foreground">
            This link is not valid
          </h1>
          <p className="mt-4 text-muted-foreground">
            This pause link is invalid or has expired. You can manage every
            alert at{" "}
            <Link href="/alerts" className="text-primary hover:underline">
              /alerts
            </Link>
            . If you keep receiving alert emails, contact{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-primary hover:underline"
            >
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </>
      );

    case "paused":
      return (
        <>
          <h1 className="text-2xl font-bold text-foreground">Alert paused</h1>
          <p className="mt-4 text-muted-foreground">
            {state.summary}. You can resume it any time at{" "}
            <Link href="/alerts" className="text-primary hover:underline">
              /alerts
            </Link>
            .
          </p>
        </>
      );

    case "already-paused":
      return (
        <>
          <h1 className="text-2xl font-bold text-foreground">
            This alert was already paused.
          </h1>
          <p className="mt-4 text-muted-foreground">
            {state.summary}. Nothing changed. You can resume it any time at{" "}
            <Link href="/alerts" className="text-primary hover:underline">
              /alerts
            </Link>
            .
          </p>
        </>
      );

    case "gone":
      return (
        <>
          <h1 className="text-2xl font-bold text-foreground">
            That alert no longer exists
          </h1>
          <p className="mt-4 text-muted-foreground">
            Nothing more to do. It was deleted, so no more emails will be sent
            for it. You can manage your other alerts at{" "}
            <Link href="/alerts" className="text-primary hover:underline">
              /alerts
            </Link>
            .
          </p>
        </>
      );

    case "error":
      return (
        <>
          <h1 className="text-2xl font-bold text-foreground">
            Something went wrong
          </h1>
          <p className="mt-4 text-muted-foreground">
            We could not pause this alert. Try again, or manage it at{" "}
            <Link href="/alerts" className="text-primary hover:underline">
              /alerts
            </Link>
            . If it keeps failing, contact{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-primary hover:underline"
            >
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
          <button
            type="button"
            onClick={handlePause}
            className="mt-8 inline-flex items-center rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
        </>
      );

    case "idle":
    case "loading":
      return (
        <>
          <h1 className="text-2xl font-bold text-foreground">
            Pause this alert?
          </h1>
          <p className="mt-4 text-muted-foreground">
            The alert stays paused, and no more emails are sent for it, until
            you resume it at{" "}
            <Link href="/alerts" className="text-primary hover:underline">
              /alerts
            </Link>
            .
          </p>
          <button
            type="button"
            onClick={handlePause}
            disabled={state.kind === "loading"}
            className="mt-8 inline-flex items-center rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {state.kind === "loading" ? "Pausing…" : "Pause this alert"}
          </button>
        </>
      );
  }
}
