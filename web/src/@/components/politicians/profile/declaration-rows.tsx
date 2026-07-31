/**
 * One published register row, rendered on the SERVER.
 *
 * This is the half of the declarations surface that must never cross the client
 * boundary: it uses the frozen compliance kit (which imports the generated
 * RegisterHolder enum) and it is what puts every row into the server HTML. The
 * client island beside it takes these as opaque `content` nodes plus the plain
 * fields its filters read — see declarations-table.tsx for why.
 *
 * The row markup is unchanged from the three static lists it replaces: the
 * member's own words in mono, the holder, the register item, the declaration
 * period, and a link to the ORIGINAL document THIS row came from. Nothing here
 * states or implies an amount, because the registers record none.
 */

import type { ReactNode } from "react";

import {
  DeclaredEntity,
  DeclaredLocation,
  DeclaredPeriod,
  HolderBadge,
  RegisterItemTag,
  SourceDocLink,
} from "@/components/politicians/compliance";
import { registerItem } from "@/lib/politics/register-items";
import { stateSlug, suburbSlug } from "@/lib/housing/states";
import { toDate } from "@/lib/politics/timestamp";
import {
  RegisterHolder,
  type DeclaredInterest,
} from "~/gen/shorts/v1alpha1/politicians_pb";

import type { DeclarationRow } from "./declarations-table";

/**
 * The holder filter's serialisable keys and labels.
 *
 * THE LABELS ARE THE COMPLIANCE KIT'S, VERBATIM. HolderBadge's copy is frozen
 * and locked by editorial-copy.test.ts; a filter button that said "Partner" or
 * "Child" beside a badge saying "Spouse/partner" would be a second, unreviewed
 * vocabulary for the same register attribute. profile-declarations.test.tsx
 * asserts these four strings still appear in compliance.tsx.
 */
export const HOLDER_FILTER: Record<number, { key: string; label: string }> = {
  [RegisterHolder.SELF]: { key: "self", label: "Self" },
  [RegisterHolder.SPOUSE_PARTNER]: { key: "spouse-partner", label: "Spouse/partner" },
  [RegisterHolder.DEPENDENT_CHILDREN]: { key: "dependent-child", label: "Dependent child" },
  [RegisterHolder.UNSPECIFIED]: { key: "not-stated", label: "Holder not stated" },
};

/** Items whose declared text names a company rather than a place. */
const COMPANY_ITEMS = new Set([1, 4]);
const REAL_ESTATE_ITEM = 3;

/**
 * A category name for the tab strip.
 *
 * Falls back to the form's own label and then to an explicit "not stated" —
 * never to an invented category. An unknown item number is a gap in OUR record,
 * and it is labelled as one.
 */
function categoryLabelFor(interest: DeclaredInterest): string {
  return (
    registerItem(interest.itemNo)?.label ??
    (interest.itemLabel || "Category not stated")
  );
}

function holderFor(holder: RegisterHolder): { key: string; label: string } {
  return HOLDER_FILTER[holder] ?? HOLDER_FILTER[RegisterHolder.UNSPECIFIED]!;
}

function DeclarationRowContent({ interest }: { interest: DeclaredInterest }) {
  const period = (
    <DeclaredPeriod
      from={toDate(interest.declaredFrom)}
      fromKnown={interest.declaredFromKnown}
      to={toDate(interest.declaredTo)}
      currentlyDeclared={interest.currentlyDeclared}
    />
  );

  if (COMPANY_ITEMS.has(interest.itemNo)) {
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <DeclaredEntity
            declaredText={interest.declaredText}
            stockCode={interest.stockCode}
            companyName={interest.companyName}
            entityKind={interest.entityKind}
          />
          <HolderBadge holder={interest.holder} />
          <RegisterItemTag itemNo={interest.itemNo} />
          <SourceDocLink sourceUrl={interest.sourceUrl} />
        </div>
        {period}
      </>
    );
  }

  if (interest.itemNo === REAL_ESTATE_ITEM) {
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <DeclaredLocation
            declaredText={interest.declaredText}
            suburbName={interest.suburbName}
            stateCode={interest.propertyState}
            salCode={interest.salCode}
            href={
              interest.salCode && interest.suburbName && interest.propertyState
                ? `/housing/${stateSlug(interest.propertyState)}/${suburbSlug(interest.suburbName, "")}?sal=${interest.salCode}`
                : undefined
            }
          />
          <HolderBadge holder={interest.holder} />
          <RegisterItemTag itemNo={interest.itemNo} />
          {interest.secondaryText ? (
            <span className="text-[11px] text-muted-foreground">{interest.secondaryText}</span>
          ) : null}
          <SourceDocLink sourceUrl={interest.sourceUrl} />
        </div>
        {period}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {/* The member's own words, verbatim. The registers are CC BY-NC-ND, so a
            declared string is stored and shown as written, never rewritten. */}
        <span className="font-mono text-[11px] text-muted-foreground">
          {interest.declaredText}
        </span>
        <HolderBadge holder={interest.holder} />
        <RegisterItemTag itemNo={interest.itemNo} />
        <SourceDocLink sourceUrl={interest.sourceUrl} />
      </div>
      {interest.secondaryText ? (
        <span className="text-[11px] text-muted-foreground">{interest.secondaryText}</span>
      ) : null}
      {period}
    </>
  );
}

/**
 * Every published row, grouped by register item and rendered server-side.
 *
 * Order is item number ascending, then the order the API returned — so the
 * unfiltered HTML reads as the three static lists did, category by category,
 * and the island's filtered views inherit that order rather than inventing one.
 */
export function buildDeclarationRows(interests: DeclaredInterest[]): DeclarationRow[] {
  return interests
    .map((interest, index) => ({ interest, index }))
    .sort((a, b) => a.interest.itemNo - b.interest.itemNo || a.index - b.index)
    .map(({ interest, index }): DeclarationRow => {
      const categoryLabel = categoryLabelFor(interest);
      const holder = holderFor(interest.holder);
      const haystack = [
        interest.declaredText,
        interest.secondaryText,
        interest.companyName,
        interest.stockCode,
        interest.suburbName,
        interest.propertyState,
        categoryLabel,
        holder.label,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return {
        id: `${interest.itemNo}-${index}`,
        itemNo: interest.itemNo,
        categoryKey: String(interest.itemNo),
        categoryLabel,
        holderKey: holder.key,
        holderLabel: holder.label,
        searchText: haystack,
        content: (<DeclarationRowContent interest={interest} />) as ReactNode,
      };
    });
}
