/**
 * A workspace page's toolbar (ownership explorer design, section 14.9): one row of labelled controls. A plain module, so
 * the server's default view draws the row as it is. An island passes `fold`, which wraps the
 * row in the client disclosure (view-disclosure.tsx) that folds it below `sm`. The row wraps only
 * when its controls cannot share a line; a phone's column folds the row under one disclosure instead.
 *
 * Every control in the row is a labelled select (ToolbarSelect) or a segmented control, so the
 * row's height is one control's height: the islands' placeholders reserve that height (h-8 from sm).
 */

import type { ReactNode } from "react";
import { cn } from "~/@/lib/utils";
import { POLITICS_FOCUS_RING } from "~/@/lib/politics/control-classes";

export type ToolbarFold = (row: ReactNode) => ReactNode;

/** The row's height from `sm`: one select (h-8). Below `sm` the row sits under the fold's summary. */
export const TOOLBAR_ROW_CLASS = "h-5 sm:h-8";

/**
 * The row's height from `sm` when it holds a Gamma SearchCombobox (the map's "Find company or sector"):
 * its field's min-height is 44 px (gamma.css `.search-combobox-field`, a touch target kept as the library
 * sets it), so the placeholder takes that height. `critique-rules.test.tsx` reads the stylesheet and pins it.
 */
export const TOOLBAR_COMBOBOX_ROW_CLASS = "h-5 sm:h-11";

export function Toolbar({ children, fold }: { children: ReactNode; fold?: ToolbarFold }) {
  const row = (
    <div data-toolbar="" className="flex flex-wrap items-center gap-x-3 gap-y-3">
      {children}
    </div>
  );
  return <>{fold ? fold(row) : row}</>;
}

/** The select's own class: one line of mono text at 32 px, the focus ring the house uses. */
export const TOOLBAR_SELECT_CLASS = cn(
  "h-8 min-w-0 rounded-sm border border-input bg-background px-2 font-mono text-xs text-foreground disabled:cursor-default",
  POLITICS_FOCUS_RING,
);

/**
 * A labelled select in the toolbar's row: the label in sentence case, the select after it. The
 * label is the select's accessible name, so a reader and a voice control both say what it is.
 */
export function ToolbarSelect({
  label,
  value,
  onChange,
  disabled = false,
  className,
  children,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled || !onChange}
        onChange={(event) => onChange?.(event.target.value)}
        className={cn(TOOLBAR_SELECT_CLASS, className)}
      >
        {children}
      </select>
    </label>
  );
}
