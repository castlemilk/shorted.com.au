// Alert view types and copy for /alerts. Pure on purpose: no React and no
// generated protobuf, so server actions, client components and tests can all
// import it. Protobuf enums are mapped to these strings in
// app/actions/alert-mapping.ts, on the server, before anything reaches a
// client bundle (compliance.tsx shows what a _pb import in a client module
// does to the static build).

export type AlertScope = "industry" | "stock";
export type AlertCondition =
  | "short-interest-above"
  | "short-interest-rises"
  | "new-top-ten-entry";
export type AlertCadence = "Daily" | "Weekly";
export type AlertStatus = "active" | "paused";

/** Delivery state of one alert event's email. `null` on the wire means unknown. */
export type AlertDeliveryState =
  | "pending"
  | "sent"
  | "failed"
  | "skipped-unentitled"
  | "skipped-no-email"
  | "skipped-paused";

export interface AlertMonitorSpec {
  scope: AlertScope;
  target: string;
  condition: AlertCondition;
  /** Percentage points for above and rises; null for top-ten entry. */
  threshold: number | null;
  cadence: AlertCadence;
}

export interface AlertMonitorView extends AlertMonitorSpec {
  id: string;
  status: AlertStatus;
  createdAt: string | null;
  /** YYYY-MM-DD of the newest event, or null when the monitor has never fired. */
  lastEventReportDate: string | null;
  lastDeliveryState: AlertDeliveryState | null;
  lastEventAt: string | null;
}

export interface AlertEventCompanyView {
  productCode: string;
  companyName: string;
  latestPercent: number;
  previousPercent: number | null;
  changePoints: number | null;
  /** 1-based rank in the industry's top ten at the report date; 0 means not ranked. */
  rank: number;
  /** Rank at the previous reading; 0 means not ranked. */
  previousRank: number;
}

export interface AlertEventView extends AlertMonitorSpec {
  id: string;
  monitorId: string;
  /** YYYY-MM-DD */
  reportDate: string;
  /** YYYY-MM-DD */
  comparedToDate: string;
  companies: AlertEventCompanyView[];
  companiesTotal: number;
  deliveryState: AlertDeliveryState | null;
  sentAt: string | null;
  createdAt: string | null;
}

/** TanStack Query keys shared by the builder (which invalidates) and the lists. */
export const ALERT_MONITORS_QUERY_KEY = ["alert-monitors"] as const;
export const ALERT_EVENTS_QUERY_KEY = ["alert-events"] as const;

export const conditionLabel: Record<AlertCondition, string> = {
  "short-interest-above": "Short interest above",
  "short-interest-rises": "Short interest rises by",
  "new-top-ten-entry": "New top-ten entry",
};

/**
 * The helper under the trigger. Industry scope evaluates every company in the
 * industry, so the copy says "any company"; the threshold is company-scale.
 */
export function conditionHelper(
  scope: AlertScope,
  condition: AlertCondition,
): string {
  switch (condition) {
    case "short-interest-above":
      return scope === "industry"
        ? "Notify when any company in this industry crosses the threshold."
        : "Notify when reported short interest crosses the threshold.";
    case "short-interest-rises":
      return scope === "industry"
        ? "Notify when any company in this industry's latest reported move is at least this many points."
        : "Notify when the latest reported move is at least this many points.";
    case "new-top-ten-entry":
      return "Notify when a company enters this industry's ten most-shorted companies.";
  }
}

/** The unit after the threshold box: points for rises, percent otherwise. */
export function thresholdUnit(condition: AlertCondition): "%" | "pts" {
  return condition === "short-interest-rises" ? "pts" : "%";
}

/** "5%" for above, "1 pts" for rises. The unit follows the condition, not the scope. */
export function formatThreshold(
  value: number | string,
  condition: AlertCondition,
): string {
  return thresholdUnit(condition) === "pts" ? `${value} pts` : `${value}%`;
}

/**
 * The one-line description of a monitor, e.g. "BHP - short interest above 5% -
 * daily". An industry monitor says "any company", because every company in the
 * industry is checked and the email lists each one that triggered:
 * "Materials - any company's short interest above 5% - daily". A string threshold
 * is printed as typed, so a half-typed builder value still reads back.
 *
 * The evaluator's email subject and summary mirror this wording
 * (services/jobs/internal/jobs/alerts/email.go, summaryLine); change both together.
 */
export function buildMonitorSummary(spec: {
  target: string;
  scope?: AlertScope;
  condition: AlertCondition;
  threshold: number | string | null;
  cadence: AlertCadence;
}): string {
  const threshold =
    spec.condition !== "new-top-ten-entry" && spec.threshold !== null
      ? ` ${formatThreshold(spec.threshold, spec.condition)}`
      : "";
  const cadence = spec.cadence.toLowerCase();
  if (spec.scope === "industry" && spec.condition !== "new-top-ten-entry") {
    const verb =
      spec.condition === "short-interest-above"
        ? "short interest above"
        : "short interest rises by";
    return `${spec.target} - any company's ${verb}${threshold} - ${cadence}`;
  }
  const label = conditionLabel[spec.condition].toLowerCase();
  return `${spec.target} - ${label}${threshold} - ${cadence}`;
}

const reportDateFormat = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "2026-10-16" -> "16 Oct 2026". Dates are calendar dates, so no timezone shift. */
export function formatReportDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return reportDateFormat.format(date);
}

/** Signed change to two places, e.g. "+0.40" or "-1.20". Never prints "-0.00". */
export function formatPoints(value: number): string {
  const rounded = Math.round(value * 100) / 100 + 0;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}`;
}

export function deliveryCopy(state: AlertDeliveryState | null): string {
  switch (state) {
    case "sent":
      return "Emailed";
    case "pending":
      return "Queued";
    case "failed":
      return "Delivery failed";
    case "skipped-unentitled":
      return "Not sent: Premium required";
    case "skipped-no-email":
      return "Not sent: no email on your account";
    case "skipped-paused":
      return "Not sent: paused";
    case null:
      return "Status unknown";
  }
}

/** "Last triggered: 16 Oct 2026 report — Emailed", or "Last triggered: Never". */
export function lastTriggeredCopy(
  monitor: Pick<AlertMonitorView, "lastEventReportDate" | "lastDeliveryState">,
): string {
  if (!monitor.lastEventReportDate) return "Last triggered: Never";
  return `Last triggered: ${formatReportDate(monitor.lastEventReportDate)} report — ${deliveryCopy(monitor.lastDeliveryState)}`;
}

/** One company's movement in an event, e.g. "4.80% → 5.20% (+0.40 pts)". */
export function movementCopy(company: AlertEventCompanyView): string {
  const latest = `${company.latestPercent.toFixed(2)}%`;
  if (company.previousPercent === null)
    return `${latest} (no previous reading)`;
  const previous = `${company.previousPercent.toFixed(2)}%`;
  const change =
    company.changePoints === null
      ? ""
      : ` (${formatPoints(company.changePoints)} pts)`;
  return `${previous} → ${latest}${change}`;
}

/** Top-ten rank movement, e.g. "Ranked #3 (was not ranked)". Null when unranked. */
export function rankCopy(company: AlertEventCompanyView): string | null {
  if (company.rank <= 0) return null;
  const was =
    company.previousRank > 0 ? `#${company.previousRank}` : "not ranked";
  return `Ranked #${company.rank} (was ${was})`;
}

/**
 * Why an alert's last email was not sent, for the monitor row. null when the last
 * delivery was sent, failed or pending, since those are not about the account. A
 * no-email skip stops mattering once the address is verified: the next alert is
 * emailed, so the row says nothing then.
 */
export function skippedDeliveryNotice(
  state: AlertDeliveryState | null,
  { verified }: { verified: boolean },
): { label: string; detail: string; needsVerification: boolean } | null {
  switch (state) {
    case "skipped-no-email":
      if (verified) return null;
      return {
        label: "Not emailed: verify your email",
        detail:
          "Alerts are emailed only to a verified address. Verify yours to get them by email.",
        needsVerification: true,
      };
    case "skipped-unentitled":
      return {
        label: "Not emailed: no active Premium",
        detail:
          "Alerts are recorded, but Premium is not active, so no email was sent.",
        needsVerification: false,
      };
    case "skipped-paused":
      return {
        label: "Not emailed: paused",
        detail: "The monitor was paused before its email was sent.",
        needsVerification: false,
      };
    default:
      return null;
  }
}
