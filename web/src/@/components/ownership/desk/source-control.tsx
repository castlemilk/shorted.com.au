"use client";

import { ToolbarSelect } from "../workspace/toolbar";

/** Why the index fund option is disabled (spec 14.8): its figures are files, not notices. */
export const INDEX_SOURCE_TITLE = "Index fund holdings are files, not notices";

export type SourceValue = "notices" | "index";

/**
 * The Source as one labelled select (spec 14.9), the form every instrument's toolbar takes. The
 * Connections and Activity grids count notices only, so their index fund option is drawn disabled
 * and titled. The map passes `onChange` and `indexAvailable`, because its Source switches the lens.
 */
export function SourceSelect({
  value = "notices",
  onChange,
  indexAvailable = false,
}: {
  value?: SourceValue;
  onChange?: (value: SourceValue) => void;
  indexAvailable?: boolean;
}) {
  return (
    <ToolbarSelect
      label="Source"
      value={value}
      onChange={onChange === undefined ? undefined : (next) => onChange(next === "index" ? "index" : "notices")}
      className="max-w-[9rem]"
    >
      {/* Short option names keep each instrument's toolbar on one row at 1440 (spec 14.9). */}
      <option value="notices">Notices</option>
      <option value="index" disabled={!indexAvailable} title={indexAvailable ? undefined : INDEX_SOURCE_TITLE}>
        Index funds
      </option>
    </ToolbarSelect>
  );
}

/**
 * The Source of the Connections and Activity instruments (spec 14.3): only substantial notices is
 * served there, so the select is fixed on it. A non-interactive select, not a disabled one, so the
 * notices option stays readable.
 */
export function SourceControl() {
  return <SourceSelect value="notices" />;
}
