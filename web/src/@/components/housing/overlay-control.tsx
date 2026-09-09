"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { OVERLAYS, OVERLAY_FILL_OPACITY, overlayAvailable, type OverlayKey } from "@/lib/housing/overlays";
import { STATE_NAMES } from "@/lib/housing/states";
import { cn } from "@/lib/utils";

export type OverlayOpacities = Partial<Record<OverlayKey, number>>;

/**
 * The "Overlays" picker beside "Colour by". Every layer in the registry is
 * listed, including ones this state has no source for — greyed with the reason —
 * because a layer that silently vanishes reads as "no flood risk here", which
 * is the one thing this control must never imply.
 *
 * An active layer exposes an opacity slider: three translucent fills over a
 * colour ramp need per-layer weighting to stay readable, and the right value
 * depends on which metric is underneath. The slider is a native range input so
 * it works with a keyboard and a screen reader without a dependency.
 */
export function OverlayControl({
  stateCode, active, opacities, loading, onChange, onOpacityChange,
}: {
  stateCode: string;
  active: readonly OverlayKey[];
  opacities: OverlayOpacities;
  /** Keys whose geometry is still downloading. */
  loading?: readonly OverlayKey[];
  onChange: (next: OverlayKey[]) => void;
  onOpacityChange: (key: OverlayKey, opacity: number) => void;
}) {
  const available = OVERLAYS.filter((o) => overlayAvailable(o.key, stateCode)).map((o) => o.key);
  const count = active.filter((k) => available.includes(k)).length;
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
          <LayersGlyph />
          Overlays{count > 0 ? <span className="font-mono tabular-nums">({count})</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-3">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Draw on top of the map
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            {count < available.length ? (
              <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onChange(available)}>
                All
              </button>
            ) : null}
            {count > 0 ? (
              <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onChange([])}>
                Clear
              </button>
            ) : null}
          </div>
        </div>
        <ul className="mt-2 space-y-3">
          {OVERLAYS.map((o) => {
            const isAvailable = available.includes(o.key);
            const isActive = isAvailable && active.includes(o.key);
            const isLoading = isActive && (loading?.includes(o.key) ?? false);
            const id = `overlay-${o.key}`;
            const opacity = opacities[o.key] ?? OVERLAY_FILL_OPACITY;
            return (
              <li key={o.key} className="flex items-start gap-2.5">
                <Checkbox
                  id={id}
                  checked={isActive}
                  disabled={!isAvailable}
                  onCheckedChange={(v) => toggle(o.key, v === true)}
                  className="mt-0.5"
                />
                <div className={cn("min-w-0 flex-1", !isAvailable && "opacity-60")}>
                  <label htmlFor={id} className={cn("block", isAvailable ? "cursor-pointer" : "cursor-not-allowed")}>
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border" style={{ background: o.color, borderColor: o.color }} />
                      {o.label}
                      {isLoading ? (
                        <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-normal text-muted-foreground" role="status">
                          <span className="inline-block h-2 w-2 animate-spin rounded-full border border-muted-foreground/40 border-t-muted-foreground" />
                          loading
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground [text-wrap:pretty]">
                      {isAvailable
                        ? `${o.caveat} ${o.stateNotes?.[stateCode] ?? ""}`.trim()
                        : `No open statutory layer for ${STATE_NAMES[stateCode] ?? stateCode} yet.`}
                    </span>
                  </label>
                  {isActive ? (
                    <label className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="w-12 shrink-0">Opacity</span>
                      <input
                        type="range" min={10} max={90} step={5}
                        value={Math.round(opacity * 100)}
                        aria-label={`${o.label} opacity`}
                        onChange={(e) => onOpacityChange(o.key, Number(e.target.value) / 100)}
                        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-[var(--accent-amber,#f59e0b)]"
                        style={{ accentColor: o.color }}
                      />
                      <span className="w-8 shrink-0 text-right font-mono tabular-nums">{Math.round(opacity * 100)}%</span>
                    </label>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[10px] text-muted-foreground">
          Hover a suburb for its share of each active layer. Overlays are drawn on top of the colour ramp and never change it.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Legend rows for the active overlays, stacked under the colour legend. Each
 * row is removable, so turning a layer off never needs the popover.
 */
export function OverlayLegend({
  stateCode, active, opacities, onRemove,
}: {
  stateCode: string;
  active: readonly OverlayKey[];
  opacities?: OverlayOpacities;
  onRemove?: (key: OverlayKey) => void;
}) {
  const shown = OVERLAYS.filter((o) => active.includes(o.key) && overlayAvailable(o.key, stateCode));
  if (!shown.length) return null;
  return (
    <div className={cn("rounded-lg border border-border bg-card/90 px-3 py-2 shadow-sm backdrop-blur", onRemove ? "pointer-events-auto" : "pointer-events-none")}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Overlays</div>
      <ul className="mt-1 space-y-0.5">
        {shown.map((o) => {
          const alpha = Math.round((opacities?.[o.key] ?? OVERLAY_FILL_OPACITY) * 255).toString(16).padStart(2, "0");
          return (
            <li key={o.key} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="inline-block h-2.5 w-3.5 shrink-0 rounded-sm border" style={{ background: `${o.color}${alpha}`, borderColor: o.color }} />
              <span className="flex-1">{o.label}</span>
              {onRemove ? (
                <button
                  type="button" aria-label={`Hide ${o.label.toLowerCase()} overlay`}
                  onClick={() => onRemove(o.key)}
                  className="hit-target -mr-1 flex h-4 w-4 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                >
                  <span className="text-[11px] leading-none">×</span>
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LayersGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      <path d="M8 2 1.5 5.5 8 9l6.5-3.5L8 2Z" fill="currentColor" opacity="0.9" />
      <path d="m1.5 8.5 6.5 3.5 6.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="m1.5 11.5 6.5 3.5 6.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" opacity="0.6" />
    </svg>
  );
}
