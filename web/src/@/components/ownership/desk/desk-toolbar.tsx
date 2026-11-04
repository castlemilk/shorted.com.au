"use client";

/**
 * The Overview's toolbar (spec 14.3, Overview; backlog B2): one row, the search first, then
 * Source (the notices or the index fund files, the map's lens) as a labelled select, then the
 * window as the shared select. A stock pick selects it in place (the inspector follows the link,
 * with no request); a holder pick opens its profile. Source and Window write the link in place,
 * as every instrument does, and below `sm` the row folds under "Adjust view" as the instrument
 * pages' toolbars do.
 *
 * The server draws the same row with its controls disabled, and the island reads the link under
 * its own Suspense boundary, so the first render is the fallback's and the row is drawn unfolded.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";

import { SearchCombobox, type SearchComboboxOption } from "~/@/components/gamma/SearchCombobox";
import { serializeSelection } from "~/@/components/ownership/workspace/selection";
import { Toolbar, ToolbarSelect, type ToolbarFold } from "~/@/components/ownership/workspace/toolbar";
import { ViewDisclosure } from "~/@/components/ownership/workspace/view-disclosure";
import { WindowSelect, writeWindowInPlace } from "~/@/components/ownership/workspace/window-select";
import { readNoticeWindow } from "./window-chips";

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
}

/** The Source's two values: the notices (the map's disclosed lens) and the index fund files (its index lens). */
const SOURCE_OPTIONS: readonly { value: string; label: string }[] = [
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

/** The island's phone fold of the row: the client disclosure around it, as the instrument toolbars fold. */
const deskToolbarFold: ToolbarFold = (row) => <ViewDisclosure>{row}</ViewDisclosure>;

interface DeskToolbarRowProps extends DeskToolbarProps {
  params: URLSearchParams;
  lens: string;
  /** False on the server's default view, where the selects are drawn disabled and write nothing. */
  live: boolean;
  onPickHolder: (slug: string) => void;
  fold?: ToolbarFold;
}

function DeskToolbarRow({ stocks, holders, params, lens, live, onPickHolder, fold }: DeskToolbarRowProps) {
  const options = useMemo(() => findOptions(stocks, holders), [stocks, holders]);
  return (
    <Toolbar fold={fold}>
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
      <ToolbarSelect
        label="Source"
        value={lens === "index" ? "index" : "disclosed"}
        onChange={live ? (value) => writeParam("lens", value === "index" ? "index" : null) : undefined}
      >
        {SOURCE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </ToolbarSelect>
      <WindowSelect active={readNoticeWindow(params)} onWindowChange={live ? writeWindowInPlace : undefined} />
    </Toolbar>
  );
}

function LiveToolbar(props: DeskToolbarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useMemo(() => new URLSearchParams(searchParams?.toString() ?? ""), [searchParams]);
  return (
    <DeskToolbarRow
      {...props}
      params={params}
      lens={params.get("lens") ?? ""}
      live
      fold={deskToolbarFold}
      onPickHolder={(slug) => router.push(`/ownership/${encodeURIComponent(slug)}`)}
    />
  );
}

/** The toolbar. The default view is the Suspense fallback, so the server markup is the same. */
export function DeskToolbar(props: DeskToolbarProps) {
  return (
    <Suspense
      fallback={
        <DeskToolbarRow
          {...props}
          params={new URLSearchParams()}
          lens=""
          live={false}
          onPickHolder={() => undefined}
        />
      }
    >
      <LiveToolbar {...props} />
    </Suspense>
  );
}
