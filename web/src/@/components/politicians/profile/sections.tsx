/**
 * The server-rendered furniture of a member's profile: the service line, the
 * industry bars, the recent-changes list and the source-document list.
 *
 * PROPS-ONLY PLAIN DATA. Every input here is a string or a number the page has
 * already derived from the rpc, so these sections carry no protobuf types and no
 * formatting decisions of their own. They are server components (the source
 * links reuse the compliance kit), and they are sections of exactly one page —
 * the profile carries the citation and the dispute affordance in its footer.
 *
 * EDITORIAL. Nothing here is coloured by outcome: a register addition and a
 * removal are the same neutral grey, because a removal is a register event and
 * not a transaction, and a green/red pair next to a named person implies a
 * judgement about which one is good.
 */

import { SourceDocLink, registerDocLabel } from "@/components/politicians/compliance";
import { AMBER_STEPS } from "@/lib/politics/analytics-palette";
import { partyLabel } from "@/lib/politics/party-palette";
import { sectionTitle } from "@/lib/typography";

export interface ProfileTerm {
  parliament: number;
  chamber: string;
  division: string;
  stateCode: string;
  partyAb: string;
}

export interface ProfileIndustryBar {
  industry: string;
  companyCount: number;
}

export interface ProfileChange {
  id: string;
  /** A register ADDITION. The alternative is a removal; there is no third kind. */
  added: boolean;
  /** Preformatted by the page — one date formatter per surface, not per card. */
  date: string;
  declaredText: string;
  itemLabel: string;
  sourceUrl?: string;
}

export interface ProfileSourceDocument {
  label: string;
  sourceUrl: string;
  parliament: number;
  chamber: string;
}

/** How many change events the rail shows before it says it is truncating. */
const MAX_RAIL_CHANGES = 10;

function ordinal(parliament: number): string {
  return `${parliament}th`;
}

function roleFor(term: ProfileTerm): string {
  if (term.chamber === "senate") {
    return term.stateCode ? `Senator for ${term.stateCode}` : "Senator";
  }
  return term.division ? `Member for ${term.division}` : "Member";
}

/**
 * Party reaches the register through an electorate join, not the APH listing, so
 * absence is real and is labelled as absence — never guessed, and never
 * flattened to "Other" the way the colour scale does.
 */
function partyFor(partyAb: string): string {
  return partyAb.trim() ? partyLabel(partyAb) : "Party not recorded";
}

function chamberLabel(chamber: string): string {
  if (chamber === "senate") return "Senate";
  if (chamber === "house") return "House of Representatives";
  return chamber;
}

/**
 * Consecutive terms that share a seat and a party, collapsed into one line.
 *
 * A member who sat for five parliaments in the same seat produces five identical
 * rows otherwise, which buries the thing the reader is looking for: WHEN
 * something changed. Only adjacent runs collapse, so a member who changed party
 * and changed back keeps both stints.
 */
export function groupTerms(terms: ProfileTerm[]): {
  from: number;
  to: number;
  role: string;
  party: string;
  chamber: string;
}[] {
  const sorted = [...terms].sort((a, b) => a.parliament - b.parliament);
  const out: { from: number; to: number; role: string; party: string; chamber: string }[] = [];
  for (const term of sorted) {
    const role = roleFor(term);
    const party = partyFor(term.partyAb);
    const last = out[out.length - 1];
    if (last && last.role === role && last.party === party && last.chamber === term.chamber) {
      last.to = term.parliament;
      continue;
    }
    out.push({
      from: term.parliament,
      to: term.parliament,
      role,
      party,
      chamber: term.chamber,
    });
  }
  return out;
}

/** The member's service, one line per stint. */
export function ServiceHistory({ terms }: { terms: ProfileTerm[] }) {
  const groups = groupTerms(terms);
  if (groups.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-[11px] text-muted-foreground">
      {groups.map((group) => (
        <li key={`${group.from}-${group.to}-${group.role}-${group.party}`}>
          <span className="tabular-nums">
            {group.from === group.to
              ? ordinal(group.from)
              : `${ordinal(group.from)}–${ordinal(group.to)}`}
          </span>{" "}
          · {group.role} · {group.party}
        </li>
      ))}
    </ul>
  );
}

/**
 * Distinct declared companies per industry, as CSS bars.
 *
 * A count of COMPANIES, not of anything held in them — the registers record no
 * quantity, so a longer bar means "more different companies named", nothing else.
 */
export function IndustryBars({ industries }: { industries: ProfileIndustryBar[] }) {
  const rows = industries.filter((row) => row.companyCount > 0);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((row) => row.companyCount), 1);
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium text-foreground">
        Declared companies by industry
      </figcaption>
      <table className="w-full text-sm">
        <caption className="sr-only">
          Distinct ASX-listed companies declared by this member, grouped by industry. A count of
          companies, not an amount.
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Industry</th>
            <th scope="col">Distinct companies</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.industry} className="border-b last:border-0">
              <th
                scope="row"
                className="w-36 max-w-36 truncate py-1.5 pr-3 text-left text-[11px] font-normal text-muted-foreground"
                title={row.industry}
              >
                {row.industry}
              </th>
              <td className="py-1.5">
                <div className="flex items-center gap-2">
                  <div
                    className="h-3 rounded-sm"
                    style={{
                      width: `${(row.companyCount / max) * 100}%`,
                      backgroundColor: AMBER_STEPS[3] ?? AMBER_STEPS[0],
                    }}
                    aria-hidden
                  />
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {row.companyCount}
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/**
 * This member's recent register events.
 *
 * "Added" and "removed" are the register's own vocabulary and are rendered
 * identically: a removal can mean an asset was disposed of, a declaration was
 * corrected, or the member left parliament, and nothing on the wire says which.
 */
export function RecentChanges({ changes }: { changes: ProfileChange[] }) {
  if (changes.length === 0) return null;
  // A rail, not a feed: the newest handful, and the truncation is stated rather
  // than silent — a list that stops without saying so reads as the whole set.
  const shown = changes.slice(0, MAX_RAIL_CHANGES);
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className={sectionTitle}>Recent register changes</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Dates are when an entry appeared in or left the register — not transaction dates.
        {changes.length > shown.length
          ? ` Showing the ${shown.length} most recent of ${changes.length} recorded changes.`
          : ""}
      </p>
      <ul className="mt-3 space-y-2.5">
        {shown.map((change) => (
          <li key={change.id} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] tabular-nums text-muted-foreground">{change.date}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {change.added ? "added" : "removed"}
              </span>
              <SourceDocLink sourceUrl={change.sourceUrl} />
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">{change.declaredText}</p>
            {change.itemLabel ? (
              <p className="text-[10px] text-muted-foreground">{change.itemLabel}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Every distinct APH document behind the rows on this page.
 *
 * We deep-link aph.gov.au and never rehost: the licence covers extracted facts
 * with attribution, not a mirror of the source PDFs.
 */
export function SourceDocuments({ documents }: { documents: ProfileSourceDocument[] }) {
  if (documents.length === 0) return null;
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className={sectionTitle}>Source documents</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        The original register documents on aph.gov.au that these entries were read from.
      </p>
      <ul className="mt-3 space-y-1.5 text-[11px]">
        {documents.map((doc) => (
          <li key={doc.sourceUrl}>
            <a
              href={doc.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground underline decoration-dotted hover:text-foreground"
            >
              {doc.label || registerDocLabel(doc.sourceUrl)}
            </a>
            {doc.parliament > 0 || doc.chamber ? (
              <span className="ml-1.5 text-muted-foreground/80">
                {[doc.parliament > 0 ? `${ordinal(doc.parliament)} Parliament` : "", chamberLabel(doc.chamber)]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
