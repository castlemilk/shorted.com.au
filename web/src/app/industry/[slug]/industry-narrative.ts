/**
 * Templated, server-rendered narrative prose for /industry/[slug].
 *
 * Every number here comes from data the page has already fetched
 * (`getIndustryStocks`) — this module performs no I/O, holds no state and
 * emits zero client JavaScript. Sentences whose inputs are missing or empty
 * are omitted entirely rather than rendered as `NaN`/`0.00%` artefacts, so a
 * degraded API response produces a shorter paragraph, never a broken one.
 */

export interface NarrativeStock {
  code: string;
  name: string;
  shortPercent: number;
  change?: number;
}

export interface NarrativeIndustry {
  name: string;
  stockCount: number;
  avgShortPercent: number;
  topStock: {
    code: string;
    name: string;
    shortPercent: number;
  } | null;
}

/** A run of prose, or a stock code that the page renders as an internal link. */
export type NarrativeSegment =
  | { kind: "text"; text: string }
  | { kind: "stock"; code: string };

export interface IndustryNarrative {
  /** Ordered segments forming a single paragraph. */
  segments: NarrativeSegment[];
  /** Plain-text rendering, for metadata/structured data reuse. */
  plainText: string;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-AU");
}

const SMALL_NUMBERS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/** Spell out small numbers so a sentence never opens with a bare numeral. */
function formatSpelledCount(value: number): string {
  return SMALL_NUMBERS[value] ?? formatCount(value);
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Australian-style list join: "A", "A and B", "A, B and C" (no serial comma).
 * Works on segment arrays so stock codes stay linkable.
 */
function joinSegments(items: NarrativeSegment[][]): NarrativeSegment[] {
  const out: NarrativeSegment[] = [];
  items.forEach((item, index) => {
    if (index > 0) {
      out.push({
        kind: "text",
        text: index === items.length - 1 ? " and " : ", ",
      });
    }
    out.push(...item);
  });
  return out;
}

/**
 * "Other" is the bucket for ASIC classifications we could not map, so reading
 * it as a sector name ("other stocks") is misleading. Everything else reads
 * naturally in lower case, matching the rest of the page copy.
 */
function sectorLabel(name: string): string {
  const trimmed = name.trim();
  // Empty classification: "the only listed stock on the ASX" still reads
  // correctly, where an "ASX" label would duplicate the exchange name.
  if (!trimmed) return "listed";
  if (trimmed.toLowerCase() === "other") return "unclassified";
  return trimmed.toLowerCase();
}

function pluralStocks(count: number): string {
  return count === 1 ? "stock" : "stocks";
}

function median(sortedDesc: number[]): number | null {
  if (sortedDesc.length === 0) return null;
  const values = [...sortedDesc].sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[mid]!;
  return (values[mid - 1]! + values[mid]!) / 2;
}

export function buildIndustryNarrative({
  industry,
  stocks,
}: {
  industry: NarrativeIndustry;
  stocks: NarrativeStock[];
}): IndustryNarrative | null {
  const sector = sectorLabel(industry.name);
  const reported = stocks
    .filter((s) => s.code && Number.isFinite(s.shortPercent) && s.shortPercent > 0)
    .sort((a, b) => b.shortPercent - a.shortPercent);

  const totalTracked =
    Number.isFinite(industry.stockCount) && industry.stockCount > 0
      ? industry.stockCount
      : stocks.length;

  // Nothing meaningful to say without at least one tracked stock.
  if (totalTracked === 0) return null;

  const segments: NarrativeSegment[] = [];
  const push = (text: string) => segments.push({ kind: "text", text });

  // No disclosed positions at all — say so plainly instead of printing zeros.
  if (reported.length === 0) {
    push(
      `Shorted tracks ${formatSpelledCount(totalTracked)} ${sector} ${pluralStocks(totalTracked)} on the ASX, none of which currently carries a short position above ASIC's reporting threshold. `,
    );
    push(
      "Short positions are disclosed daily by ASIC with a four trading day delay, so a new position appears here once it is reported.",
    );
    return finalise(segments);
  }

  const top = reported[0]!;
  const n = reported.length;

  if (n === 1) {
    // Single-stock sector: one combined sentence keeps the grammar honest,
    // and the plural "positions in A, B and C" opener is skipped entirely.
    segments.push({ kind: "stock", code: top.code });
    push(
      ` is the only ${sector} stock on the ASX with a disclosed short position, at ${formatPercent(top.shortPercent)} of shares on issue. `,
    );
  } else {
    const leaders = reported.slice(0, Math.min(3, n));
    push(
      `The largest disclosed short positions among ${sector} stocks on the ASX are in `,
    );
    segments.push(
      ...joinSegments(leaders.map((s) => [{ kind: "stock" as const, code: s.code }])),
    );
    push(". ");

    segments.push({ kind: "stock", code: top.code });
    push(
      ` is the most heavily shorted stock in the sector at ${formatPercent(top.shortPercent)} of shares on issue`,
    );
    const ratio =
      industry.avgShortPercent > 0 ? top.shortPercent / industry.avgShortPercent : null;
    if (ratio !== null && Number.isFinite(ratio) && ratio >= 1.5) {
      push(`, roughly ${ratio.toFixed(1)}× the sector average`);
    }
    push(". ");
  }

  // Sector-wide averages. Omitted when the average is not a usable number.
  if (n >= 2 && industry.avgShortPercent > 0) {
    const med = median(reported.map((s) => s.shortPercent));
    const scope =
      n === 2
        ? `both ${sector} stocks with disclosed short positions`
        : `the ${formatSpelledCount(n)} ${sector} ${pluralStocks(n)} with disclosed short positions`;
    push(`Across ${scope}, short interest averages ${formatPercent(industry.avgShortPercent)}`);
    if (n >= 3 && med !== null && med > 0) {
      push(`, with a median of ${formatPercent(med)}`);
    }
    push(". ");
  }

  // Concentration. Only stated when at least one stock clears the threshold.
  if (n >= 2) {
    const above10 = reported.filter((s) => s.shortPercent > 10).length;
    const above20 = reported.filter((s) => s.shortPercent > 20).length;
    if (above10 > 0) {
      push(
        `${sentenceCase(formatSpelledCount(above10))} ${pluralStocks(above10)} ${above10 === 1 ? "is" : "are"} shorted above 10% of shares on issue`,
      );
      if (above20 > 0) {
        push(`, and ${formatSpelledCount(above20)} above 20%`);
      }
      push(". ");
    }
  }

  // Direction of travel. The treemap feed does not always carry a change
  // figure; when every value is zero this sentence disappears rather than
  // claiming nothing moved.
  const rising = reported.filter((s) => (s.change ?? 0) > 0).length;
  const falling = reported.filter((s) => (s.change ?? 0) < 0).length;
  if (rising > 0 || falling > 0) {
    if (rising > 0 && falling > 0) {
      push(
        `Over the past three months short interest has risen in ${formatSpelledCount(rising)} ${pluralStocks(rising)} and eased in ${formatSpelledCount(falling)}. `,
      );
    } else if (rising > 0) {
      push(
        `Short interest has risen in ${formatSpelledCount(rising)} ${pluralStocks(rising)} over the past three months. `,
      );
    } else {
      push(
        `Short interest has eased in ${formatSpelledCount(falling)} ${pluralStocks(falling)} over the past three months. `,
      );
    }
  }

  push(
    "Figures come from ASIC's daily short position report, published with a four trading day delay.",
  );

  return finalise(segments);
}

function finalise(segments: NarrativeSegment[]): IndustryNarrative {
  // Merge adjacent text runs so the rendered markup stays tidy.
  const merged: NarrativeSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (seg.kind === "text" && last && last.kind === "text") {
      last.text += seg.text;
    } else {
      merged.push(seg.kind === "text" ? { ...seg } : seg);
    }
  }

  const plainText = merged
    .map((s) => (s.kind === "text" ? s.text : s.code))
    .join("")
    .replace(/\s+/g, " ")
    .trim();

  return { segments: merged, plainText };
}
