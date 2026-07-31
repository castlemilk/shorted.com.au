"use client";

/**
 * Two parliamentarians' declared interests, side by side.
 *
 * WHAT THIS IS NOT. It is a symmetric presentation of two sets of counts. There
 * is no ranking, no total, no "who declares more" and no chip anywhere that
 * elevates one column over the other — not in the copy, not in the aria labels,
 * not in the sr-only tables. The registers record WHAT is held and never how
 * much, so there is nothing here that could be ranked even if we wanted to rank
 * it, and adjudicating between two named people on a count of form entries is
 * exactly the imputation the editorial standards exist to prevent.
 *
 * WHY IT LIVES UNDER app/politicians/compare AND NOT IN THE COMPONENT KIT.
 * This file reaches the generated protobuf runtime (through the client action
 * and through `compliance.tsx`), which is banned for anything under
 * `@/components/politicians` by `client-boundary.test.ts` — that rule exists
 * because a client component in that tree gets PRERENDERED, and the protobuf
 * runtime taking a static build down produces the undiagnosable "Element type
 * is invalid" failure. The sanctioned escape is the one
 * `suburb-politician-property-card.tsx` uses: never be server-rendered. So this
 * module is reached ONLY through `compare-panel-loader.tsx`, which is
 * `dynamic(..., { ssr: false })`. Keeping it out of the component tree means the
 * guard needs no new exemption and nobody has to remember one.
 *
 * WHY THE QUERY STATE IS CLIENT-SIDE. Reading `searchParams` in the server page
 * silently flips the route to dynamic and kills the ISR — the trap /price-drops
 * paid for. `?a=` and `?b=` are read here, under the page's Suspense boundary.
 *
 * THE TWO SERIES COLOURS. Each side is tinted by its own party colour. When both
 * sides sit in the same party, one colour would render two indistinguishable
 * polygons, so the second side falls back to a muted slate — never a red/green
 * pair, which would read as good/bad about a person. The legend and the header
 * cards both name which side the slate belongs to, so the mapping is stated
 * rather than inferred from position.
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Input } from "@/components/ui/input";
import { PoliticianAvatar } from "@/components/politicians/politician-avatar";
import { HolderBadge, SourceLine } from "@/components/politicians/compliance";
import { CompareBars } from "@/components/politicians/explorer/compare-bars";
import { CompareRadar } from "@/components/politicians/explorer/compare-radar";
import { CountTile } from "@/components/politicians/explorer/count-tile";
import { KeyFacts } from "@/components/politicians/explorer/key-facts";
import { partyColorFromAb, partyLabel } from "@/lib/politics/party-palette";
import {
  searchPoliticians,
  type PoliticianHit,
} from "@/lib/politics/politician-search";
import { registerItem } from "@/lib/politics/register-items";
import { toDate } from "@/lib/politics/timestamp";
import { sectionTitle } from "@/lib/typography";
import { comparePoliticiansClient } from "~/app/actions/client/getPoliticiansClient";

/*
 * The response types, derived from the action rather than imported from
 * `~/gen/…`. Same types, no import of the generated module in this file's own
 * import list — which keeps the shape of this module honest to anyone grepping
 * for who touches protobuf.
 */
type CompareResponse = NonNullable<
  Awaited<ReturnType<typeof comparePoliticiansClient>>
>;
type CompareSummary = NonNullable<CompareResponse["a"]>;
type Member = NonNullable<CompareSummary["politician"]>;
type HolderCount = CompareResponse["holderCountsA"][number];
type SharedCompany = CompareResponse["sharedCompanies"][number];
type OnlyCompany = CompareResponse["onlyACompanies"][number];

/**
 * The second series colour when both members sit in the same party.
 *
 * A cool slate: it is separable from every colour in `party-palette` (all of
 * which are warm or saturated), it carries no valence, and it is legible on
 * both themes. Explicitly NOT a red/green pairing — two named people are not a
 * good outcome and a bad one.
 */
const SAME_PARTY_FALLBACK = "#64748b";

/** How many rows of a one-sided list render before the tail is summarised. */
const DIFFERENCE_CAP = 8;

/**
 * The radar's axes: the register's fourteen items folded into eight groups.
 *
 * Every item is represented — nothing is dropped to make the shape tidier. The
 * paired bars above the radar keep the per-item detail; this is the same data
 * at a coarser grain, which is the only reason a polygon is readable at all.
 */
const CATEGORY_GROUPS: { label: string; items: number[] }[] = [
  { label: "Shareholdings", items: [1] },
  { label: "Investments", items: [7, 8, 9] },
  { label: "Trusts", items: [2] },
  { label: "Real estate", items: [3] },
  { label: "Roles", items: [4, 5, 13] },
  { label: "Liabilities", items: [6] },
  { label: "Gifts & travel", items: [11, 12] },
  { label: "Other", items: [10, 14] },
];

/**
 * Holder labels, in the register's own words and in the register's own order.
 *
 * The strings match `compliance.tsx` exactly — those are the reviewed wording,
 * and a paraphrase here would be a second, unreviewed vocabulary for the same
 * fact. "Holder not stated" is a real category: thousands of published rows come
 * off alteration forms that have no holder column, and we do not infer one.
 */
const HOLDER_ORDER: { holder: number; label: string }[] = [
  { holder: 1, label: "Self" },
  { holder: 2, label: "Spouse/partner" },
  { holder: 3, label: "Dependent child" },
  { holder: 0, label: "Holder not stated" },
];

function countForItem(
  counts: CompareSummary["itemCounts"],
  itemNo: number,
): number {
  return counts.find((count) => count.itemNo === itemNo)?.currentCount ?? 0;
}

function countForHolder(counts: HolderCount[], holder: number): number {
  return counts.find((count) => Number(count.holder) === holder)?.currentCount ?? 0;
}

function totalDeclared(summary: CompareSummary): number {
  return summary.itemCounts.reduce((sum, count) => sum + count.currentCount, 0);
}

/** "44th and 45th" / "44th, 45th and 46th". */
function parliamentList(numbers: number[]): string {
  const ordinals = numbers.map((n) => `${n}th`);
  if (ordinals.length <= 1) return ordinals[0] ?? "";
  return `${ordinals.slice(0, -1).join(", ")} and ${ordinals[ordinals.length - 1]}`;
}

function memberRole(member: Member): string {
  if (member.chamber === "senate") {
    return member.stateCode ? `Senator for ${member.stateCode}` : "Senator";
  }
  if (member.division) {
    return member.stateCode
      ? `Member for ${member.division}, ${member.stateCode}`
      : `Member for ${member.division}`;
  }
  return member.stateCode ? `Member, ${member.stateCode}` : "Member";
}

function parliamentRange(member: Member): string {
  if (!member.firstParliament) return "";
  if (!member.lastParliament || member.lastParliament === member.firstParliament) {
    return `${member.firstParliament}th Parliament`;
  }
  return `${member.firstParliament}th–${member.lastParliament}th Parliaments`;
}

function hitRole(hit: PoliticianHit): string {
  if (hit.chamber === "senate") {
    return hit.state_code ? `Senator for ${hit.state_code}` : "Senator";
  }
  return hit.division ? `Member for ${hit.division}` : "";
}

/* ------------------------------------------------------------------ pickers */

interface PickerProps {
  /** "A" / "B" — used for the field label and the listbox ids only. */
  side: string;
  label: string;
  /** Name of the member currently selected, if any. */
  selectedName: string;
  onSelect: (hit: PoliticianHit) => void;
  onClear: () => void;
}

function MemberPicker({
  side,
  label,
  selectedName,
  onSelect,
  onClear,
}: PickerProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PoliticianHit[]>([]);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = `compare-picker-${side.toLowerCase()}`;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchPoliticians(query, { hitsPerPage: 6, facets: [] })
        .then((result) => {
          if (cancelled) return;
          setHits(result.hits);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open]);

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  return (
    <div className="space-y-1.5">
      <label
        className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        htmlFor={`${listId}-input`}
      >
        {label}
      </label>
      <div className="relative">
        <Input
          id={`${listId}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          placeholder={selectedName || "Search a member or senator…"}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Deferred: a click on an option fires after blur, and closing
            // synchronously would unmount the option before it is chosen.
            blurTimer.current = setTimeout(() => setOpen(false), 120);
          }}
          className="h-11 pr-16"
        />
        {selectedName ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              onClear();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Clear
          </button>
        ) : null}

        {open ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={`${label} results`}
            className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md"
          >
            {failed ? (
              <li className="px-2 py-2 text-[11px] text-muted-foreground">
                Search is unavailable right now. Nothing is missing from the
                register — only the lookup is down.
              </li>
            ) : null}
            {!failed && hits.length === 0 ? (
              <li className="px-2 py-2 text-[11px] text-muted-foreground">
                No members match. Try a surname or an electorate.
              </li>
            ) : null}
            {hits.map((hit) => (
              <li key={hit.objectID} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setQuery("");
                    setOpen(false);
                    onSelect(hit);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                >
                  <PoliticianAvatar
                    displayName={hit.display_name}
                    partyAb={hit.party_ab}
                    size="sm"
                    photo={{
                      photoUrl: hit.photo_url,
                      photoLicence: hit.photo_licence,
                      photoAuthor: hit.photo_author,
                      photoSourceUrl: hit.photo_source_url,
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {hit.display_name}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {[partyLabel(hit.party_ab), hitRole(hit)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- header cards */

function SeriesChip({
  color,
  partyAb,
  note,
}: {
  color: string;
  partyAb?: string;
  note?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {/* Party reaches the register through an electorate join, not the APH
          listing, so absence is real and is labelled as absence. */}
      {partyAb ? partyLabel(partyAb) : "Party not recorded"}
      {note ? <span className="text-muted-foreground/80">· {note}</span> : null}
    </span>
  );
}

function MemberCard({
  summary,
  color,
  colorNote,
}: {
  summary: CompareSummary;
  color: string;
  colorNote?: string;
}) {
  const member = summary.politician;
  if (!member) return null;
  const range = parliamentRange(member);

  return (
    <article className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <PoliticianAvatar
          displayName={member.displayName}
          partyAb={member.partyAb}
          size="md"
          photo={{
            photoUrl: member.photoUrl,
            photoLicence: member.photoLicence,
            photoAuthor: member.photoAuthor,
            photoSourceUrl: member.photoSourceUrl,
          }}
        />
        <div className="min-w-0 flex-1">
          <Link
            href={`/politicians/${member.slug}`}
            className="text-base font-medium hover:underline"
          >
            {member.displayName}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <SeriesChip
              color={color}
              partyAb={member.partyAb}
              note={colorNote}
            />
            <span className="text-[11px] text-muted-foreground">
              {memberRole(member)}
            </span>
          </div>
          {range ? (
            <p className="mt-1 text-[11px] text-muted-foreground">{range}</p>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <CountTile count={totalDeclared(summary)} label="declared entries now" />
        <CountTile
          count={summary.distinctCompanyCount}
          label="ASX-listed companies"
        />
        {/*
          ITEM-3 ROWS, NOT PROPERTIES. This counts currently-declared real-estate
          ENTRIES on the form. Only a minority of them resolve to an ABS suburb,
          so it is a floor on what was declared and must never be rendered as
          "owns N properties".
        */}
        <CountTile count={summary.propertyCount} label="real-estate entries" />
        <CountTile count={summary.liabilityCount} label="liabilities entries" />
        <CountTile
          count={summary.giftsTravelCount}
          label="gifts and sponsored travel"
        />
        <CountTile
          count={summary.changes90d}
          label="register changes, 90 days"
        />
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------- tables */

function CurrentlyDeclared({ current }: { current: boolean }) {
  return (
    <span className="text-[11px] text-muted-foreground">
      {current ? "Currently declared" : "Previously declared"}
    </span>
  );
}

function HolderList({ holders }: { holders: HolderCount["holder"][] }) {
  if (holders.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {holders.map((holder, index) => (
        <HolderBadge key={`${String(holder)}-${index}`} holder={holder} />
      ))}
    </span>
  );
}

function SharedCompanies({
  rows,
  nameA,
  nameB,
}: {
  rows: SharedCompany[];
  nameA: string;
  nameB: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No ASX-listed company appears in both members&rsquo; declarations in the
        documents we have read.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">
          ASX-listed companies appearing in the declarations of both {nameA} and{" "}
          {nameB}, with whose interest each row records and whether it is
          currently declared.
        </caption>
        <thead>
          <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Company
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Industry
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              {nameA}
            </th>
            <th scope="col" className="py-1.5 font-medium">
              {nameB}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.stockCode} className="border-b last:border-0 align-top">
              <th scope="row" className="py-2 pr-3 text-left font-normal">
                <Link href={`/shorts/${row.stockCode}`} className="hover:underline">
                  <span className="font-medium">{row.stockCode}</span>
                </Link>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {row.companyName}
                </span>
              </th>
              <td className="py-2 pr-3 text-[11px] text-muted-foreground">
                {row.industry || "Industry not recorded"}
              </td>
              <td className="py-2 pr-3">
                <span className="flex flex-col gap-1">
                  <HolderList holders={row.holdersA} />
                  <CurrentlyDeclared current={row.currentlyDeclaredA} />
                </span>
              </td>
              <td className="py-2">
                <span className="flex flex-col gap-1">
                  <HolderList holders={row.holdersB} />
                  <CurrentlyDeclared current={row.currentlyDeclaredB} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OnlyList({
  title,
  rows,
  moreFromServer,
}: {
  title: string;
  rows: OnlyCompany[];
  moreFromServer: number;
}) {
  const shown = rows.slice(0, DIFFERENCE_CAP);
  // The response is already capped, so the tail is what we trimmed locally PLUS
  // what the API trimmed before sending. Reporting only one of the two would
  // understate the list.
  const more = rows.length - shown.length + Math.max(0, moreFromServer);

  return (
    <div className="space-y-2 rounded-lg border bg-card p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {shown.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Nothing in the documents we have read.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((row) => (
            <li key={row.stockCode} className="flex flex-wrap items-baseline gap-x-2">
              <Link
                href={`/shorts/${row.stockCode}`}
                className="text-sm font-medium hover:underline"
              >
                {row.stockCode}
              </Link>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {row.companyName}
              </span>
              <HolderList holders={row.holders} />
              <CurrentlyDeclared current={row.currentlyDeclared} />
            </li>
          ))}
        </ul>
      )}
      {more > 0 ? (
        <p className="text-[11px] tabular-nums text-muted-foreground">
          +{more} more
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- the island */

export function ComparePanel() {
  const router = useRouter();
  const params = useSearchParams();

  const initialA = params.get("a")?.trim() ?? "";
  const initialB = params.get("b")?.trim() ?? "";

  const [slugA, setSlugA] = useState(initialA);
  const [slugB, setSlugB] = useState(initialB);
  const [nameA, setNameA] = useState("");
  const [nameB, setNameB] = useState("");
  const [data, setData] = useState<CompareResponse | null>(null);
  // Seeded from the URL rather than defaulting to "idle": a deep link arrives
  // with both slugs and no data, and an "idle" first paint would flash the
  // "could not be loaded" copy for one frame before the fetch effect runs.
  const [status, setStatus] = useState<"idle" | "loading" | "unavailable">(() =>
    initialA && initialB && initialA !== initialB ? "loading" : "idle",
  );

  // Mirror the selection into the URL so a comparison is shareable. Replace,
  // not push, so the back button leaves the page rather than walking every
  // intermediate pairing.
  useEffect(() => {
    const next = new URLSearchParams();
    if (slugA) next.set("a", slugA);
    if (slugB) next.set("b", slugB);
    const qs = next.toString();
    router.replace(qs ? `/politicians/compare?${qs}` : "/politicians/compare", {
      scroll: false,
    });
  }, [slugA, slugB, router]);

  const samePerson = Boolean(slugA) && slugA === slugB;

  useEffect(() => {
    if (!slugA || !slugB || slugA === slugB) {
      setData(null);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    comparePoliticiansClient(slugA, slugB)
      .then((response) => {
        if (cancelled) return;
        if (!response?.a?.politician || !response?.b?.politician) {
          setData(null);
          setStatus("unavailable");
          return;
        }
        setData(response);
        setStatus("idle");
        setNameA(response.a.politician.displayName);
        setNameB(response.b.politician.displayName);
      })
      .catch(() => {
        if (!cancelled) setStatus("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [slugA, slugB]);

  const swap = useCallback(() => {
    setSlugA(slugB);
    setSlugB(slugA);
    setNameA(nameB);
    setNameB(nameA);
    setData(null);
    // Same one-frame reason as the seeded initial status above.
    setStatus("loading");
  }, [slugA, slugB, nameA, nameB]);

  const summaryA = data?.a;
  const summaryB = data?.b;
  const memberA = summaryA?.politician;
  const memberB = summaryB?.politician;

  /*
   * TWO SERIES COLOURS, AND THE SAME-PARTY FALLBACK.
   *
   * Party identity does the colouring, which is why the header chips and the
   * chart legends carry the same swatch. Two members of one party would get one
   * colour and two polygons nobody could tell apart, so the second side falls
   * back to a neutral slate and the legend says so.
   */
  const series = useMemo(() => {
    const abA = memberA?.partyAb ?? "";
    const abB = memberB?.partyAb ?? "";
    const colorA = partyColorFromAb(abA);
    const sameParty = partyLabel(abA) === partyLabel(abB);
    return {
      colorA,
      colorB: sameParty ? SAME_PARTY_FALLBACK : partyColorFromAb(abB),
      sameParty,
    };
  }, [memberA?.partyAb, memberB?.partyAb]);

  const displayA = memberA?.displayName ?? nameA;
  const displayB = memberB?.displayName ?? nameB;

  /*
   * The names the charts label their series with. When both sides share a party
   * the colour alone cannot say which polygon is whose, so the legend names
   * carry the mapping instead of leaving it to be inferred.
   */
  const seriesNameA = memberA
    ? `${displayA} (${partyLabel(memberA.partyAb)})`
    : displayA;
  const seriesNameB = memberB
    ? `${displayB} (${partyLabel(memberB.partyAb)}${series.sameParty ? ", shown in slate" : ""})`
    : displayB;

  const categoryRows = useMemo(() => {
    if (!summaryA || !summaryB) return [];
    const itemNos = [
      ...new Set(
        [...summaryA.itemCounts, ...summaryB.itemCounts].map((c) => c.itemNo),
      ),
    ].sort((x, y) => x - y);
    return itemNos
      .map((itemNo) => ({
        label: registerItem(itemNo)?.label ?? `Item ${itemNo}`,
        countA: countForItem(summaryA.itemCounts, itemNo),
        countB: countForItem(summaryB.itemCounts, itemNo),
      }))
      .filter((row) => row.countA > 0 || row.countB > 0);
  }, [summaryA, summaryB]);

  const radarAxes = useMemo(() => {
    if (!summaryA || !summaryB) return [];
    return CATEGORY_GROUPS.map((group) => ({
      label: group.label,
      countA: group.items.reduce(
        (sum, itemNo) => sum + countForItem(summaryA.itemCounts, itemNo),
        0,
      ),
      countB: group.items.reduce(
        (sum, itemNo) => sum + countForItem(summaryB.itemCounts, itemNo),
        0,
      ),
    })).filter((axis) => axis.countA > 0 || axis.countB > 0);
  }, [summaryA, summaryB]);

  const holderRows = useMemo(() => {
    if (!data) return [];
    return HOLDER_ORDER.map((entry) => ({
      label: entry.label,
      countA: countForHolder(data.holderCountsA, entry.holder),
      countB: countForHolder(data.holderCountsB, entry.holder),
    })).filter((row) => row.countA > 0 || row.countB > 0);
  }, [data]);

  const facts = useMemo(() => {
    if (!data || !summaryA || !summaryB) return [];
    const shared = data.sharedCompanies.length;
    const onlyA = data.onlyACompanies.length + Math.max(0, data.onlyAMore);
    const onlyB = data.onlyBCompanies.length + Math.max(0, data.onlyBMore);
    const out: { text: string }[] = [
      {
        text:
          shared === 1
            ? "1 ASX-listed company appears in both members' declarations."
            : `${shared} ASX-listed companies appear in both members' declarations.`,
      },
      {
        text: `${displayA} declares ${summaryA.distinctCompanyCount} distinct ASX-listed ${
          summaryA.distinctCompanyCount === 1 ? "company" : "companies"
        }; ${displayB} declares ${summaryB.distinctCompanyCount}.`,
      },
      {
        text: `${onlyA} ${onlyA === 1 ? "company appears" : "companies appear"} only in ${displayA}'s declarations, and ${onlyB} only in ${displayB}'s.`,
      },
    ];
    const undated = summaryA.undatedCount + summaryB.undatedCount;
    if (undated > 0) {
      out.push({
        text: `${undated} ${undated === 1 ? "entry carries" : "entries carry"} no stated date across the two registers, so no timeline is drawn for them.`,
      });
    }
    return out;
  }, [data, summaryA, summaryB, displayA, displayB]);

  const asAt = toDate(data?.asAt);

  /* ------------------------------------------------------------ empty states */

  const pickers = (
    <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
      <MemberPicker
        side="A"
        label="First member"
        selectedName={displayA}
        onSelect={(hit) => {
          setSlugA(hit.slug);
          setNameA(hit.display_name);
        }}
        onClear={() => {
          setSlugA("");
          setNameA("");
          setData(null);
        }}
      />
      <button
        type="button"
        onClick={swap}
        disabled={!slugA && !slugB}
        aria-label="Swap the two members"
        className="h-11 rounded-md border px-3 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40"
      >
        Swap
      </button>
      <MemberPicker
        side="B"
        label="Second member"
        selectedName={displayB}
        onSelect={(hit) => {
          setSlugB(hit.slug);
          setNameB(hit.display_name);
        }}
        onClear={() => {
          setSlugB("");
          setNameB("");
          setData(null);
        }}
      />
    </div>
  );

  let body: ReactNode = null;

  if (samePerson) {
    body = (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        Both fields name the same member. Choose a second parliamentarian to see
        the two sets of declarations beside each other.
      </p>
    );
  } else if (!slugA || !slugB) {
    body = (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        Choose two parliamentarians and this page will show what each of them
        declares: the register categories they use, the ASX-listed companies
        that appear in both sets of declarations, and the ones that appear in
        only one. Everything here is a count of entries on a form — the
        registers record no quantity and no value, so there is nothing to add up
        and nothing to rank.
      </p>
    );
  } else if (status === "loading") {
    body = (
      <div className="space-y-3" aria-live="polite">
        <div className="h-40 animate-pulse rounded-lg bg-muted" />
        <p className="text-xs text-muted-foreground">Loading declarations…</p>
      </div>
    );
  } else if (status === "unavailable" || !data || !summaryA || !summaryB) {
    body = (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        This comparison could not be loaded right now. Nothing is missing from
        the register — each member&rsquo;s own page still lists everything we
        have read for them.
      </p>
    );
  } else {
    body = (
      <div className="space-y-10">
        <section className="grid gap-4 md:grid-cols-2">
          <MemberCard summary={summaryA} color={series.colorA} />
          <MemberCard
            summary={summaryB}
            color={series.colorB}
            colorNote={series.sameParty ? "shown in slate" : undefined}
          />
        </section>

        <section className="space-y-3">
          <h2 className={sectionTitle}>Entries by register category</h2>
          <p className="text-sm text-muted-foreground">
            The register has fourteen numbered items and each bar counts the
            entries currently declared under one of them. A bar is a number of
            form entries and nothing else — not a quantity, not a value, and not
            a total that can be compared across categories.
          </p>
          {categoryRows.length > 0 ? (
            <CompareBars
              rows={categoryRows}
              colorA={series.colorA}
              colorB={series.colorB}
              nameA={seriesNameA}
              nameB={seriesNameB}
            />
          ) : (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              Neither member has a current entry in the documents we have read.
            </p>
          )}
        </section>

        {radarAxes.length > 0 ? (
          <section className="space-y-3">
            <h2 className={sectionTitle}>The same counts, grouped</h2>
            <p className="text-sm text-muted-foreground">
              The fourteen items folded into eight groups, drawn on a square-root
              axis so a large group does not flatten the small ones. Same
              numbers as the bars above, at a coarser grain.
            </p>
            <div className="max-w-xl">
              <CompareRadar
                axes={radarAxes}
                colorA={series.colorA}
                colorB={series.colorB}
                nameA={seriesNameA}
                nameB={seriesNameB}
              />
            </div>
          </section>
        ) : null}

        {holderRows.length > 0 ? (
          <section className="space-y-3">
            <h2 className={sectionTitle}>Whose interest each entry records</h2>
            <p className="text-sm text-muted-foreground">
              The register asks members to declare interests held by themselves,
              by a spouse or partner, and by a dependent child. Where the form a
              row was lodged on has no holder column, it is counted as not
              stated; we do not infer one.
            </p>
            <CompareBars
              rows={holderRows}
              colorA={series.colorA}
              colorB={series.colorB}
              nameA={seriesNameA}
              nameB={seriesNameB}
            />
          </section>
        ) : null}

        <section className="space-y-3">
          <h2 className={sectionTitle}>Companies in both sets of declarations</h2>
          <p className="text-sm text-muted-foreground">
            ASX-listed companies that appear in the declarations of both members.
            A company is listed here because both registers name it, which says
            nothing about when either interest began or how either arose.
          </p>
          <SharedCompanies
            rows={data.sharedCompanies}
            nameA={displayA}
            nameB={displayB}
          />
        </section>

        <section className="space-y-3">
          <h2 className={sectionTitle}>Companies in only one</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <OnlyList
              title={`Only in ${displayA}'s declarations`}
              rows={data.onlyACompanies}
              moreFromServer={data.onlyAMore}
            />
            <OnlyList
              title={`Only in ${displayB}'s declarations`}
              rows={data.onlyBCompanies}
              moreFromServer={data.onlyBMore}
            />
          </div>
        </section>

        {facts.length > 0 ? <KeyFacts facts={facts} /> : null}

        <section className="space-y-3">
          <h2 className={sectionTitle}>What has been read, for each member</h2>
          {/*
            THE MOST IMPORTANT PARAGRAPH ON THE PAGE. Two members' registers are
            not read to the same depth, and a difference in a count can be a
            difference in what we have extracted rather than in what was
            declared. Saying so plainly is the only thing that makes the panels
            above safe to publish.
          */}
          <p className="text-sm text-muted-foreground">
            We have not extracted every register document for every parliament.
            Where one member&rsquo;s parliaments have been read and the
            other&rsquo;s have not, the counts above are not like-for-like: a
            difference between them may be a difference in our coverage rather
            than in what was declared. Read each member&rsquo;s coverage before
            reading anything into a gap.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <CoverageForMember
              name={displayA}
              extracted={data.extractedParliamentsA}
              partial={data.partialParliamentsA}
              pending={data.pendingParliamentsA}
              undated={summaryA.undatedCount}
            />
            <CoverageForMember
              name={displayB}
              extracted={data.extractedParliamentsB}
              partial={data.partialParliamentsB}
              pending={data.pendingParliamentsB}
              undated={summaryB.undatedCount}
            />
          </div>
        </section>

        <section className="space-y-2 border-t pt-4">
          <SourceLine asAt={asAt} surface="politician comparison" />
          {data.sourceLicence ? (
            <p className="text-[11px] text-muted-foreground">
              Licence: {data.sourceLicence}. Every figure above is a count of
              entries in the registers.
            </p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            <Link
              href={`/politicians/${memberA?.slug ?? ""}`}
              className="underline decoration-dotted hover:text-foreground"
            >
              {displayA}&rsquo;s full declarations
            </Link>
            {" · "}
            <Link
              href={`/politicians/${memberB?.slug ?? ""}`}
              className="underline decoration-dotted hover:text-foreground"
            >
              {displayB}&rsquo;s full declarations
            </Link>
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {pickers}
      {body}
    </div>
  );
}

function CoverageForMember({
  name,
  extracted,
  partial,
  pending,
  undated,
}: {
  name: string;
  extracted: number[];
  partial: number[];
  pending: number[];
  undated: number;
}) {
  const hasCoverage =
    extracted.length > 0 || partial.length > 0 || pending.length > 0;

  return (
    <div className="rounded-md border border-muted-foreground/20 bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
      <p className="font-medium text-foreground/80">{name}</p>
      {hasCoverage ? (
        <p className="mt-1">
          {extracted.length > 0 ? (
            <>
              Read in full: the <strong>{parliamentList(extracted)}</strong>{" "}
              {extracted.length === 1 ? "Parliament" : "Parliaments"}.{" "}
            </>
          ) : null}
          {partial.length > 0 ? (
            <>
              Read in part: the <strong>{parliamentList(partial)}</strong>{" "}
              {partial.length === 1 ? "Parliament" : "Parliaments"} — this
              member&rsquo;s own document may be among those still unread.{" "}
            </>
          ) : null}
          {pending.length > 0 ? (
            <>
              Not yet extracted: the <strong>{parliamentList(pending)}</strong>{" "}
              {pending.length === 1 ? "Parliament" : "Parliaments"}.{" "}
            </>
          ) : null}
        </p>
      ) : (
        <p className="mt-1">
          Coverage for this member is not recorded, so an empty category here
          means we have no entry — not that nothing was declared.
        </p>
      )}
      {undated > 0 ? (
        <p className="mt-1 tabular-nums">
          {undated} {undated === 1 ? "entry carries" : "entries carry"} no stated
          date.
        </p>
      ) : null}
    </div>
  );
}
