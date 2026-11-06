"use client";

import type { ReactNode } from "react";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { SideSheet } from "~/@/components/gamma/SideSheet";
import {
  DEFAULT_FILTERS,
  DEFAULT_WINDOW_ID,
  EVIDENCE_OPTIONS,
  UNIVERSE_OPTIONS,
  parseIds,
  parseSelection,
  parseWindow,
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

const NARROW_QUERY = "(max-width: 1023px)";

/** The state the URL names, validated against the model. */
function stateFromParams(params: URLSearchParams, model: ExplorerModel): ExplorerState {
  const pick = <T extends string>(value: string | null, options: readonly { value: T }[], fallback: T): T =>
    options.some((o) => o.value === value) ? (value as T) : fallback;
  return {
    filters: {
      query: params.get(KEYS.query) ?? "",
      style: params.get(KEYS.style) ?? DEFAULT_FILTERS.style,
      horizon: params.get(KEYS.horizon) ?? DEFAULT_FILTERS.horizon,
      universe: pick(params.get(KEYS.universe), UNIVERSE_OPTIONS, DEFAULT_FILTERS.universe),
      evidence: pick(params.get(KEYS.evidence), EVIDENCE_OPTIONS, DEFAULT_FILTERS.evidence),
    },
    windowId: parseWindow(params.get(KEYS.window)),
    selectedId: parseSelection(params.get(KEYS.sel), model.rows, model.defaultId),
    picked: parseIds(params.get(KEYS.ids), model.rows),
  };
}

/** The address for a state: only what differs from the defaults is written. */
function paramsFor(state: ExplorerState, model: ExplorerModel): string {
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
  // The ids read as a list, not as an encoded pair: commas stay literal.
  const query = params.toString().replace(/%2C/gi, ",");
  return query ? `${window.location.pathname}?${query}` : window.location.pathname;
}

/**
 * The explorer's island. The page draws the static table as the Suspense fallback;
 * after hydration the filters, the window, the selection and the compare tray read
 * and write the URL (`history.replaceState`, so no navigation and no server trip).
 * The URL is read once, when the island mounts: the island owns its state after that.
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
  const [state, setState] = useState<ExplorerState>(() =>
    stateFromParams(new URLSearchParams(params.toString()), model),
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  const signedIn: boolean | undefined =
    status === "loading" ? undefined : status === "authenticated" && !!session?.user?.id;

  // Each handler computes its next state from this render's state and writes the
  // address once. Two events in one tick are not a case: a user acts one control at a time.
  const apply = (next: ExplorerState) => {
    setState(next);
    try {
      window.history.replaceState(window.history.state, "", paramsFor(next, model));
    } catch {
      // A blocked history write leaves the state in place; only the address is stale.
    }
  };
  const controls: ExplorerControls = {
    onFilters: (patch) => apply({ ...state, filters: { ...state.filters, ...patch } }),
    onWindow: (windowId) => apply({ ...state, windowId }),
    onSelect: (id) => {
      if (window.matchMedia?.(NARROW_QUERY).matches) setSheetOpen(true);
      apply({ ...state, selectedId: id });
    },
    onToggle: (id) => apply({ ...state, picked: toggleId(state.picked, id) }),
  };

  const selected = model.rows.find((row) => row.id === state.selectedId) ?? null;
  const sheet = selected ? (
    <SideSheet
      side="bottom"
      open={sheetOpen}
      onOpenChange={setSheetOpen}
      title={selected.name}
      trigger={null}
      closeLabel="Close the strategy"
      className="lg:hidden"
    >
      <StrategyInspector id={selected.id} inspector={selected.inspector} benchmarkName={model.benchmarkName} />
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
      controls={controls}
      sheet={sheet}
    />
  );
}
