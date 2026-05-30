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
    return `${s.type}:${s.url}`;
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

const MARKER = /\[(ref-\d+)\]/g;

/**
 * Walk the body, drop any [ref-N] not in the ledger, and renumber the
 * cited-and-valid markers into contiguous ref-1..M in first-appearance
 * order. Returns the rewritten body, the ordered Citation[] for the
 * editorial_takes.citations column, and the dropped (dangling) marker ids.
 */
export function compactCitations(
  body: string,
  ledger: CitationLedger,
): { body: string; citations: Citation[]; dropped: string[] } {
  const remap = new Map<string, string>();
  const ordered: LedgerSource[] = [];
  const dropped: string[] = [];
  let assigned = 0;

  for (const m of body.matchAll(MARKER)) {
    const id = m[1]!;
    if (remap.has(id)) continue;
    const srcRec = ledger.get(id);
    if (!srcRec) {
      if (!dropped.includes(id)) dropped.push(id);
      continue;
    }
    assigned += 1;
    const to = `ref-${assigned}`;
    remap.set(id, to);
    ordered.push(srcRec);
  }

  const outBody = body.replace(MARKER, (whole, id: string) => {
    if (remap.has(id)) return `[${remap.get(id)}]`;
    return ""; // drop dangling marker
  });

  const citations: Citation[] = ordered.map((s, i) => ({
    refId: `ref-${i + 1}`,
    url: s.url,
    source: s.source,
    headline: s.headline,
    date: s.date,
    type: s.type === "director" ? "trade" : s.type, // Citation.type has no 'director'; map to 'trade'
  }));

  return { body: outBody, citations, dropped };
}
