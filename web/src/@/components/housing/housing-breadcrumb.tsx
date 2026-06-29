"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ALL_STATES, STATE_NAMES, stateSlug } from "@/lib/housing/states";

/**
 * Housing place-trail: Australia › <state switcher> › <suburb>. The state
 * segment is a Select so you can jump laterally between states without bouncing
 * through the national page.
 */
export function HousingBreadcrumb({
  stateCode, suburb,
}: {
  stateCode?: string;
  suburb?: string;
}) {
  const router = useRouter();
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Link href="/housing" className="transition-colors hover:text-foreground">Australia</Link>
      {stateCode ? (
        <>
          <Sep />
          <Select value={stateCode} onValueChange={(c) => router.push(`/housing/${stateSlug(c)}`)}>
            <SelectTrigger
              aria-label="Switch state"
              className="h-6 gap-1 border-none bg-transparent px-1 py-0 text-xs font-medium text-foreground shadow-none hover:text-foreground focus:ring-0 focus:ring-offset-0"
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
      {suburb ? (
        <>
          <Sep />
          <span className="capitalize text-foreground">{suburb.toLowerCase()}</span>
        </>
      ) : null}
    </nav>
  );
}

function Sep() {
  return <span aria-hidden className="text-muted-foreground/60">›</span>;
}
