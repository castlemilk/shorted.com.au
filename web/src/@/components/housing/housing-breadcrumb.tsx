"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ALL_STATES, STATE_NAMES, stateSlug } from "@/lib/housing/states";

/**
 * Housing place-trail: Australia › <state switcher> › [council] › <suburb>. The
 * state segment is a Select so you can jump laterally between states without
 * bouncing through the national page. The council segment links the suburb's
 * dominant council hub when it has one.
 */
export function HousingBreadcrumb({
  stateCode, council, suburb, compact = false,
}: {
  stateCode?: string;
  /** The suburb's dominant council, when it has a page (councilHref non-null). */
  council?: { name: string; href: string };
  suburb?: string;
  /**
   * Drop the "Australia ›" root below sm. In a narrow horizontal scroller the
   * root costs ~72px and pushes the segment that matters most — the page you are
   * actually on — off the visible edge. The state select still reaches every
   * state, and /housing is one more tap from there.
   */
  compact?: boolean;
}) {
  const router = useRouter();
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <Link
        href="/housing"
        className={`shrink-0 transition-colors hover:text-foreground${compact ? " hidden sm:inline" : ""}`}
      >
        Australia
      </Link>
      {stateCode ? (
        <>
          <Sep className={compact ? "hidden sm:inline" : undefined} />
          <Select value={stateCode} onValueChange={(c) => router.push(`/housing/${stateSlug(c)}`)}>
            <SelectTrigger
              aria-label="Switch state"
              className="inline-flex h-6 w-auto shrink-0 justify-start gap-1 rounded border-none bg-transparent px-1.5 py-0 text-xs font-medium text-foreground shadow-none hover:bg-muted focus:ring-0 focus:ring-offset-0 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-60"
            >
              <SelectValue>{STATE_NAMES[stateCode] ?? stateCode}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ALL_STATES.map((c) => (
                <SelectItem key={c} value={c}>{STATE_NAMES[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      ) : null}
      {council ? (
        <>
          {/* Below sm in compact mode the suburb segment matters more than
              the council; the profile's council card links it there. */}
          <Sep className={compact ? "hidden sm:inline" : undefined} />
          <Link
            href={council.href}
            className={`shrink-0 transition-colors hover:text-foreground${compact ? " hidden sm:inline" : ""}`}
          >
            {council.name}
          </Link>
        </>
      ) : null}
      {suburb ? (
        <>
          <Sep />
          <span className="text-foreground">{suburb}</span>
        </>
      ) : null}
    </nav>
  );
}

function Sep({ className }: { className?: string }) {
  return <span aria-hidden className={`text-muted-foreground/60${className ? ` ${className}` : ""}`}>›</span>;
}
