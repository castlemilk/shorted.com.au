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
import { partyLabel } from "@/lib/politics/party-palette";
import {
  SENATE_REGISTER_GAP,
  senateParliaments,
  splitCoverageByChamber,
  type CoverageTerm,
} from "@/lib/politics/register-coverage";
import { REPORT_ERROR_EMAIL } from "@/lib/report-error";
import { registerItem } from "@/lib/politics/register-items";
import { HOLDER_ICON, registerItemIcon } from "@/lib/politics/register-item-icons";
import { PoliticsIcon } from "@/components/politicians/politics-icon";
import { PartyMark } from "@/components/politicians/party-mark";
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
 * The sprite id for each holder kind, or none.
 *
 * UNSPECIFIED IS DELIBERATELY ABSENT. "Holder not stated" is the absence of a
 * fact, and the icon set holds no glyph for one — a question mark or a blank
 * silhouette beside a named member's family would depict a gap in the FORM as a
 * gap in the declaration. The label says it in words instead, which is the only
 * rendering that cannot be misread.
 */
const HOLDER_ICON_BY_KIND: Partial<Record<number, "self" | "spouse" | "dependent">> = {
  [RegisterHolder.SELF]: "self",
  [RegisterHolder.SPOUSE_PARTNER]: "spouse",
  [RegisterHolder.DEPENDENT_CHILDREN]: "dependent",
};

/**
 * Whose interest a row records.
 *
 * Muted outline only — NEVER a warning colour or icon. Editorial rule 2 covers
 * iconography, and a warning badge next to a family member is an accusation.
 *
 * The icon is decorative and the label carries the meaning, exactly as on
 * RegisterItemTag: a screen reader hears "Spouse/partner", never a description
 * of two figures. It is NEVER icon-only — the three holder kinds are register
 * semantics about a member's family, and a glyph a reader has to decode is not
 * a thing to make them decode beside a named person.
 */
export function HolderBadge({ holder }: { holder: RegisterHolder }) {
  const copy = HOLDER_COPY[holder];
  if (!copy) return null;
  const iconKey = HOLDER_ICON_BY_KIND[holder];
  const icon = iconKey ? HOLDER_ICON[iconKey] : undefined;
  return (
    <Badge
      variant="outline"
      title={copy.title}
      className="border-muted-foreground/30 text-muted-foreground inline-flex items-center gap-1 font-normal text-[10px] px-1.5 py-0"
    >
      {icon ? <PoliticsIcon name={icon} size={12} /> : null}
      {copy.label}
    </Badge>
  );
}

/**
 * Which of the register's 14 items a row came from.
 *
 * THE SPRITE ICON, NOT THE EMOJI. `register-items.ts` still carries an emoji per
 * item — it is the taxonomy's first rendering and the operator console reads it
 * — but every reader-facing surface draws the commissioned set instead, so the
 * fourteen categories look like one another and like the housing and economy
 * sets beside them. The emoji remains only as the fallback for an item the
 * sprite has no cell for, which the manifest test makes impossible today.
 *
 * The icon is aria-hidden and the label carries the meaning, so a screen reader
 * hears "Gift", not "wrapped present Gift" — the same contract the emoji had.
 * The form's own wording is the tooltip: that is what lets a reader find the row
 * on the original PDF. Never icon-only.
 */
export function RegisterItemTag({ itemNo, className }: { itemNo?: number; className?: string }) {
  const item = registerItem(itemNo);
  if (!item) return null;
  const icon = registerItemIcon(itemNo);
  return (
    <span
      className={cn(
        "text-muted-foreground inline-flex items-center gap-1 text-[10px] whitespace-nowrap",
        className,
      )}
      title={item.formLabel}
    >
      {icon ? <PoliticsIcon name={icon} size={14} /> : <span aria-hidden>{item.emoji}</span>}
      {item.label}
    </span>
  );
}

/**
 * Derive a short label for the document a row came from: "48P", "45P".
 *
 * The parliament is not on the wire, but the APH URL encodes it twice —
 * `/Register/48p/AB/Albanese_48P.pdf`. Senate volumes are `/-/media/<GUID>.ashx`
 * and carry nothing, so they fall back to "PDF" rather than guessing.
 */
export function registerDocLabel(sourceUrl?: string): string {
  if (!sourceUrl) return "";
  const fromPath = /\/(\d{2})[pP]\//.exec(sourceUrl);
  if (fromPath) return `${fromPath[1]}P`;
  const fromFile = /[_-](\d{2})[pP]\.pdf/i.exec(sourceUrl);
  if (fromFile) return `${fromFile[1]}P`;
  return "PDF";
}

/**
 * A link to the ORIGINAL document THIS row came from.
 *
 * Editorial rule 1 is that every figure links to the document it came from. A
 * profile spans up to five parliaments and a hundred-odd documents, so a single
 * page-level link cannot satisfy that — it necessarily cites the wrong document
 * for every row but one, which is worse than citing nothing.
 *
 * Deliberately quiet: this is an affordance for a reader who wants to check a
 * specific claim, not a call to action.
 *
 * QUIET IS NOT THE SAME AS UNTAPPABLE, AND THE HIT AREA IS NOT THE INK.
 * Measured on Albanese's profile: 243 of these, at **30 x 15 px each**, against
 * a 44 px target floor — the densest cluster of undersized targets in the
 * feature, and the one where a mis-tap opens the wrong document.
 *
 * The obvious fix is padding, and it was tried and reverted: `min-h-11` plus
 * `py-3` did reach 44 px, but these sit inline at the end of a declaration row,
 * so 243 taller rows pushed the profile from 37,868 px to **44,519 px** — a 17%
 * longer page to fix a tap target, on the surface the audit already flags as
 * far too long (finding #13). Trading scroll length for hit area is a bad deal
 * when there is a version with no trade at all.
 *
 * So the target is grown with an ABSOLUTELY POSITIONED `::after` OVERLAY
 * instead. It is a child box of the anchor, so a pointer landing on it
 * dispatches to the anchor, and being out of flow it contributes NOTHING to the
 * row's height. 44 x 44, centred on the link. The visible 10 px citation is
 * untouched — which is the point: this is an affordance for a reader checking a
 * claim, not a call to action, and it should not start shouting to be tappable.
 *
 * `sm:after:hidden` drops the overlay on a pointer device, where 44 px is not
 * the relevant minimum and overlapping invisible boxes would only get in the way
 * of text selection.
 */
export function SourceDocLink({ sourceUrl }: { sourceUrl?: string }) {
  if (!sourceUrl) return null;
  const label = registerDocLabel(sourceUrl);
  return (
    <a
      href={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      title="Open the original register PDF on aph.gov.au to check this entry"
      className="text-muted-foreground hover:text-foreground relative inline-block text-[10px] underline decoration-dotted whitespace-nowrap after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] sm:after:hidden"
    >
      {label}&nbsp;↗
    </a>
  );
}

/**
 * A party, as a mark and its name.
 *
 * THE 8 px COLOUR DOT IS GONE, and the reason is legibility rather than taste:
 * the palette has more parties in it than a reader can hold apart at that size,
 * and several of the crossbench colours are a shade apart. `<PartyMark>` draws
 * the AEC abbreviation on a tile of the same palette colour, so the mark is
 * self-describing at a glance and the colour is a reinforcement rather than the
 * whole signal. It is emphatically NOT the party's own logo — see party-mark.tsx
 * for the trademark and no-endorsement reasons that is never on the table.
 *
 * The mark carries its own accessible name, so the visible label beside it is
 * hidden from assistive tech: without that a screen reader hears "Australian
 * Labor Party Australian Labor Party" on every row.
 */
export function PartyChip({ partyAb, className }: { partyAb?: string; className?: string }) {
  if (!partyAb) return null;
  const label = partyLabel(partyAb);
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
    >
      <PartyMark abbreviation={partyAb} size="sm" />
      <span aria-hidden>{label}</span>
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
  chamber,
  hasRegisterEntries = true,
  terms = [],
}: {
  extracted: number[];
  partial?: number[];
  pending: number[];
  /** 'house' | 'senate', as the register records it. */
  chamber?: string;
  /**
   * Whether this profile has ANY register row behind it. Defaults true so every
   * existing caller keeps its old behaviour; only the senate branch reads it.
   */
  hasRegisterEntries?: boolean;
  /**
   * This member's terms, so every parliament claim can be made against the
   * chamber they actually sat in for it.
   *
   * Defaults to empty, which reproduces the old behaviour exactly: with no
   * terms, no parliament is a Senate one and every bucket renders whole. The
   * hub passes none because it speaks about the CORPUS rather than about a
   * person, and the corpus is the House corpus.
   */
  terms?: readonly CoverageTerm[];
}) {
  /*
   * THE SENATE BRANCH, AND WHY IT OVERRIDES THE PARLIAMENT SENTENCES.
   *
   * The parliament lists below describe the HOUSE corpus: they are the
   * parliaments whose per-member PDFs we fetched and extracted. Printing "this
   * page covers the 46th, 47th and 48th Parliaments in full" above a senator's
   * empty page would be exactly backwards — we have read none of the Senate's
   * volumes for any of those parliaments, and the sentence would turn our gap
   * into a statement that a named senator declared nothing across three
   * parliaments.
   *
   * So a senator with no register rows gets the Senate sentence INSTEAD of the
   * House coverage sentences, and it renders whether or not the House lists are
   * complete — this branch may never return null.
   */
  if (chamber === "senate" && !hasRegisterEntries) {
    return (
      <p className="rounded-md border border-muted-foreground/20 bg-muted/30 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
        {SENATE_REGISTER_GAP}
      </p>
    );
  }

  /*
   * THE DUAL-CHAMBER CARVE-OUT, and why the branch above does not cover it.
   *
   * The branch above is all-or-nothing: a senator with no rows gets the Senate
   * sentence, and anyone with rows gets the parliament sentences. That left a
   * third case saying the wrong thing about itself. Sarah Henderson HAS
   * register rows — 142 of them, from the House, in the 44th and 45th — so she
   * took the second path and the note read "This page covers the 44th, 45th and
   * 48th Parliaments in full". She has spent the 48th entirely in the Senate.
   * We have read none of it. "In full" over that parliament is the same absence
   * claim the branch above exists to prevent, made about the same person by the
   * same paragraph.
   *
   * So the claim is made PER PARLIAMENT, against the chamber she sat in for it.
   * House parliaments keep their bucket; Senate ones leave it and are covered by
   * the Senate sentence instead, which renders whenever any of them was removed.
   * The removal is never silent — a bucket that quietly shrank would be a
   * narrower claim with no explanation attached.
   */
  const senateSet = senateParliaments(terms);
  const extractedSplit = splitCoverageByChamber(extracted, senateSet);
  const partialSplit = splitCoverageByChamber(partial, senateSet);
  const pendingSplit = splitCoverageByChamber(pending, senateSet);
  const senateCarveOut =
    extractedSplit.senate.length > 0 ||
    partialSplit.senate.length > 0 ||
    pendingSplit.senate.length > 0;
  extracted = extractedSplit.house;
  partial = partialSplit.house;
  pending = pendingSplit.house;

  if (extracted.length === 0 && partial.length === 0 && pending.length === 0 && !senateCarveOut) {
    return null;
  }

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
          member declared nothing.{" "}
        </>
      ) : null}
      {/* The parliaments removed from the buckets above, and why. Without this
          the sentences are simply narrower than they were, which reads as a
          smaller corpus rather than as a chamber we have not opened. */}
      {senateCarveOut ? <>{SENATE_REGISTER_GAP}</> : null}
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
