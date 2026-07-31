"use client";

// Screen (b) of docs/feature/politicians/review-console.md — the security candidate.
//
// THE JOB THIS SCREEN DOES. The item-1 gate is 51.18%, and §8.19.1 established
// that the denominator is a DEFAULT bucket: the resolver labels anything it
// cannot otherwise explain 'listed'. So the backlog holds two different things
// that are indistinguishable in the percentage — names we could match and have
// not, and names that are correctly unmatchable (delisted, foreign, unlisted
// funds, "See attachment"). A human separating them is the only honest way the
// number moves, and it is a judgement a person makes in one keystroke but cannot
// make 814 times without a screen built for it.
//
// DESIGN RULES INHERITED FROM THE EDITORIAL STANDARDS, not from taste:
//
//   * BLAST RADIUS BEFORE THE CLICK, counted in NAMED PEOPLE. One alias fans out
//     to N politicians' published profiles. "SYDNEY AIRPORT" is six rows across
//     five members; a wrong call there is five wrong facts.
//   * NO FUZZY OPTION EXISTS IN THE DOM. The public gate forbids a fuzzy match
//     from ever being published, and a CHECK violation is a terrible way to
//     learn that after deciding about a named person (§7.2 item 6).
//   * THE DECLARATIONS ARE ON SCREEN. The reviewer judges from what the member
//     actually wrote, with a link to the source PDF — never from the normalised
//     token. "Woodside" could be Woodside Petroleum or Woodside Energy Group.
//   * THE STOPWORD TRAP IS NAMED INLINE and needs a second confirmation. Every
//     fund name ending in "ETF" once resolved to ticker ETF, publishing ten
//     members as holding a fund none had declared.
//   * NO window.confirm (§7.3). It is browser-suppressible, inconsistent for
//     screen readers, and cannot show the payload. AlertDialog shows the blast
//     radius inside the confirmation.

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  decideSecurityCandidate,
  listSecurityQueue,
  searchListings,
  undoSecurityDecision,
  type Coverage,
  type QueueItem,
  type QueueListing,
  type QueuePage,
  type ReviewAliasKind,
  type ReviewDecision,
} from "~/app/actions/admin/registerReview";

/**
 * A decision touching this many people opens a confirmation instead of writing
 * on the keystroke.
 *
 * §7.4 rule 4 asks for a SECOND ADMIN on an alias with occurrences >= 20. That
 * needs a needs_second_review column and a confirmed_by <> corrected_by CHECK,
 * which this build does not have — so the weaker control is used and the gap is
 * stated rather than papered over: a high fan-out decision cannot be made
 * without reading its blast radius, but one admin can still make it.
 */
const CONFIRM_PEOPLE_THRESHOLD = 4;
const CONFIRM_OCCURRENCE_THRESHOLD = 8;

const ALIAS_KINDS: { key: string; value: ReviewAliasKind; label: string }[] = [
  { key: "e", value: "equity", label: "Equity" },
  { key: "t", value: "etf", label: "ETF" },
  { key: "l", value: "lic", label: "LIC" },
  { key: "m", value: "managed_fund", label: "Managed fund" },
];

interface PendingDecision {
  decision: ReviewDecision;
  listing?: QueueListing;
  /** Why the confirmation opened, so the dialog can say so. */
  reason: "blast-radius" | "stopword";
}

export function SecuritiesReview({
  initialPage,
  initialCoverage,
}: {
  initialPage: QueuePage;
  initialCoverage: Coverage | null;
}) {
  const [queue, setQueue] = useState<QueueItem[]>(initialPage.items);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(initialPage.items.length);
  const [coverage, setCoverage] = useState<Coverage | null>(initialCoverage);
  const [totals] = useState({
    candidates: initialPage.totalCandidates,
    rows: initialPage.totalRows,
  });

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QueueListing[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [aliasKind, setAliasKind] = useState<ReviewAliasKind>("equity");
  const [note, setNote] = useState("");

  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastDecided, setLastDecided] = useState<{ norm: string; label: string } | null>(null);
  const [isSaving, startSaving] = useTransition();

  const searchRef = useRef<HTMLInputElement>(null);
  const current = queue[cursor];

  // ---------------------------------------------------------------------
  // Search. Seeded from the candidate itself so the common case is
  // type-nothing: the reviewer reads the declarations, glances at the
  // highlighted listing, and presses one key.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!current) return;
    // `??` would be wrong here: proposedStockCode is "" (proto3's default) when
    // the model answered NONE, and seeding the search box with an empty string
    // would leave the reviewer with no results and nothing to press.
    const proposed = current.proposal?.proposedStockCode?.trim();
    setQuery(proposed ? proposed : current.candidateNorm);
    setAliasKind("equity");
    setNote("");
    setError(null);
    setHighlight(0);
  }, [current?.candidateNorm]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void searchListings(term, 12).then((r) => {
        if (cancelled) return;
        setResults(r);
        setHighlight(0);
      });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const selected = results[highlight];

  const advance = useCallback(() => {
    setCursor((c) => c + 1);
  }, []);

  // Top up the queue before the reviewer reaches the end of it.
  useEffect(() => {
    if (queue.length - cursor > 5 || queue.length === 0) return;
    void listSecurityQueue(25, offset, false).then((page) => {
      if (page.items.length === 0) return;
      setQueue((q) => [...q, ...page.items]);
      setOffset((o) => o + page.items.length);
    });
  }, [cursor, queue.length, offset]);

  // ---------------------------------------------------------------------
  // Committing
  // ---------------------------------------------------------------------
  const commit = useCallback(
    (decision: ReviewDecision, listing?: QueueListing, stopwordConfirmed = false) => {
      if (!current) return;
      startSaving(async () => {
        const result = await decideSecurityCandidate({
          candidateNorm: current.candidateNorm,
          decision,
          stockCode: listing?.stockCode,
          aliasKind: decision === "resolved" ? aliasKind : undefined,
          note,
          stopwordConfirmed,
        });

        if (!result.ok) {
          // A refusal is SHOWN, never swallowed. The stopword guard is the one
          // the reviewer can answer, so it re-opens as a confirmation rather
          // than as a dead error.
          if (result.needsStopwordConfirm && listing) {
            setPending({ decision, listing, reason: "stopword" });
            return;
          }
          setError(result.error ?? "The decision was refused.");
          return;
        }

        if (result.coverage) setCoverage(result.coverage);
        setLastDecided({
          norm: current.candidateNorm,
          label:
            decision === "resolved"
              ? `${current.candidateNorm} → ${listing?.stockCode}`
              : `${current.candidateNorm} → ${decision.replace(/_/g, " ")}`,
        });
        setError(null);
        advance();
      });
    },
    [current, aliasKind, note, advance],
  );

  const requestDecision = useCallback(
    (decision: ReviewDecision, listing?: QueueListing) => {
      if (!current || isSaving) return;
      setError(null);

      // A skip writes nothing, so it never needs a confirmation.
      if (decision === "skip") {
        commit(decision);
        return;
      }
      if (decision === "resolved" && !listing) {
        setError("Pick a listing first — search above, then ↑/↓ to choose.");
        searchRef.current?.focus();
        return;
      }
      if (
        current.people >= CONFIRM_PEOPLE_THRESHOLD ||
        current.occurrences >= CONFIRM_OCCURRENCE_THRESHOLD
      ) {
        setPending({ decision, listing, reason: "blast-radius" });
        return;
      }
      commit(decision, listing);
    },
    [current, isSaving, commit],
  );

  const undoLast = useCallback(() => {
    if (!lastDecided) return;
    startSaving(async () => {
      const result = await undoSecurityDecision(lastDecided.norm);
      if (result.coverage) setCoverage(result.coverage);
      setLastDecided(null);
      if (!result.ok && result.error) setError(result.error);
    });
  }, [lastDecided]);

  // ---------------------------------------------------------------------
  // Keyboard. Decision keys are inert while a text field has focus, so a
  // reviewer typing "2" into the search box never files a decision.
  // ---------------------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (pending) return;
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      if (typing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHighlight((h) => Math.min(h + 1, Math.max(results.length - 1, 0)));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setHighlight((h) => Math.max(h - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          requestDecision("resolved", selected);
        } else if (e.key === "Escape") {
          (el as HTMLInputElement).blur();
        }
        return;
      }

      switch (e.key) {
        case "1":
          e.preventDefault();
          requestDecision("resolved", selected);
          break;
        case "2":
          e.preventDefault();
          requestDecision("unlisted_fund");
          break;
        case "3":
          e.preventDefault();
          requestDecision("not_a_security");
          break;
        case "4":
          e.preventDefault();
          requestDecision("skip");
          break;
        case "5":
          e.preventDefault();
          requestDecision("foreign");
          break;
        case "/":
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        default: {
          const kind = ALIAS_KINDS.find((k) => k.key === e.key.toLowerCase());
          if (kind) {
            e.preventDefault();
            setAliasKind(kind.value);
          }
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, results.length, selected, requestDecision]);

  if (!current) {
    return (
      <div className="rounded-lg border p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No undecided candidates in this queue. Run{" "}
          <code className="font-mono text-xs">shorted influence -mode register-resolve</code> to
          apply the decisions made here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <CoveragePanel coverage={coverage} totals={totals} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-5 rounded-lg border p-5">
          {/* 1. The name, as written and as normalised. */}
          <div>
            <p className="font-mono text-xl">{current.example}</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {current.candidateNorm}
            </p>
          </div>

          {/* 2. Blast radius, BEFORE the decision, counted in named people. */}
          <BlastRadius item={current} />

          {/* 3. What members actually wrote, each linking its own source PDF. */}
          <div className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Declared as
            </h2>
            <ul className="divide-y rounded-md border">
              {current.samples.map((s, i) => (
                <li key={`${s.politicianSlug}-${i}`} className="flex flex-col gap-1 p-3">
                  <span className="font-mono text-sm">{s.declaredText}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {s.politicianName || "unattributed"} · item {s.itemNo}
                    {s.parliament ? ` · ${s.parliament}P` : ""}
                    {s.sourceUrl ? (
                      <>
                        {" · "}
                        <a
                          href={s.sourceUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline underline-offset-2"
                        >
                          source ↗
                        </a>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {current.samples.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No sample rows loaded for this candidate.
              </p>
            ) : null}
          </div>

          {current.proposal ? <ProposalNote proposal={current.proposal} /> : null}

          {/* 4. The resolve box. */}
          <div className="space-y-2">
            <label
              htmlFor="listing-search"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Resolve to a listing
            </label>
            <Input
              id="listing-search"
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search code or company name…  (press / to focus)"
              autoComplete="off"
            />
            <ul className="max-h-56 divide-y overflow-y-auto rounded-md border">
              {results.map((l, i) => (
                <li key={l.stockCode}>
                  <button
                    type="button"
                    onClick={() => setHighlight(i)}
                    onDoubleClick={() => requestDecision("resolved", l)}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${
                      i === highlight ? "bg-muted" : ""
                    }`}
                  >
                    <span>
                      <span className="font-mono font-medium">{l.stockCode}</span>{" "}
                      <span className="text-muted-foreground">{l.companyName}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {l.isStopwordTicker ? (
                        <Badge variant="outline" className="text-[10px]">
                          stopword
                        </Badge>
                      ) : null}
                      <span className="text-[11px] text-muted-foreground">
                        {l.existingUses} already
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {results.length === 0 ? (
                <li className="px-3 py-2 text-xs text-muted-foreground">
                  No listings match. This name may not be resolvable — that is a real answer, and
                  key 2, 3 or 5 records it.
                </li>
              ) : null}
            </ul>

            {selected?.isStopwordTicker ? (
              <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                <strong className="font-medium">{selected.stockCode}</strong> is{" "}
                {selected.companyName}. This code is also an ordinary word in the register — every
                fund name ending in &ldquo;ETF&rdquo; once resolved to ticker ETF and published ten
                members as holding a fund none had declared. Resolve only if the declaration above
                genuinely names this listing; you will be asked to confirm twice.
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-[11px] text-muted-foreground">Kind:</span>
              {ALIAS_KINDS.map((k) => (
                <Button
                  key={k.value}
                  type="button"
                  size="sm"
                  variant={aliasKind === k.value ? "default" : "outline"}
                  onClick={() => setAliasKind(k.value)}
                >
                  {k.label}
                  <span className="ml-1 text-[10px] opacity-60">{k.key}</span>
                </Button>
              ))}
            </div>

            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional) — recorded on the alias row"
              autoComplete="off"
            />
          </div>

          {error ? (
            <p role="alert" className="rounded-md border border-dashed p-2 text-sm">
              {error}
            </p>
          ) : null}

          <DecisionBar
            onDecide={requestDecision}
            selected={selected}
            disabled={isSaving}
          />
        </section>

        <aside className="space-y-4">
          <QueueProgress cursor={cursor} totals={totals} />
          {lastDecided ? (
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">Last decision</p>
              <p className="mt-1 font-mono text-sm">{lastDecided.label}</p>
              {/*
                UNDO, not Revert. Deleting the alias row returns every candidate
                it covered to 'unmatched' — the honest pre-decision state — and
                nothing was published in between, because publication happens on
                the next resolve.
              */}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={undoLast}
                disabled={isSaving}
              >
                Undo
              </Button>
            </div>
          ) : null}
          <KeyLegend />
        </aside>
      </div>

      <ConfirmDialog
        pending={pending}
        item={current}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          const p = pending;
          setPending(null);
          commit(p.decision, p.listing, p.reason === "stopword");
        }}
      />
    </div>
  );
}

function BlastRadius({ item }: { item: QueueItem }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge variant="secondary">{item.occurrences} rows</Badge>
      {/*
        People is the number that matters and it is styled to be read first: a
        wrong alias is one wrong fact per NAMED PERSON, not per row.
      */}
      <Badge variant="secondary">
        {item.people} {item.people === 1 ? "member" : "members"}
      </Badge>
      <Badge variant="outline">items {item.items.join(", ")}</Badge>
      {item.parliaments.length > 0 ? (
        <Badge variant="outline">parliaments {item.parliaments.join(", ")}</Badge>
      ) : null}
      {item.gateRows > 0 ? (
        <Badge variant="outline">{item.gateRows} in the item-1 gate</Badge>
      ) : (
        <Badge variant="outline">outside the item-1 gate</Badge>
      )}
      {item.skipCount > 0 ? (
        <Badge variant="outline">skipped {item.skipCount}×</Badge>
      ) : null}
    </div>
  );
}

// The model's suggestion, shown WITH its rationale and confidence. It is a
// queue-ranker, not an oracle: it once proposed FLIGHTS → Flight Centre, which
// is a gift-log entry. Rendered as evidence to weigh, never as a default action.
function ProposalNote({
  proposal,
}: {
  proposal: NonNullable<QueueItem["proposal"]>;
}) {
  return (
    <div className="rounded-md border border-dashed p-3 text-xs">
      <p className="font-medium">
        {proposal.proposedStockCode
          ? `Model suggests ${proposal.proposedStockCode} — ${proposal.proposedCompanyName}`
          : "Model answered NONE"}
        {proposal.confidence ? (
          <span className="ml-2 font-normal text-muted-foreground">
            confidence {proposal.confidence.toFixed(2)}
          </span>
        ) : null}
      </p>
      {proposal.rationale ? (
        <p className="mt-1 text-muted-foreground">&ldquo;{proposal.rationale}&rdquo;</p>
      ) : null}
      {proposal.shortlist.length > 0 ? (
        <p className="mt-1 text-muted-foreground">
          Chose from: {proposal.shortlist.map((l) => l.stockCode).join(", ")}
        </p>
      ) : null}
      <p className="mt-1 text-[10px] text-muted-foreground">
        A suggestion, not an answer. It cannot publish anything on its own.
      </p>
    </div>
  );
}

function DecisionBar({
  onDecide,
  selected,
  disabled,
}: {
  onDecide: (d: ReviewDecision, l?: QueueListing) => void;
  selected?: QueueListing;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-t pt-4">
      <Button type="button" disabled={disabled} onClick={() => onDecide("resolved", selected)}>
        1 · Resolve{selected ? ` to ${selected.stockCode}` : ""}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => onDecide("unlisted_fund")}
      >
        2 · Unlisted fund
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => onDecide("not_a_security")}
      >
        3 · Not a security
      </Button>
      <Button type="button" variant="ghost" disabled={disabled} onClick={() => onDecide("skip")}>
        4 · Skip
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => onDecide("foreign")}
      >
        5 · Foreign listing
      </Button>
    </div>
  );
}

function KeyLegend() {
  return (
    <div className="rounded-lg border p-4 text-xs text-muted-foreground">
      <p className="mb-2 font-medium text-foreground">Keys</p>
      <ul className="space-y-1">
        <li>
          <kbd className="font-mono">/</kbd> search · <kbd className="font-mono">↑↓</kbd> choose ·{" "}
          <kbd className="font-mono">↵</kbd> resolve
        </li>
        <li>
          <kbd className="font-mono">1</kbd> resolve · <kbd className="font-mono">2</kbd> unlisted
          fund · <kbd className="font-mono">3</kbd> not a security
        </li>
        <li>
          <kbd className="font-mono">4</kbd> skip · <kbd className="font-mono">5</kbd> foreign
        </li>
        <li>
          <kbd className="font-mono">e t l m</kbd> kind
        </li>
      </ul>
      <p className="mt-3 leading-relaxed">
        There is no &ldquo;probably&rdquo; key. A guess cannot be published, so it is not offered.
      </p>
    </div>
  );
}

function QueueProgress({
  cursor,
  totals,
}: {
  cursor: number;
  totals: { candidates: number; rows: number };
}) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">This session</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{cursor}</p>
      <p className="text-xs text-muted-foreground">
        decided of {totals.candidates.toLocaleString()} undecided names ({totals.rows.toLocaleString()}{" "}
        rows)
      </p>
    </div>
  );
}

// The gate, live — and never as a bare percentage.
//
// §8.19.1: a figure that travels 30.66% → 49.89% → ~80% with the numerator
// frozen is measuring our ability to EXPLAIN failures, not to RESOLVE them. Both
// halves are on screen so a reviewer watching the number climb can see WHICH
// half moved, and the method is printed underneath so it cannot be screenshotted
// into a claim.
function CoveragePanel({
  coverage,
  totals,
}: {
  coverage: Coverage | null;
  totals: { candidates: number; rows: number };
}) {
  const pct = useMemo(
    () => (coverage ? coverage.gatePercent.toFixed(2) : "—"),
    [coverage],
  );
  if (!coverage) return null;

  return (
    <div className="rounded-lg border p-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Item-1 gate" value={`${pct}%`} sub="contested — see method" />
        <Stat
          label="Resolved"
          value={coverage.resolved.toLocaleString()}
          sub="numerator · real links"
        />
        <Stat
          label="Classified out"
          value={coverage.classifiedOut.toLocaleString()}
          sub="denominator · explained"
        />
        <Stat
          label="Backlog"
          value={coverage.backlogCandidates.toLocaleString()}
          sub={`${totals.rows.toLocaleString()} rows undecided`}
        />
      </div>
      <p className="mt-3 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
        {coverage.method}
      </p>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

// AlertDialog, never window.confirm (§7.3): the confirmation must be able to
// SHOW the payload, and the payload here is how many named people this touches.
function ConfirmDialog({
  pending,
  item,
  onCancel,
  onConfirm,
}: {
  pending: PendingDecision | null;
  item: QueueItem;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const open = pending !== null;
  const stopword = pending?.reason === "stopword";

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {stopword
              ? `${pending?.listing?.stockCode} is also an ordinary word`
              : `This decision reaches ${item.people} named ${
                  item.people === 1 ? "person" : "people"
                }`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                <span className="font-mono">{item.candidateNorm}</span> →{" "}
                <span className="font-medium">
                  {pending?.decision === "resolved"
                    ? `${pending?.listing?.stockCode} (${pending?.listing?.companyName})`
                    : pending?.decision.replace(/_/g, " ")}
                </span>
              </p>
              <p className="text-muted-foreground">
                {item.occurrences} declared rows across {item.people}{" "}
                {item.people === 1 ? "member" : "members"}
                {item.parliaments.length ? `, parliaments ${item.parliaments.join(", ")}` : ""}.
              </p>
              {stopword ? (
                <p className="text-muted-foreground">
                  This code is in the resolver&rsquo;s stopword list because names ending in it
                  resolve to it by coincidence. Confirm only if the declaration genuinely names
                  this listing.
                </p>
              ) : null}
              <p className="text-muted-foreground">
                Nothing is published by this click. It writes one curated alias; the next{" "}
                <code className="font-mono text-xs">register-resolve</code> applies it, and Undo
                removes it before then.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {stopword ? "Yes, resolve to this code" : "Record decision"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
