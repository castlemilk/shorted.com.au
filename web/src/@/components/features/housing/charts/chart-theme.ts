/**
 * Shared visual constants for the housing-feature dashboards. Colours reference
 * CSS variables so charts track light/dark automatically. Brand-distinct hues
 * (violet/cyan/rose) match the international + basket palettes.
 */
import type { CSSProperties } from "react";

export const AXIS_TEXT = "hsl(var(--muted-foreground))";
export const AXIS_LINE = "hsl(var(--border))";
export const GRID = "hsl(var(--border))";
export const AMBER = "hsl(var(--primary))";
export const OLIVE = "hsl(var(--secondary))";
export const RUST = "hsl(var(--accent))";
export const MARKER = "hsl(var(--muted-foreground))";

export const TOOLTIP_STYLE: CSSProperties = {
  position: "absolute",
  backgroundColor: "hsl(var(--popover))",
  color: "hsl(var(--popover-foreground))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  padding: "6px 9px",
  fontSize: 11,
  lineHeight: 1.5,
  pointerEvents: "none",
};
