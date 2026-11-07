/**
 * Market moves as the site draws them: plain, serializable objects mapped from
 * MarketService.ListMarketMoves (proto/shortedapi/shorts/v1alpha1/market.proto).
 *
 * The rules the mapping holds:
 *   - a figure the poster did not give is null, never 0 (the API sends it with
 *     has_* false and the number 0);
 *   - a move this site cannot draw faithfully (an unknown kind or direction, no
 *     headline, an observation time that does not parse) is left out, never
 *     guessed into a shape it was not posted as;
 *   - a source is kept only when it is an absolute http(s) link.
 *
 * No protobuf import here beyond types: this module is read by server
 * components and their tests, and must never pull the generated runtime into a
 * client bundle.
 */

import type { MarketMove } from "~/gen/shorts/v1alpha1/market_pb";
import { safeExternalHref } from "~/@/lib/safe-external-href";

export const MARKET_MOVE_KINDS = [
  "stock",
  "index",
  "sector",
  "market",
] as const;
export type MarketMoveKind = (typeof MARKET_MOVE_KINDS)[number];

export const MARKET_MOVE_DIRECTIONS = ["up", "down", "flat", "mixed"] as const;
export type MarketMoveDirection = (typeof MARKET_MOVE_DIRECTIONS)[number];

export interface MarketMoveSourceView {
  title: string;
  url: string;
  publisher: string | null;
}

export interface MarketMoveView {
  /** The poster's key; the card's anchor is `move-<moveKey>`. */
  moveKey: string;
  kind: MarketMoveKind;
  stockCode: string | null;
  companyName: string | null;
  indexCode: string | null;
  sector: string | null;
  relatedCodes: string[];
  direction: MarketMoveDirection;
  /** Percent; -3.2 is a 3.2% fall. null when the poster gave none. */
  changePct: number | null;
  /** The price, or the index level, at observedAt. */
  price: number | null;
  /** Volume against its usual level (2.5 = two and a half times). */
  volumeRatio: number | null;
  headline: string;
  summary: string;
  sources: MarketMoveSourceView[];
  tags: string[];
  /** 1 (minor) to 5 (a market-wide event). */
  significance: number;
  /** RFC 3339: when the poster observed the move. */
  observedAt: string;
  /** YYYY-MM-DD, the Sydney calendar date of observedAt. */
  marketDate: string;
  revision: number;
  publishedAt: string;
  updatedAt: string;
  /** The model that wrote the move, when the poster named it. */
  model: string | null;
}

/** The MarketMove fields the mapping reads (the generated message satisfies it). */
export type MarketMoveLike = Pick<
  MarketMove,
  | "moveKey"
  | "kind"
  | "stockCode"
  | "companyName"
  | "indexCode"
  | "sector"
  | "relatedCodes"
  | "direction"
  | "changePct"
  | "hasChangePct"
  | "price"
  | "hasPrice"
  | "volumeRatio"
  | "hasVolumeRatio"
  | "headline"
  | "summary"
  | "tags"
  | "significance"
  | "observedAt"
  | "marketDate"
  | "revision"
  | "publishedAt"
  | "updatedAt"
  | "model"
> & {
  sources: ReadonlyArray<{ title: string; url: string; publisher: string }>;
};

const CODE = /^[A-Z0-9]{2,6}$/;
const MARKET_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** A figure when it was given and is a real number; null otherwise. */
function figure(
  has: boolean | undefined,
  value: number | undefined,
): number | null {
  return has === true && typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}

function isKind(value: string): value is MarketMoveKind {
  return (MARKET_MOVE_KINDS as readonly string[]).includes(value);
}

function isDirection(value: string): value is MarketMoveDirection {
  return (MARKET_MOVE_DIRECTIONS as readonly string[]).includes(value);
}

/** One move to its plain view, or null when it cannot be drawn faithfully. */
export function toMarketMoveView(move: MarketMoveLike): MarketMoveView | null {
  const kind = move.kind?.trim() ?? "";
  const direction = move.direction?.trim() ?? "";
  const headline = text(move.headline);
  const observedAt = text(move.observedAt);
  const moveKey = text(move.moveKey);
  if (!moveKey || !headline || !observedAt) return null;
  if (!isKind(kind) || !isDirection(direction)) return null;
  if (Number.isNaN(new Date(observedAt).getTime())) return null;

  const stockCode = text(move.stockCode)?.toUpperCase() ?? null;
  if (kind === "stock" && (!stockCode || !CODE.test(stockCode))) return null;

  const sources: MarketMoveSourceView[] = [];
  for (const source of move.sources ?? []) {
    const url = safeExternalHref(source.url);
    const title = text(source.title);
    if (!url || !title) continue;
    sources.push({ title, url, publisher: text(source.publisher) });
  }

  const relatedCodes = (move.relatedCodes ?? [])
    .map((code) => code.trim().toUpperCase())
    .filter((code) => CODE.test(code) && code !== stockCode);

  const significance =
    Number.isInteger(move.significance) &&
    move.significance >= 1 &&
    move.significance <= 5
      ? move.significance
      : 3;

  const marketDate = text(move.marketDate);

  return {
    moveKey,
    kind,
    stockCode: kind === "stock" ? stockCode : null,
    companyName: kind === "stock" ? text(move.companyName) : null,
    indexCode:
      kind === "index" ? (text(move.indexCode)?.toUpperCase() ?? null) : null,
    sector: kind === "sector" ? text(move.sector) : null,
    relatedCodes: Array.from(new Set(relatedCodes)),
    direction,
    changePct: figure(move.hasChangePct, move.changePct),
    price: figure(move.hasPrice, move.price),
    volumeRatio: figure(move.hasVolumeRatio, move.volumeRatio),
    headline,
    summary: move.summary?.trim() ?? "",
    sources,
    tags: (move.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    significance,
    observedAt,
    marketDate:
      marketDate && MARKET_DATE.test(marketDate)
        ? marketDate
        : sydneyDate(observedAt),
    revision: move.revision > 0 ? move.revision : 1,
    publishedAt: text(move.publishedAt) ?? observedAt,
    updatedAt: text(move.updatedAt) ?? observedAt,
    model: text(move.model),
  };
}

/** Every drawable move, in the order the API served them. */
export function toMarketMoveViews(
  moves: ReadonlyArray<MarketMoveLike>,
): MarketMoveView[] {
  const out: MarketMoveView[] = [];
  for (const move of moves) {
    const view = toMarketMoveView(move);
    if (view) out.push(view);
  }
  return out;
}

/** The Sydney calendar date of an instant, YYYY-MM-DD. */
export function sydneyDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Moves grouped by Sydney market date, newest date first, each group in feed order. */
export function groupMarketMovesByDate(
  moves: ReadonlyArray<MarketMoveView>,
): Array<{ marketDate: string; moves: MarketMoveView[] }> {
  const groups = new Map<string, MarketMoveView[]>();
  for (const move of moves) {
    const group = groups.get(move.marketDate);
    if (group) group.push(move);
    else groups.set(move.marketDate, [move]);
  }
  return Array.from(groups, ([marketDate, items]) => ({
    marketDate,
    moves: items,
  })).sort((a, b) =>
    a.marketDate < b.marketDate ? 1 : a.marketDate > b.marketDate ? -1 : 0,
  );
}
