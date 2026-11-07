/**
 * The words and numbers a market move is drawn with. Pure functions, shared by
 * every market-moves surface so the feed, the homepage strip and the stock card
 * print one move the same way.
 */

import type { MarketMoveDirection, MarketMoveView } from "./view";

/** U+2212, the sign of a fall (DESIGN.md, the Tabular Rule). */
export const MINUS = "−";

/**
 * A signed percent to two decimals: "+4.20%", "−3.10%", "0.00%". Rounded
 * first, so a figure that rounds to zero carries no sign.
 */
export function formatMoveChange(changePct: number): string {
  const rounded = Math.round(changePct * 100) / 100;
  if (rounded === 0) return "0.00%";
  const magnitude = Math.abs(rounded).toFixed(2);
  return rounded > 0 ? `+${magnitude}%` : `${MINUS}${magnitude}%`;
}

/**
 * The tone a move's change is coloured by: the direction the poster gave
 * (the API refuses a direction that contradicts its own figure). A price rise
 * is green and a fall red, as the price chart marks them; flat and mixed are
 * the foreground.
 */
export const MOVE_TONE: Record<MarketMoveDirection, string> = {
  up: "text-green-700 dark:text-green-400",
  down: "text-red-600 dark:text-red-400",
  flat: "text-foreground",
  mixed: "text-foreground",
};

/** The card's left stripe, quieter than the figure it accompanies. */
export const MOVE_STRIPE: Record<MarketMoveDirection, string> = {
  up: "border-l-green-600/60",
  down: "border-l-red-600/60",
  flat: "border-l-border",
  mixed: "border-l-border",
};

/** The word a direction without a figure is shown as. */
export const DIRECTION_WORD: Record<MarketMoveDirection, string> = {
  up: "Up",
  down: "Down",
  flat: "Flat",
  mixed: "Mixed",
};

/**
 * The price at observation: a stock's in dollars (three decimals under $1, as
 * ASX prices a penny stock), an index level as a plain number.
 */
export function formatMovePrice(
  move: Pick<MarketMoveView, "kind" | "price">,
): string | null {
  if (move.price == null) return null;
  if (move.kind === "stock") {
    const digits = move.price < 1 ? 3 : 2;
    return `$${move.price.toLocaleString("en-AU", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }
  return move.price.toLocaleString("en-AU", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** "2.1× usual volume", or null without a figure. */
export function formatVolumeRatio(volumeRatio: number | null): string | null {
  if (volumeRatio == null) return null;
  return `${volumeRatio.toLocaleString("en-AU", { maximumFractionDigits: 1 })}× usual volume`;
}

/** Index codes with a name the reader knows them by. Anything else prints as its code. */
const INDEX_NAMES: Record<string, string> = {
  XJO: "S&P/ASX 200",
  XAO: "All Ordinaries",
  XKO: "S&P/ASX 300",
  XJT: "S&P/ASX 200 Accumulation",
  XSO: "S&P/ASX Small Ordinaries",
  XTL: "S&P/ASX 20",
  XFL: "S&P/ASX 50",
};

export function indexName(code: string): string | null {
  return INDEX_NAMES[code] ?? null;
}

/**
 * "Observed 2:05 pm AEDT, Sat 7 Nov": the observation time in Sydney, with its
 * own zone name, so a reader never has to guess which clock it is.
 */
export function formatObservedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const period = get("dayPeriod").toLowerCase();
  return `Observed ${get("hour")}:${get("minute")} ${period} ${get("timeZoneName")}, ${get("weekday")} ${get("day")} ${get("month")}`;
}

/** "Saturday 7 November 2026" for a YYYY-MM-DD Sydney date. */
export function formatMarketDate(marketDate: string): string {
  const date = new Date(`${marketDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return marketDate;
  return date.toLocaleDateString("en-AU", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** The disclosure every move carries. */
export function aiDisclosure(model: string | null): string {
  return model
    ? `Written by an AI market-moves workflow (${model})`
    : "Written by an AI market-moves workflow";
}
