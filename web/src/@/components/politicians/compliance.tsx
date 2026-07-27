/**
 * The compliance kit for every politician surface.
 *
 * Built FIRST and deliberately: these components make
 * docs/influence-editorial-standards.md rules 1, 5 and 8 true by construction
 * rather than by remembering them on each new surface.
 *
 *   rule 1  every figure links to its source with an as-at date  -> SourceLine
 *   rule 5  what is held, never quantity or value                -> CaveatNote
 *   rule 8  a "report an error" affordance on every surface      -> SourceLine
 *
 * The copy here is reviewed once and then frozen. editorial-copy.test.ts asserts
 * the exact holder labels and bans accusatory verbs across this directory.
 */

import Link from "next/link";
import { Flag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { partyColorFromAb, partyLabel } from "@/lib/politics/party-palette";
import { REPORT_ERROR_EMAIL } from "@/lib/report-error";
import { registerItem } from "@/lib/politics/register-items";
import { RegisterHolder } from "~/gen/shorts/v1alpha1/politicians_pb";

/** Exact holder copy. Locked by test — never paraphrase these. */
const HOLDER_COPY: Record<number, { label: string; title: string }> = {
  [RegisterHolder.SELF]: {
    label: "Self",
    title: "Declared in the member's own name.",
  },
  [RegisterHolder.SPOUSE_PARTNER]: {
    label: "Spouse/partner",
    title:
      "Declared by the member as an interest of their spouse or partner, as the register requires.",
  },
  [RegisterHolder.DEPENDENT_CHILDREN]: {
    label: "Dependent child",
    title:
      "Declared by the member as an interest of a dependent child, as the register requires.",
  },
  // Say so rather than render nothing.
  //
  // 2,279 published rows carry no holder, almost all of them from the 46th and
  // 47th Parliament alteration forms, whose two-column "Item | Details" layout
  // has no holder column at all. Rendering no chip put them beside rows chipped
  // "Self", under the member's own name and a heading reading "Declared company
  // interests" — so the page implied they were the member's own.
  //
  // The wording is deliberately about THIS row's form, not about alterations in
  // general: 48th-Parliament alteration forms DO record a holder, and 1,021 of
  // 1,022 of those rows are attributed.
  [RegisterHolder.UNSPECIFIED]: {
    label: "Holder not stated",
    title:
      "The register form this was lodged on does not record whose interest it is. We do not infer one.",
  },
};

/**
 * Whose interest a row records.
 *
 * Muted outline only — NEVER a warning colour or icon. Editorial rule 2 covers
 * iconography, and a warning badge next to a family member is an accusation.
 */
export function HolderBadge({ holder }: { holder: RegisterHolder }) {
  const copy = HOLDER_COPY[holder];
  if (!copy) return null;
  return (
    <Badge
      variant="outline"
      title={copy.title}
      className="border-muted-foreground/30 text-muted-foreground font-normal text-[10px] px-1.5 py-0"
    >
      {copy.label}
    </Badge>
  );
}

/**
 * Which of the register's 14 items a row came from.
 *
 * The emoji is aria-hidden and the label carries the meaning, so a screen reader
 * hears "Gift", not "wrapped present Gift". The form's own wording is the
 * tooltip — that is what lets a reader find the row on the original PDF.
 */
export function RegisterItemTag({ itemNo, className }: { itemNo?: number; className?: string }) {
  const item = registerItem(itemNo);
  if (!item) return null;
  return (
    <span
      className={cn(
        "text-muted-foreground inline-flex items-center gap-1 text-[10px] whitespace-nowrap",
        className,
      )}
      title={item.formLabel}
    >
      <span aria-hidden>{item.emoji}</span>
      {item.label}
    </span>
  );
}

export function PartyChip({ partyAb, className }: { partyAb?: string; className?: string }) {
  if (!partyAb) return null;
  const label = partyLabel(partyAb);
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}
      title={label}
    >
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: partyColorFromAb(partyAb) }}
      />
      {label}
    </span>
  );
}

export function ReportErrorLink({ surface }: { surface: string }) {
  const subject = encodeURIComponent(`Register of Interests data — ${surface}`);
  return (
    <a
      href={`mailto:${REPORT_ERROR_EMAIL}?subject=${subject}`}
      className="inline-flex items-center gap-1 hover:text-foreground underline decoration-dotted"
    >
      <Flag className="h-3 w-3" aria-hidden />
      Report an error
    </a>
  );
}

function formatAsAt(date?: Date): string {
  if (!date) return "";
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * The one attribution line, used on every surface.
 *
 * Links the ORIGINAL aph.gov.au PDF. We never rehost the source documents — the
 * licence permits extracted facts with attribution, not a mirror.
 */
export function SourceLine({
  asAt,
  pdfUrl,
  surface,
  className,
}: {
  asAt?: Date;
  pdfUrl?: string;
  surface: string;
  className?: string;
}) {
  return (
    <p className={cn("text-[11px] leading-relaxed text-muted-foreground", className)}>
      Register of Members&rsquo; Interests / Register of Senators&rsquo; Interests, Parliament of
      Australia
      {asAt ? <> — as at {formatAsAt(asAt)}</> : null}.{" "}
      {pdfUrl ? (
        <>
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground underline decoration-dotted"
          >
            Original PDF
          </a>
          {" · "}
        </>
      ) : null}
      <ReportErrorLink surface={surface} />
    </p>
  );
}

/**
 * What kind of thing a declaration names, for the kinds that can never carry a
 * ticker. `listed` and `not_an_entity` are absent on purpose: the first is the
 * only case the "not matched to an ASX listing" line was written for, and the
 * second never reaches a read surface.
 *
 * These describe the VEHICLE the member named, in the register's own vocabulary.
 * They say nothing about size, and nothing about anyone's conduct.
 */
const ENTITY_KIND_COPY: Record<string, { label: string; title: string }> = {
  private_company: {
    label: "Private company",
    title: "A proprietary company. Private companies are not on the ASX, so there is no ticker.",
  },
  family_trust: {
    label: "Family trust",
    title: "A family trust. Trusts are not on the ASX, so there is no ticker.",
  },
  smsf: {
    label: "Self-managed super fund",
    title: "A self-managed superannuation fund. These are not on the ASX, so there is no ticker.",
  },
  managed_fund: {
    label: "Managed fund",
    title: "An unlisted managed fund. Unlisted funds are not on the ASX, so there is no ticker.",
  },
  foreign: {
    label: "Foreign listing",
    title: "A company listed outside Australia, so it has no ASX ticker.",
  },
};

/**
 * A declared entity.
 *
 * Resolved -> a link to the stock page. Otherwise the member's own words and no
 * link, described by WHAT THE THING IS.
 *
 * The "not matched to an ASX listing" line is kept for entity_kind='listed'
 * only, which is the case it was written for: a company we could not match by an
 * exact normalised name, a member-stated ticker or a curated alias. Saying it
 * about a family trust reported a failure that never happened — a trust cannot
 * have a ticker — and left a reader unable to tell the two apart.
 */
export function DeclaredEntity({
  declaredText,
  stockCode,
  companyName,
  entityKind,
}: {
  declaredText: string;
  stockCode?: string;
  companyName?: string;
  entityKind?: string;
}) {
  if (stockCode) {
    return (
      <Link href={`/shorts/${stockCode}`} className="hover:underline">
        <span className="font-medium">{stockCode}</span>
        {companyName ? <span className="text-muted-foreground"> · {companyName}</span> : null}
      </Link>
    );
  }

  const kind = entityKind ? ENTITY_KIND_COPY[entityKind] : undefined;
  if (kind) {
    return (
      <span className="text-muted-foreground inline-flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px]">{declaredText}</span>
        <Badge
          variant="outline"
          title={kind.title}
          className="border-muted-foreground/30 text-muted-foreground font-normal text-[10px] px-1.5 py-0"
        >
          {kind.label}
        </Badge>
      </span>
    );
  }

  // The apology requires an EXPLICIT 'listed', never a fallthrough.
  //
  // Only items 1 (shareholdings) and 4 (directorships) are ever classified —
  // they are the only items with a security candidate. Everything else arrives
  // unclassified, and treating "unclassified" as "listed" claimed we had tried
  // and failed to match 666 superannuation accounts, family trusts and gifts to
  // an ASX listing. Nothing about "REST superannuation fund" or a Qantas lounge
  // membership was ever a match attempt, so there is no failure to report.
  if (entityKind !== "listed") {
    return <span className="text-muted-foreground font-mono text-[11px]">{declaredText}</span>;
  }

  return (
    <span
      className="text-muted-foreground"
      title="We link a declaration to a listed company only on an exact normalised name match, a ticker the member stated, or a human-verified alias."
    >
      <span className="font-mono text-[11px]">{declaredText}</span>
      <span className="text-[11px]"> — not matched to an ASX listing</span>
    </span>
  );
}

/** A declared property location. Suburb granularity only — by design. */
export function DeclaredLocation({
  declaredText,
  suburbName,
  stateCode,
  salCode,
  href,
}: {
  declaredText: string;
  suburbName?: string;
  stateCode?: string;
  salCode?: string;
  href?: string;
}) {
  if (salCode && href && suburbName) {
    return (
      <Link href={href} className="hover:underline">
        <span className="font-medium">{suburbName}</span>
        {stateCode ? <span className="text-muted-foreground"> {stateCode}</span> : null}
      </Link>
    );
  }
  return (
    <span className="text-muted-foreground" title="This location does not map to a single ABS suburb.">
      <span className="font-mono text-[11px]">{declaredText}</span>
    </span>
  );
}

/**
 * When a declaration started.
 *
 * An unknown start stays unknown. Most base statements carry no date (the form
 * puts it in a signature block), so substituting the parliament's opening would
 * fabricate the start of a named person's holding.
 */
export function DeclaredPeriod({
  from,
  fromKnown,
  to,
  currentlyDeclared,
}: {
  from?: Date;
  fromKnown: boolean;
  to?: Date;
  currentlyDeclared: boolean;
}) {
  const fmt = (d?: Date) =>
    d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";

  if (!fromKnown || !from) {
    return (
      <span
        className="text-[11px] text-muted-foreground"
        title="The register entry carries no lodgement date, so the start of this declaration is unknown. We do not infer one."
      >
        {currentlyDeclared ? "Declared; start date not stated" : `Removed ${fmt(to)}`}
      </span>
    );
  }
  return (
    <span className="text-[11px] text-muted-foreground">
      {currentlyDeclared ? `Declared since ${fmt(from)}` : `${fmt(from)} – ${fmt(to)}`}
    </span>
  );
}

/** Render "44th and 45th" / "44th, 45th and 46th" from parliament numbers. */
function parliamentList(numbers: number[]): string {
  const ordinals = numbers.map((n) => `${n}th`);
  if (ordinals.length <= 1) return ordinals[0] ?? "";
  return `${ordinals.slice(0, -1).join(", ")} and ${ordinals[ordinals.length - 1]}`;
}

/**
 * What we have actually read.
 *
 * The register corpus is discovered long before it is parsed — the 44th and 45th
 * Parliaments are scanned images awaiting the vision tier. Without this note an
 * empty section reads as "this member declared nothing", which is an absence
 * claim about a named individual that the data does not support.
 *
 * Renders nothing when there is no gap: a caveat that is always present stops
 * being read.
 */
export function CoverageNote({
  extracted,
  partial = [],
  pending,
}: {
  extracted: number[];
  partial?: number[];
  pending: number[];
}) {
  if (extracted.length === 0 && partial.length === 0 && pending.length === 0) return null;

  const incomplete = partial.length > 0 || pending.length > 0;

  return (
    <p className="rounded-md border border-muted-foreground/20 bg-muted/30 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
      {extracted.length > 0 ? (
        <>
          This page covers the <strong>{parliamentList(extracted)}</strong>{" "}
          {extracted.length === 1 ? "Parliament" : "Parliaments"} in full.{" "}
        </>
      ) : null}
      {/* Partial is its OWN state, never folded into "covered". A parliament
          where half the documents parsed cannot support an absence claim about
          any individual member, because we may simply not have read theirs. */}
      {partial.length > 0 ? (
        <>
          We have read <strong>only part</strong> of the{" "}
          <strong>{parliamentList(partial)}</strong>{" "}
          {partial.length === 1 ? "Parliament" : "Parliaments"} — this member&rsquo;s own document
          may be among those still unread.{" "}
        </>
      ) : null}
      {pending.length > 0 ? (
        <>
          Register documents for the <strong>{parliamentList(pending)}</strong>{" "}
          {pending.length === 1 ? "Parliament" : "Parliaments"} exist but have not been extracted
          yet.{" "}
        </>
      ) : null}
      {incomplete ? (
        <>
          An empty section below means we have no recorded entry — <strong>not</strong> that the
          member declared nothing.
        </>
      ) : null}
    </p>
  );
}

/**
 * The method note, shown at the foot of every politician surface.
 *
 * Reviewed once against rules 1-5, then frozen. If this needs to change, the
 * change re-triggers editorial review.
 */
export function CaveatNote({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-2 text-[11px] leading-relaxed text-muted-foreground", className)}>
      <p className="font-medium text-foreground/80">Method &amp; caveats</p>
      <p>
        Australian federal parliamentarians must declare certain interests in the Register of
        Members&rsquo; Interests (House of Representatives) and the Register of Senators&rsquo;
        Interests. For holdings — shares, real estate, trusts, liabilities, assets — the registers
        record <strong>what</strong> is held and do <strong>not</strong> record quantity, value,
        purchase price or income. Nothing on this page states or implies the size of any holding,
        any gain or loss, or any trading activity.
      </p>
      <p>
        Two items are different, because the form itself asks for a value: gifts and sponsored
        travel. Where a member stated an amount there, it appears as they wrote it. That figure is
        the declared value of a gift or a trip — never the size of a holding, and never a total.
      </p>
      <p>
        Dates are the dates a declaration appeared in, or was removed from, the register — not
        transaction dates. A removal can mean an asset was disposed of, a declaration was corrected,
        or the member left parliament.
      </p>
      <p>
        Company names are free text as written by the member. We link a declaration to an ASX listing
        only on an exact normalised match, a ticker the member stated, or a human-verified alias, so
        many declarations appear as text only. Real-estate declarations are suburb- or area-level;
        the registers contain no street addresses, and some declared locations do not map to a single
        ABS suburb.
      </p>
      <p>
        Rows are declared as held by the member (&ldquo;Self&rdquo;), their spouse or partner, or a
        dependent child, exactly as the register records them. Members&rsquo; seats, parties and
        chambers change between parliaments.
      </p>
      <p>
        Extracted from primary PDFs published by the Parliament of Australia; parliamentary material,
        &copy; Commonwealth of Australia.{" "}
        {/* Rule 7 needs a destination, not just a promise. */}
        <Link
          href="/disclaimer#corrections"
          className="hover:text-foreground underline decoration-dotted"
        >
          Corrections are annotated, not silently applied
        </Link>
        . Not financial advice.
      </p>
    </div>
  );
}

/**
 * The mandatory caveat for any surface pairing a member with short interest.
 *
 * The API serves this string in `disclosure_note`; this renders whatever it sent
 * rather than restating it, so the wording lives in one place.
 */
export function ShortInterestCaveat({ note }: { note?: string }) {
  if (!note) return null;
  return (
    <p className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-[11px] leading-relaxed text-muted-foreground">
      {note}
    </p>
  );
}
