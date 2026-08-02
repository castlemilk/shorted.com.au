"use client";

// The register explorer: search + facets over every parliamentarian.
//
// WHY IT IS A CLIENT ISLAND. /politicians is a static-ISR SEO asset. Reading
// `searchParams` in the server page silently switches the route to dynamic and
// kills the ISR — the documented trap that /price-drops already hit. So query
// state lives in the URL and is read CLIENT-side via useSearchParams under a
// Suspense boundary, and the server page stays prerendered.
//
// EDITORIAL. Every result card names a real person, so:
//   - counts are of DECLARED THINGS, never a value, and are labelled as such
//   - no warning or currency iconography anywhere near a name (rule 2, rule 5)
//   - "no declared interests" is stated as coverage, never as a finding: for the
//     44th/45th parliaments we simply have not read every document, and an empty
//     profile must not read as "this person declared nothing"
//   - highlights are rendered as REACT NODES, never dangerouslySetInnerHTML —
//     the highlighted strings are free text out of a PDF

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PartyMark } from "@/components/politicians/party-mark";
import { PoliticsIcon } from "@/components/politicians/politics-icon";
import { PoliticianAvatar } from "@/components/politicians/politician-avatar";
import {
  highlightFor,
  searchPoliticians,
  splitHighlight,
  type PoliticianHit,
  type PoliticianSearchResponse,
} from "@/lib/politics/politician-search";
import { PARTY_LABEL, partyLabel } from "@/lib/politics/party-palette";

/**
 * The party chip, rendered locally rather than imported from `compliance.tsx`.
 *
 * THIS IS NOT DUPLICATION FOR ITS OWN SAKE. compliance.tsx has no "use client"
 * directive and imports the generated protobuf module for RegisterHolder, so
 * pulling PartyChip from it into a CLIENT component drags @bufbuild/protobuf
 * across the boundary — which is the "Element type is invalid: … got: undefined"
 * prerender failure documented in CLAUDE.md, and it took /politicians' whole
 * static build down when this file first imported it.
 *
 * party-palette.ts exists precisely for this: its own docblock records that it
 * was split out so politician surfaces can colour by party without dragging a
 * heavy module along. It is pure data.
 */
function ExplorerPartyChip({ partyAb }: { partyAb?: string }) {
  if (!partyAb) {
    // Party reaches the register through an electorate join, not the APH
    // listing, so absence is real and is labelled as absence — never guessed.
    return <span className="text-[11px] text-muted-foreground">Party not recorded</span>;
  }
  // The mark carries the party's full name as its own accessible name, so the
  // visible label is aria-hidden — a result list would otherwise announce the
  // party twice on every hit.
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <PartyMark abbreviation={partyAb} size="sm" />
      <span aria-hidden>{partyLabel(partyAb)}</span>
    </span>
  );
}

/** The rail, in the order it renders. */
const FACET_GROUPS: { key: string; label: string; format?: (v: string) => string }[] = [
  { key: "party_ab", label: "Party", format: (v) => (v ? (PARTY_LABEL[v] ?? v) : "Not recorded") },
  { key: "chamber", label: "Chamber", format: (v) => (v === "house" ? "House" : v === "senate" ? "Senate" : v) },
  { key: "state_code", label: "State" },
  { key: "industries", label: "Declared industry" },
];

const MAX_FACET_ROWS = 8;

type Selected = Record<string, string[]>;

function parseSelected(params: URLSearchParams): Selected {
  const out: Selected = {};
  for (const { key } of FACET_GROUPS) {
    const raw = params.get(key);
    if (raw) out[key] = raw.split("~").filter(Boolean);
  }
  return out;
}

export function PoliticianExplorer({ initialQuery = "" }: { initialQuery?: string }) {
  const router = useRouter();
  const params = useSearchParams();

  // Not `??`: an EMPTY initialQuery must fall through to the URL, and an empty
  // `?q=` must fall through to "". `??` only skips null/undefined, so it would
  // pin the box to a blank value that came from the wrong place.
  const [query, setQuery] = useState(() => {
    const fromProp = initialQuery.trim();
    if (fromProp) return fromProp;
    return params.get("q")?.trim() ?? "";
  });
  const [selected, setSelected] = useState<Selected>(() => parseSelected(new URLSearchParams(params)));
  const [result, setResult] = useState<PoliticianSearchResponse | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [cursor, setCursor] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const facetFilters = useMemo(
    () =>
      Object.entries(selected)
        .filter(([, values]) => values.length > 0)
        // OR within a group, AND across groups — the shape Algolia expects and
        // the behaviour a reader assumes: two parties widens, party + state narrows.
        .map(([key, values]) => values.map((v) => `${key}:${v}`)),
    [selected],
  );

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const t = setTimeout(() => {
      searchPoliticians(query, { facetFilters, hitsPerPage: 24 })
        .then((r) => {
          if (cancelled) return;
          setResult(r);
          setStatus("idle");
          setCursor(-1);
        })
        .catch(() => {
          if (!cancelled) setStatus("error");
        });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, facetFilters]);

  // Mirror state into the URL so a filtered view is shareable — replace, not
  // push, so the back button leaves the page rather than walking keystrokes.
  useEffect(() => {
    const next = new URLSearchParams();
    if (query.trim()) next.set("q", query.trim());
    for (const [key, values] of Object.entries(selected)) {
      if (values.length) next.set(key, values.join("~"));
    }
    const qs = next.toString();
    router.replace(qs ? `/politicians?${qs}` : "/politicians", { scroll: false });
  }, [query, selected, router]);

  const toggleFacet = useCallback((key: string, value: string) => {
    setSelected((prev) => {
      const current = prev[key] ?? [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      const out = { ...prev };
      if (next.length) out[key] = next;
      else delete out[key];
      return out;
    });
  }, []);

  // Memoised because the keyboard effect below depends on it: a fresh array
  // identity every render would tear down and re-register the window listener
  // on every keystroke.
  const hits = useMemo(() => result?.hits ?? [], [result]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (!hits.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, hits.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, -1));
      } else if (e.key === "Enter" && cursor >= 0) {
        const target = hits[cursor];
        if (!target) return;
        e.preventDefault();
        router.push(`/politicians/${target.slug}`);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hits, cursor, router]);

  const activeCount = Object.values(selected).reduce((n, v) => n + v.length, 0);

  return (
    <div className="space-y-4">
      <div className="relative">
        {/*
          THE MAGNIFIER LIVES IN THE SEARCH BOX AND NOWHERE ELSE. The icon set's
          config constrains it here on purpose — a magnifying glass pointed at a
          person reads as investigation, which is why the set carries no eye, no
          binoculars and no detective subject at all. `pointer-events-none` so it
          cannot eat a tap meant for the field it sits on.
        */}
        <PoliticsIcon
          name="search"
          size={18}
          className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 opacity-70"
        />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a member, an electorate, a company or a suburb…   ( / )"
          className="h-12 pl-10 pr-28 text-base"
          aria-label="Search parliamentarians"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] tabular-nums text-muted-foreground">
          {status === "loading"
            ? "…"
            : result
              ? `${result.nbHits.toLocaleString()} ${result.nbHits === 1 ? "member" : "members"}`
              : ""}
        </span>
      </div>

      <div className="grid gap-6 md:grid-cols-[210px_minmax(0,1fr)]">
        <aside className="space-y-5">
          {activeCount > 0 ? (
            <button
              type="button"
              onClick={() => setSelected({})}
              className="text-[11px] text-muted-foreground underline underline-offset-2"
            >
              Clear {activeCount} {activeCount === 1 ? "filter" : "filters"}
            </button>
          ) : null}

          {FACET_GROUPS.map((group) => {
            const counts = result?.facets?.[group.key] ?? {};
            const entries = Object.entries(counts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, MAX_FACET_ROWS);
            if (entries.length === 0) return null;
            return (
              <div key={group.key}>
                <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </h3>
                <ul className="space-y-0.5">
                  {entries.map(([value, count]) => {
                    const on = selected[group.key]?.includes(value) ?? false;
                    return (
                      <li key={value}>
                        <button
                          type="button"
                          onClick={() => toggleFacet(group.key, value)}
                          aria-pressed={on}
                          className={`flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted ${
                            on ? "bg-muted font-medium" : ""
                          }`}
                        >
                          <span className="truncate">
                            {group.format ? group.format(value) : value}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {count}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </aside>

        <div className="space-y-2">
          {status === "error" ? (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              Search is unavailable right now. The full list of members is still on each
              profile page, and nothing here is missing from the register.
            </p>
          ) : null}

          {status !== "error" && hits.length === 0 && result ? (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No members match. Try a company (&ldquo;Woodside&rdquo;), an electorate, or a
              suburb.
            </p>
          ) : null}

          <ul className="divide-y">
            {hits.map((hit, i) => (
              <ResultCard key={hit.objectID} hit={hit} active={i === cursor} />
            ))}
          </ul>

          {result && result.nbHits > hits.length ? (
            <p className="pt-2 text-[11px] text-muted-foreground">
              Showing {hits.length} of {result.nbHits.toLocaleString()}. Narrow with the filters
              or search a name.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Highlighted({ value, fallback }: { value?: string; fallback: string }) {
  if (!value) return <>{fallback}</>;
  return (
    <>
      {splitHighlight(value).map((part, i) =>
        part.hit ? (
          <mark key={i} className="bg-primary/20 text-inherit">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Why this member matched, when it was not their name — the company or suburb
 * they declare. Only rendered when Algolia actually highlighted one, so a card
 * never says "declares" followed by nothing.
 */
function MatchReason({ hit }: { hit: PoliticianHit }) {
  // Explicit rather than `||`: a highlight can be an EMPTY string, which must
  // fall through to the next field, and `??` would not.
  const company = highlightFor(hit, "company_names")?.trim() ?? "";
  const suburb = highlightFor(hit, "suburbs")?.trim() ?? "";
  const reason = company.length > 0 ? company : suburb;
  if (!reason) return null;
  return (
    <p className="mt-1 truncate text-[11px] text-muted-foreground">
      declares <Highlighted value={reason} fallback="" />
    </p>
  );
}

function ResultCard({ hit, active }: { hit: PoliticianHit; active: boolean }) {
  const role =
    hit.chamber === "senate"
      ? `Senator for ${hit.state_code ?? ""}`.trim()
      : hit.division
        ? `Member for ${hit.division}`
        : "";

  return (
    <li className={active ? "bg-muted/50" : undefined}>
      <Link
        href={`/politicians/${hit.slug}`}
        className="flex gap-3 px-2 py-3 hover:bg-muted/40"
      >
        <PoliticianAvatar
          displayName={hit.display_name}
          partyAb={hit.party_ab}
          size="md"
          photo={{
            photoUrl: hit.photo_url,
            photoLicence: hit.photo_licence,
            photoAuthor: hit.photo_author,
            photoSourceUrl: hit.photo_source_url,
          }}
        />
        <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-medium">
            <Highlighted value={highlightFor(hit, "display_name")} fallback={hit.display_name} />
          </span>
          <ExplorerPartyChip partyAb={hit.party_ab} />
          {role ? <span className="text-xs text-muted-foreground">{role}</span> : null}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {/*
            Counts of DECLARED THINGS, labelled as such. Not "holdings", which
            implies a portfolio, and never a magnitude — the registers record
            neither quantity nor value.
          */}
          {hit.declared_listed_count > 0 ? (
            <Badge variant="secondary" className="text-[10px]">
              {hit.declared_listed_count} declared{" "}
              {hit.declared_listed_count === 1 ? "company" : "companies"}
            </Badge>
          ) : null}
          {hit.declared_property_count > 0 ? (
            <Badge variant="secondary" className="text-[10px]">
              {hit.declared_property_count}{" "}
              {hit.declared_property_count === 1 ? "suburb" : "suburbs"}
            </Badge>
          ) : null}
          {!hit.has_interests ? (
            // Coverage, not a finding. We have not read every document for the
            // 44th and 45th parliaments, so an empty profile is our gap.
            <span className="text-[10px] text-muted-foreground">
              nothing matched yet in the documents read
            </span>
          ) : null}
          {hit.first_parliament ? (
            <span className="text-[10px] text-muted-foreground">
              {hit.first_parliament}
              {hit.last_parliament && hit.last_parliament !== hit.first_parliament
                ? `–${hit.last_parliament}`
                : ""}
              P
            </span>
          ) : null}
        </div>

        {/* Why this member matched, when it was not their name. */}
        <MatchReason hit={hit} />
        </div>
      </Link>
    </li>
  );
}
