"use client";

import { useState } from "react";
import { DatabaseZap, Loader2, CheckCircle2, XCircle } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface CacheTarget {
  target: string;
  path: string;
  label: string;
  description: string;
}

// Mirrors the TARGETS map in /api/admin/flush-cache/route.ts.
const TARGETS: CacheTarget[] = [
  {
    target: "housing",
    path: "/housing",
    label: "Housing overview",
    description:
      "Clears cache:housing:overview:* and revalidates /housing. Use if the tracker shows its empty 'data is loading' state.",
  },
  {
    target: "shorts",
    path: "/",
    label: "Shorts data",
    description:
      "Flushes every shorts-derived cache prefix (homepage, top, tooltips, about) and revalidates the homepage.",
  },
];

type Status =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "ok"; message: string }
  | { state: "error"; message: string };

/**
 * Admin cache-flush panel. Posts to the admin-gated /api/admin/flush-cache
 * endpoint (ADMIN_EMAILS allowlist), so a poisoned/stale Redis entry can be
 * cleared with a click instead of raw prod Redis access.
 */
export function CachePanel() {
  const [status, setStatus] = useState<Record<string, Status>>({});

  async function flush(t: CacheTarget) {
    setStatus((s) => ({ ...s, [t.target]: { state: "busy" } }));
    try {
      const res = await fetch("/api/admin/flush-cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: t.target, path: t.path }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        flushedKeys?: number;
        revalidated?: string | null;
        error?: string;
      };
      if (!res.ok) {
        setStatus((s) => ({
          ...s,
          [t.target]: {
            state: "error",
            message: body.error ?? `HTTP ${res.status}`,
          },
        }));
        return;
      }
      setStatus((s) => ({
        ...s,
        [t.target]: {
          state: "ok",
          message: `Flushed ${body.flushedKeys ?? 0} key${
            body.flushedKeys === 1 ? "" : "s"
          }${body.revalidated ? ` · revalidated ${body.revalidated}` : ""}`,
        },
      }));
    } catch (err) {
      setStatus((s) => ({
        ...s,
        [t.target]: {
          state: "error",
          message: err instanceof Error ? err.message : "Request failed",
        },
      }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseZap className="h-5 w-5" />
          Cache &amp; revalidation
        </CardTitle>
        <CardDescription>
          Flush a Redis cache target and revalidate its route. Admin-only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {TARGETS.map((t) => {
          const st = status[t.target] ?? { state: "idle" };
          return (
            <div
              key={t.target}
              className="flex items-center justify-between gap-4 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">{t.label}</div>
                <div className="text-xs text-muted-foreground">
                  {t.description}
                </div>
                {st.state === "ok" && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" /> {st.message}
                  </div>
                )}
                {st.state === "error" && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                    <XCircle className="h-3 w-3" /> {st.message}
                  </div>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={st.state === "busy"}
                onClick={() => flush(t)}
                className="shrink-0"
              >
                {st.state === "busy" ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Flushing…
                  </>
                ) : (
                  "Flush"
                )}
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
