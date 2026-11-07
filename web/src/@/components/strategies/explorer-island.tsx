"use client";

import type { ReactNode } from "react";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { SideSheet } from "~/@/components/gamma/SideSheet";
import { strategyCapabilityEnabled } from "~/@/lib/strategies/capabilities";
import {
  DEFAULT_FILTERS,
  DEFAULT_WINDOW_ID,
  EVIDENCE_OPTIONS,
  UNIVERSE_OPTIONS,
  parseIds,
  parseSelection,
  parseWindow,
  pickOption,
  toggleId,
  type ExplorerFilters,
  type ExplorerModel,
  type WindowId,
} from "~/@/lib/strategies/explorer";
import { ExplorerView, type ExplorerControls } from "./explorer-view";
import { StrategyInspector } from "./strategy-inspector";

/** The URL keys the explorer owns. Defaults are left out of the URL. */
const KEYS = {
  query: "q",
  style: "style",
  horizon: "horizon",
  universe: "universe",
  evidence: "evidence",
  window: "window",
  sel: "sel",
  ids: "ids",
} as const;

interface ExplorerState {
  filters: ExplorerFilters;
  windowId: WindowId;
  selectedId: string | null;
  picked: string[];
}

/** Below lg the rail is a sheet; the query is the one the rail's own layout uses. */
const NARROW_QUERY = "(max-width: 1023px)";

/** Whether the viewport is below lg. Starts false, so the server and the first paint agree. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_QUERY);
    const follow = () => setNarrow(mq.matches);
    follow();
    mq.addEventListener("change", follow);
    return () => mq.removeEventListener("change", follow);
  }, []);
  return narrow;
}

/** The state the URL names, validated against the model. Filters take stable keys only. */
function stateFromParams(params: URLSearchParams, model: ExplorerModel): ExplorerState {
  return {
    filters: {
      query: params.get(KEYS.query) ?? "",
      style: pickOption(params.get(KEYS.style), model.styles, DEFAULT_FILTERS.style),
      horizon: pickOption(params.get(KEYS.horizon), model.horizons, DEFAULT_FILTERS.horizon),
      universe: pickOption(params.get(KEYS.universe), UNIVERSE_OPTIONS, DEFAULT_FILTERS.universe),
      evidence: pickOption(params.get(KEYS.evidence), EVIDENCE_OPTIONS, DEFAULT_FILTERS.evidence),
    },
    windowId: parseWindow(params.get(KEYS.window)),
    selectedId: parseSelection(params.get(KEYS.sel), model.rows, model.defaultId),
    picked: parseIds(params.get(KEYS.ids), model.rows),
  };
}

/** The address for a state: only what differs from the defaults is written. */
function addressFor(state: ExplorerState, model: ExplorerModel): string {
  const params = new URLSearchParams();
  const { filters } = state;
  if (filters.query.trim()) params.set(KEYS.query, filters.query);
  if (filters.style !== DEFAULT_FILTERS.style) params.set(KEYS.style, filters.style);
  if (filters.horizon !== DEFAULT_FILTERS.horizon) params.set(KEYS.horizon, filters.horizon);
  if (filters.universe !== DEFAULT_FILTERS.universe) params.set(KEYS.universe, filters.universe);
  if (filters.evidence !== DEFAULT_FILTERS.evidence) params.set(KEYS.evidence, filters.evidence);
  if (state.windowId !== DEFAULT_WINDOW_ID) params.set(KEYS.window, state.windowId);
  if (state.selectedId && state.selectedId !== model.defaultId) {
    params.set(KEYS.sel, `strategy:${state.selectedId}`);
  }
  if (state.picked.length > 0) params.set(KEYS.ids, state.picked.join(","));
  // Ids read as a list, not as an encoded pair: commas stay literal.
  const query = params.toString().replace(/%2C/gi, ",");
  return query ? `${window.location.pathname}?${query}` : window.location.pathname;
}

/**
 * The explorer's island. The page draws the static table as the Suspense fallback;
 * after hydration the filters, the window, the selection and the compare tray read and
 * write the URL (`history.replaceState`, so no navigation and no server trip). The URL is
 * read once, when the island mounts: the island owns its state after that.
 */
export function ExplorerIsland({ model, header }: { model: ExplorerModel; header: ReactNode }) {
  return (
    <Suspense
      fallback={
        <ExplorerView
          model={model}
          header={header}
          filters={DEFAULT_FILTERS}
          windowId={DEFAULT_WINDOW_ID}
          selectedId={model.defaultId}
          picked={[]}
          compareEnabled={strategyCapabilityEnabled("compare")}
        />
      }
    >
      <LiveExplorer model={model} header={header} />
    </Suspense>
  );
}

function LiveExplorer({ model, header }: { model: ExplorerModel; header: ReactNode }) {
  const params = useSearchParams();
  const { data: session, status } = useSession();
  const narrow = useNarrow();
  const [state, setState] = useState<ExplorerState>(() =>
    stateFromParams(new URLSearchParams(params.toString()), model),
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  const signedIn: boolean | undefined =
    status === "loading" ? undefined : status === "authenticated" && !!session?.user?.id;

  // Each handler computes its next state from this render's state and writes the address
  // once. The history write takes null, as the ownership islands do: the state is not kept
  // in history, only in the address.
  const apply = (next: ExplorerState) => {
    setState(next);
    try {
      window.history.replaceState(null, "", addressFor(next, model));
    } catch {
      // A blocked history write leaves the state in place; only the address is stale.
    }
  };
  const controls: ExplorerControls = {
    onFilters: (patch) => apply({ ...state, filters: { ...state.filters, ...patch } }),
    onWindow: (windowId) => apply({ ...state, windowId }),
    onSelect: (id) => {
      if (narrow) setSheetOpen(true);
      apply({ ...state, selectedId: id });
    },
    onToggle: (id) => apply({ ...state, picked: toggleId(state.picked, id) }),
  };

  const selected = model.rows.find((row) => row.id === state.selectedId) ?? null;
  // The sheet is open only below lg. Past lg it is closed, which releases its scroll lock.
  const sheet = selected ? (
    <SideSheet
      side="bottom"
      open={sheetOpen && narrow}
      onOpenChange={setSheetOpen}
      title={selected.name}
      trigger={null}
      closeLabel="Close the strategy"
      className="lg:hidden"
    >
      <StrategyInspector
        id={selected.id}
        inspector={selected.inspector}
        benchmarkName={model.benchmarkName}
        heading={false}
      />
    </SideSheet>
  ) : null;

  return (
    <ExplorerView
      model={model}
      header={header}
      filters={state.filters}
      windowId={state.windowId}
      selectedId={state.selectedId}
      picked={state.picked}
      signedIn={signedIn}
      compareEnabled={strategyCapabilityEnabled("compare")}
      controls={controls}
      sheet={sheet}
    />
  );
}
