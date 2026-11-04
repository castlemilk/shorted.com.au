"use client";

/**
 * The Overview's toolbar (spec 14.3, Overview): one control to find a stock or a
 * holder, the Source of the panes (substantial notices or index fund holdings), and
 * the window of change. A stock pick selects it in place (the inspector follows the
 * link, with no request); a holder pick opens its profile. The Source writes the
 * map's lens in place, and the window chips are links, as every window is.
 *
 * The server draws the same markup with the default link, so the first render is the
 * fallback's, and the island reads the link under its own Suspense boundary.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";

import { SearchCombobox, type SearchComboboxOption } from "~/@/components/gamma/SearchCombobox";
import { SegmentedControl } from "~/@/components/gamma/SegmentedControl";
import { serializeSelection } from "~/@/components/ownership/workspace/selection";
import { WindowChips, noticeWindowHref, readNoticeWindow } from "./window-chips";

/** A stock the toolbar can find: its code and company name. */
export interface DeskToolbarStock {
  code: string;
  name: string;
}

/** A holder the toolbar can find: its registry slug and name. */
export interface DeskToolbarHolder {
  slug: string;
  name: string;
}

export interface DeskToolbarProps {
  stocks: readonly DeskToolbarStock[];
  holders: readonly DeskToolbarHolder[];
  /** The path the window chips link to. */
  basePath?: string;
}

/** The Source's two values: the notices (the map's disclosed lens) and the index fund files (its index lens). */
const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "disclosed", label: "Substantial notices" },
  { value: "index", label: "Index fund holdings" },
];

/** The search's options: every stock by its code, and every holder by its name (spec 14.3). */
export function findOptions(
  stocks: readonly DeskToolbarStock[],
  holders: readonly DeskToolbarHolder[],
): SearchComboboxOption[] {
  const stockOptions = stocks.map((stock) => ({
    value: `stock:${stock.code}`,
    label: `${stock.code}, ${stock.name}`,
    keywords: [stock.name],
  }));
  const holderOptions = holders.map((holder) => ({
    value: `holder:${holder.slug}`,
    label: holder.name,
    description: "Holder",
  }));
  return [...stockOptions, ...holderOptions];
}

/** A link's parameter, set or cleared in place, keeping every other parameter the reader has. */
function writeParam(name: string, value: string | null): void {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState(null, "", url);
}

function Toolbar({
  stocks,
  holders,
  basePath,
  params,
  onPickHolder,
  lens,
}: DeskToolbarProps & {
  params: URLSearchParams;
  onPickHolder: (slug: string) => void;
  lens: string;
}) {
  const options = useMemo(() => findOptions(stocks, holders), [stocks, holders]);
  const windowState = readNoticeWindow(params);
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <div className="min-w-[16rem] flex-1 sm:max-w-md">
        <SearchCombobox
          label="Find a stock or holder"
          options={options}
          placeholder="Find a stock or holder"
          clearable
          onValueChange={(value) => {
            if (value === null) return;
            if (value.startsWith("stock:")) {
              const code = value.slice("stock:".length);
              writeParam("sel", serializeSelection({ kind: "stock", code }));
              return;
            }
            if (value.startsWith("holder:")) onPickHolder(value.slice("holder:".length));
          }}
        />
      </div>
      <SegmentedControl
        label="Source"
        size="sm"
        value={lens === "index" ? "index" : "disclosed"}
        onChange={(value) => writeParam("lens", value === "index" ? "index" : null)}
        options={SOURCE_OPTIONS}
      />
      <WindowChips
        label="Window"
        active={windowState}
        hrefFor={(next) => noticeWindowHref(basePath ?? "/ownership", params, next)}
      />
    </div>
  );
}

function LiveToolbar(props: DeskToolbarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useMemo(() => new URLSearchParams(searchParams?.toString() ?? ""), [searchParams]);
  return (
    <Toolbar
      {...props}
      params={params}
      lens={params.get("lens") ?? ""}
      onPickHolder={(slug) => router.push(`/ownership/${encodeURIComponent(slug)}`)}
    />
  );
}

/** The toolbar. The default view is the Suspense fallback, so the server markup is the same. */
export function DeskToolbar(props: DeskToolbarProps) {
  return (
    <Suspense
      fallback={
        <Toolbar
          {...props}
          params={new URLSearchParams()}
          lens=""
          onPickHolder={() => undefined}
        />
      }
    >
      <LiveToolbar {...props} />
    </Suspense>
  );
}
