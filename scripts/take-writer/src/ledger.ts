// Citation ledger — the grounding spine of the investigative newsroom.
//
// Every source the investigation agent actually retrieves via a data
// tool is registered here and handed a stable refId. The writer may
// ONLY cite refIds that exist in the ledger; compactCitations() drops
// any marker the writer invents and renumbers the survivors into the
// contiguous ref-1..M sequence the frontend (LinkifiedNarrative +
// editorial_takes.citations) already understands.

import type { Citation } from "./narrative.js";

export type LedgerSourceType = "news" | "report" | "director";

export interface LedgerSource {
  type: LedgerSourceType;
  url: string;
  source: string;
  headline: string;
  date: string; // YYYY-MM-DD
}

export class CitationLedger {
  private byKey = new Map<string, string>();   // type:url -> refId
  private byRefId = new Map<string, LedgerSource>();
  private seq = 0;

  private key(s: LedgerSource): string {
    // Url-less sources (e.g. director trades with no announcement link)
    // must not all collapse to one key, or distinct trades share a refId
    // and get mis-attributed. Fall back to date+headline.
    return s.url ? `${s.type}:${s.url}` : `${s.type}:${s.date}:${s.headline}`;
  }

  /** Register a retrieved source; returns its stable refId. Idempotent on type+url. */
  register(s: LedgerSource): string {
    const k = this.key(s);
    const existing = this.byKey.get(k);
    if (existing) return existing;
    this.seq += 1;
    const refId = `ref-${this.seq}`;
    this.byKey.set(k, refId);
    this.byRefId.set(refId, s);
    return refId;
  }

  has(refId: string): boolean {
    return this.byRefId.has(refId);
  }

  get(refId: string): LedgerSource | undefined {
    return this.byRefId.get(refId);
  }

  size(): number {
    return this.byRefId.size;
  }
}

// Citation references come in two forms: bracketed prose markers [ref-N]
// (group 1) and MDX component props cite="ref-N" (groups 2+3: leading
// whitespace captured so a removed attribute doesn't leave a double space).
// Both forms participate equally in first-appearance ordering and remapping.
const MARKER_OR_PROP = /\[(ref-\d+|report-\d+)\]|(\s*)\bcite="(ref-\d+|report-\d+)"/g;

/**
 * Walk the body, drop any [ref-N] not in the ledger, and renumber the
 * cited-and-valid markers into contiguous ref-1..M in first-appearance
 * order. cite="ref-N" props on MDX components count as citations too:
 * they are remapped with the same old->new table, register their source
 * in the citations array, and — when dangling — have the cite attribute
 * removed (component kept) and the id recorded in dropped.
 * Returns the rewritten body, the ordered Citation[] for the
 * editorial_takes.citations column, and the dropped (dangling) marker ids.
 */
export function compactCitations(
  body: string,
  ledger: CitationLedger,
): { body: string; citations: Citation[]; dropped: string[] } {
  // Expand combined markers like "[ref-1, ref-2]" -> "[ref-1][ref-2]" so the
  // single-id matcher below catches every id (otherwise combined markers
  // bypass renumber+validation and leak with dangling ids).
  const normalized = body.replace(
    /\[\s*((?:ref|report)-\d+(?:\s*,\s*(?:ref|report)-\d+)+)\s*\]/g,
    (_m, inner: string) => inner.split(/\s*,\s*/).map((id) => `[${id}]`).join(""),
  );

  const remap = new Map<string, string>();
  const ordered: LedgerSource[] = [];
  const dropped = new Set<string>();
  let assigned = 0;

  for (const m of normalized.matchAll(MARKER_OR_PROP)) {
    const id = (m[1] ?? m[3])!; // bracketed marker or cite= prop
    if (remap.has(id)) continue;
    const srcRec = ledger.get(id);
    if (!srcRec) {
      dropped.add(id);
      continue;
    }
    assigned += 1;
    const to = `ref-${assigned}`;
    remap.set(id, to);
    ordered.push(srcRec);
  }

  const outBody = normalized.replace(
    MARKER_OR_PROP,
    (_whole, bracketed: string | undefined, ws: string | undefined, prop: string | undefined) => {
      if (bracketed !== undefined) {
        const to = remap.get(bracketed);
        return to ? `[${to}]` : ""; // drop dangling marker
      }
      const to = remap.get(prop!);
      // Dangling cite prop: remove the attribute (whitespace included),
      // keep the component itself intact.
      return to ? `${ws}cite="${to}"` : "";
    },
  );

  const citations: Citation[] = ordered.map((s, i) => ({
    refId: `ref-${i + 1}`,
    url: s.url,
    source: s.source,
    headline: s.headline,
    date: s.date,
    type: s.type === "director" ? "trade" : s.type, // Citation.type has no 'director'; map to 'trade'
  }));

  return { body: outBody, citations, dropped: [...dropped] };
}
