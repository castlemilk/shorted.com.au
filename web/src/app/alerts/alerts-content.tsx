"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowUpRight,
  Building2,
  Clock3,
  Files,
  MessageSquare,
  Plus,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { PremiumGate } from "~/@/components/premium/premium-gate";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { cn } from "~/@/lib/utils";
import { pageTitle } from "~/@/lib/typography";
import { createAlertMonitor } from "~/app/actions/alerts";

type AlertScope = "industry" | "stock";
type AlertCadence = "Daily" | "Weekly";
type AlertCondition =
  | "short-interest-above"
  | "short-interest-rises"
  | "new-top-ten-entry";

type AlertDraft = {
  id?: string;
  scope: AlertScope;
  target: string;
  condition: AlertCondition;
  threshold: string;
  cadence: AlertCadence;
};

const conditionCopy: Record<AlertCondition, { label: string; helper: string }> =
  {
    "short-interest-above": {
      label: "Short interest above",
      helper: "Notify when reported short interest crosses the threshold.",
    },
    "short-interest-rises": {
      label: "Short interest rises by",
      helper:
        "Notify when the latest reported move is at least this many points.",
    },
    "new-top-ten-entry": {
      label: "New top-ten entry",
      helper: "Notify when a company enters this industry's ranked set.",
    },
  };

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function industryLabelFromSlug(slug?: string): string {
  return titleCase(slug ?? "") || "Materials";
}

function buildDraftSummary(draft: AlertDraft): string {
  const condition = conditionCopy[draft.condition].label.toLowerCase();
  const threshold =
    draft.condition === "new-top-ten-entry" ? "" : ` ${draft.threshold}%`;

  return `${draft.target} - ${condition}${threshold} - ${draft.cadence.toLowerCase()}`;
}

function AlertsPreview({ industry }: { industry: string }) {
  const examples = [
    {
      label: `${industry} daily movement`,
      detail: "Sector-level short-interest changes",
      icon: TrendingDown,
    },
    {
      label: "Top stock threshold",
      detail: "Company short interest crossing your selected level",
      icon: TrendingUp,
    },
    {
      label: "Inbox summary",
      detail: "Daily or weekly alert cadence",
      icon: MessageSquare,
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {examples.map((example) => (
        <div
          key={example.label}
          className="rounded-md border border-border/60 bg-card/75 p-4"
        >
          <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-md bg-muted">
            <example.icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="text-sm font-medium">{example.label}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            {example.detail}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AlertsWorkspace({
  initialIndustry,
}: {
  initialIndustry?: string;
}) {
  const defaultIndustry = industryLabelFromSlug(initialIndustry);
  const [scope, setScope] = useState<AlertScope>(
    initialIndustry ? "industry" : "stock",
  );
  const [industry, setIndustry] = useState(defaultIndustry);
  const [stockCode, setStockCode] = useState("");
  const [condition, setCondition] = useState<AlertCondition>(
    initialIndustry ? "new-top-ten-entry" : "short-interest-above",
  );
  const [threshold, setThreshold] = useState("5");
  const [cadence, setCadence] = useState<AlertCadence>("Daily");
  const [draft, setDraft] = useState<AlertDraft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const target =
    scope === "industry" ? industry.trim() : stockCode.trim().toUpperCase();
  const canCreate = target.length > 0;
  const summary = useMemo(
    () =>
      buildDraftSummary({
        scope,
        target:
          target || (scope === "industry" ? "Selected industry" : "Ticker"),
        condition,
        threshold,
        cadence,
      }),
    [cadence, condition, scope, target, threshold],
  );

  const handleSave = async () => {
    if (!canCreate || saving) return;

    setSaving(true);
    setSaveError(null);
    const result = await createAlertMonitor({
      scope,
      target,
      condition,
      threshold,
      cadence,
    });
    setSaving(false);

    if (!result.ok) {
      setSaveError(result.error);
      return;
    }

    setDraft({
      id: result.monitor.id,
      scope,
      target: result.monitor.target,
      condition,
      threshold:
        result.monitor.threshold === null
          ? threshold
          : String(result.monitor.threshold),
      cadence,
    });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="min-w-0 rounded-lg border border-border/60 bg-card/80 p-5 shadow-amber-sm">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
              Alert builder
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              Configure a monitor
            </h2>
          </div>
          <Badge
            variant="outline"
            className="border-primary/25 bg-primary/10 text-primary"
          >
            Premium
          </Badge>
        </div>

        <div className="grid gap-5">
          <div>
            <div className="mb-2 text-sm font-medium">Monitor type</div>
            <div className="grid gap-2 sm:grid-cols-2" role="group">
              <ScopeButton
                active={scope === "industry"}
                icon={<Building2 className="h-4 w-4" aria-hidden="true" />}
                label="Industry"
                detail="Track sector-level movement"
                onClick={() => {
                  setScope("industry");
                  if (condition === "short-interest-above") {
                    setCondition("new-top-ten-entry");
                  }
                }}
              />
              <ScopeButton
                active={scope === "stock"}
                icon={<Files className="h-4 w-4" aria-hidden="true" />}
                label="Stock"
                detail="Track one ASX code"
                onClick={() => {
                  setScope("stock");
                  if (condition === "new-top-ten-entry") {
                    setCondition("short-interest-above");
                  }
                }}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {scope === "industry" ? (
              <label className="block min-w-0">
                <span className="text-sm font-medium">Industry</span>
                <input
                  value={industry}
                  onChange={(event) => setIndustry(event.target.value)}
                  className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>
            ) : (
              <label className="block min-w-0">
                <span className="text-sm font-medium">ASX code</span>
                <input
                  value={stockCode}
                  onChange={(event) => setStockCode(event.target.value)}
                  placeholder="BHP"
                  className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-sm uppercase outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>
            )}

            <label className="block min-w-0">
              <span className="text-sm font-medium">Cadence</span>
              <select
                value={cadence}
                onChange={(event) =>
                  setCadence(event.target.value as AlertCadence)
                }
                className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                <option>Daily</option>
                <option>Weekly</option>
              </select>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
            <label className="block min-w-0">
              <span className="text-sm font-medium">Trigger</span>
              <select
                value={condition}
                onChange={(event) =>
                  setCondition(event.target.value as AlertCondition)
                }
                className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                <option value="short-interest-above">
                  Short interest above
                </option>
                <option value="short-interest-rises">
                  Short interest rises by
                </option>
                {scope === "industry" ? (
                  <option value="new-top-ten-entry">New top-ten entry</option>
                ) : null}
              </select>
              <span className="mt-2 block text-xs leading-5 text-muted-foreground">
                {conditionCopy[condition].helper}
              </span>
            </label>

            <label className="block min-w-0">
              <span className="text-sm font-medium">Threshold</span>
              <div className="mt-2 flex h-11 items-center rounded-md border border-border bg-background px-3 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
                <input
                  value={threshold}
                  onChange={(event) => setThreshold(event.target.value)}
                  inputMode="decimal"
                  disabled={condition === "new-top-ten-entry"}
                  className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none disabled:text-muted-foreground"
                />
                <span className="ml-2 text-xs text-muted-foreground">%</span>
              </div>
            </label>
          </div>

          <div className="rounded-md border border-border/60 bg-background/60 p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Alert summary</div>
                <div className="mt-1 break-words text-sm leading-6 text-muted-foreground">
                  {summary}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              type="button"
              disabled={!canCreate || saving}
              className="min-h-11"
              onClick={handleSave}
            >
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              {saving ? "Saving monitor" : "Save monitor"}
            </Button>
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/industry-intelligence" prefetch={false}>
                Open Industry Intelligence
              </Link>
            </Button>
          </div>

          {saveError ? (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {saveError}
            </div>
          ) : null}
        </div>
      </section>

      <aside className="min-w-0 rounded-lg border border-border/60 bg-card/80 p-5 shadow-amber-sm">
        <div className="mb-4 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary">
          <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
          Current monitor
        </div>

        {draft ? (
          <div className="space-y-4">
            <div className="rounded-md border border-primary/25 bg-primary/10 p-4">
              <div className="text-sm font-medium">
                {draft.scope === "industry" ? "Industry" : "Stock"} monitor
                saved
              </div>
              <div className="mt-2 break-words text-sm leading-6 text-muted-foreground">
                {buildDraftSummary(draft)}
              </div>
            </div>
            <Button
              asChild
              variant="outline"
              className="min-h-10 w-full justify-between"
            >
              <Link
                href={
                  draft.scope === "industry"
                    ? `/industry-intelligence?industry=${draft.target
                        .toLowerCase()
                        .replace(/\s+/g, "-")}`
                    : `/shorts/${draft.target}`
                }
                prefetch={false}
              >
                Review source data
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        ) : (
          <div className="rounded-md border border-border/60 bg-background/60 p-4 text-sm leading-6 text-muted-foreground">
            Choose an industry or ASX code, set the trigger, then save the
            monitor.
          </div>
        )}
      </aside>
    </div>
  );
}

function ScopeButton({
  active,
  icon,
  label,
  detail,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-h-[86px] rounded-md border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        active
          ? "border-primary/40 bg-primary/10"
          : "border-border/60 bg-background/60 hover:border-primary/25 hover:bg-muted/60",
      )}
    >
      <span className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block font-medium">{label}</span>
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
            {detail}
          </span>
        </span>
      </span>
    </button>
  );
}

export function AlertsContent({
  initialIndustry,
}: {
  initialIndustry?: string;
}) {
  const industry = industryLabelFromSlug(initialIndustry);

  return (
    <div className="container space-y-6 py-8">
      <section className="rounded-lg border border-border/60 bg-card/80 p-6 shadow-amber-sm">
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div className="max-w-3xl">
            <Badge
              variant="outline"
              className="mb-4 border-primary/25 bg-primary/10 text-primary"
            >
              Alerts
            </Badge>
            <h1 className={pageTitle}>
              Short-interest monitors
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground text-pretty md:text-base">
              Create industry or stock alerts for short-interest thresholds,
              ranked-set movement, and recurring market checks.
            </p>
          </div>
          <Button asChild variant="outline" className="min-h-10 shrink-0">
            <Link href="/industry-intelligence" prefetch={false}>
              Industry Intelligence
              <ArrowUpRight className="ml-2 h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </div>

        <div className="mt-6">
          <AlertsPreview industry={industry} />
        </div>
      </section>

      <PremiumGate
        feature="Alerts"
        fallback={<AlertsWorkspace initialIndustry={initialIndustry} />}
      >
        <AlertsWorkspace initialIndustry={initialIndustry} />
      </PremiumGate>
    </div>
  );
}
