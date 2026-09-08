"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { OVERLAYS, overlayAvailable, type OverlayKey } from "@/lib/housing/overlays";
import { STATE_NAMES } from "@/lib/housing/states";
import { cn } from "@/lib/utils";

/**
 * The "Overlays" picker beside "Colour by". Every layer in the registry is
 * listed, including ones this state has no source for — greyed with the reason —
 * because a layer that silently vanishes reads as "no flood risk here", which
 * is the one thing this control must never imply.
 */
export function OverlayControl({
  stateCode, active, onChange,
}: {
  stateCode: string;
  active: readonly OverlayKey[];
  onChange: (next: OverlayKey[]) => void;
}) {
  const count = active.filter((k) => overlayAvailable(k, stateCode)).length;
  const toggle = (key: OverlayKey, on: boolean) => {
    const next = new Set(active);
    if (on) next.add(key); else next.delete(key);
    onChange(OVERLAYS.map((o) => o.key).filter((k) => next.has(k)));
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Choose map overlays"
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
            count > 0
              ? "border-foreground/30 bg-foreground/10 text-foreground"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          Overlays{count > 0 ? <span className="font-mono tabular-nums">({count})</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Draw on top of the map
        </div>
        <ul className="mt-2 space-y-2.5">
          {OVERLAYS.map((o) => {
            const available = overlayAvailable(o.key, stateCode);
            const id = `overlay-${o.key}`;
            return (
              <li key={o.key} className="flex items-start gap-2.5">
                <Checkbox
                  id={id}
                  checked={available && active.includes(o.key)}
                  disabled={!available}
                  onCheckedChange={(v) => toggle(o.key, v === true)}
                  className="mt-0.5"
                />
                <label htmlFor={id} className={cn("min-w-0 flex-1 cursor-pointer", !available && "cursor-not-allowed opacity-60")}>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border" style={{ background: o.color, borderColor: o.color }} />
                    {o.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground [text-wrap:pretty]">
                    {available
                      ? `${o.caveat} ${o.stateNotes?.[stateCode] ?? ""}`.trim()
                      : `No open statutory layer for ${STATE_NAMES[stateCode] ?? stateCode} yet.`}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** Legend chips for the active overlays, stacked under the colour legend. */
export function OverlayLegend({ stateCode, active }: { stateCode: string; active: readonly OverlayKey[] }) {
  const shown = OVERLAYS.filter((o) => active.includes(o.key) && overlayAvailable(o.key, stateCode));
  if (!shown.length) return null;
  return (
    <div className="pointer-events-none rounded-lg border border-border bg-card/90 px-3 py-2 shadow-sm backdrop-blur">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Overlays</div>
      <ul className="mt-1 space-y-0.5">
        {shown.map((o) => (
          <li key={o.key} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-block h-2.5 w-3.5 shrink-0 rounded-sm border" style={{ background: `${o.color}61`, borderColor: o.color }} />
            {o.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
