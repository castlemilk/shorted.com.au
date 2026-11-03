"use client";

/**
 * The flows island (spec 13.3): the positions and the window's changes, redrawn
 * when the window changes. The server draws the default view into the HTML
 * (ownership-flows-static.tsx); this island reads the link under its own Suspense
 * boundary and asks the loader for the window the link names.
 *
 * WHY THE LOADER ARRIVES AS A PROP. A "use client" module may not reach the
 * generated protobuf or an action (client-boundary.test.ts). The page passes
 * app/actions/ownershipDesk.ts's loadOwnershipFlows down, and this module imports
 * only its types.
 *
 * WHAT IT KEEPS. A window that is loading leaves the drawing it had on the screen,
 * with the busy line beside it, so a chip press never empties the instrument. A
 * request the reader has moved past is dropped: only the newest may write, so two
 * quick changes cannot leave the first window's rows on the screen. A failed read
 * (ok: false) is the outage line, never an empty flow.
 *
 * THE MODE IS LOCAL. Positions and changes are a switch on this instrument, not a
 * link parameter: the window is what the desk shares, the switch is one chart's.
 */

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import type { DeskRangeInput, OwnershipFlowsPage } from "~/app/actions/ownershipDesk";
import { OwnershipFlowsView, type FlowMode } from "./ownership-flows-static";
import {
  DESK_DEFAULT_WINDOW_STATE,
  readNoticeWindow,
  type NoticeWindow,
} from "./window-chips";

export interface OwnershipFlowsProps {
  /** The default view the server rendered: the newest notice window, positions and changes. */
  initial: OwnershipFlowsPage;
  /** The loader for a window: days back from the newest notice, or a brushed pair of dates. */
  loadFlows: (input: DeskRangeInput) => Promise<OwnershipFlowsPage>;
  /** The path the window chips link to. */
  basePath: string;
}

/** The window as one string, the key a request and a shown view are compared by. */
function keyOf(state: NoticeWindow): string {
  return `${state.window}|${state.since}|${state.until}`;
}

const DEFAULT_KEY = keyOf(DESK_DEFAULT_WINDOW_STATE);

/** The loader's input for a window key: the brushed pair when there is one, else the days. */
function inputFromKey(key: string): DeskRangeInput {
  const [days, since, until] = key.split("|");
  return since ? { since, until } : { window: Number(days) };
}

const OUTAGE_PAGE: OwnershipFlowsPage = {
  ok: false,
  error: "",
  from: "",
  to: "",
  asOf: "",
  positions: [],
  changes: [],
};

interface Shown {
  state: NoticeWindow;
  page: OwnershipFlowsPage;
}

function LiveOwnershipFlows({ initial, loadFlows, basePath }: OwnershipFlowsProps) {
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const state = useMemo(() => readNoticeWindow(params), [params]);
  const key = keyOf(state);

  const [mode, setMode] = useState<FlowMode>("positions");
  const [shown, setShown] = useState<Shown>({ state: DESK_DEFAULT_WINDOW_STATE, page: initial });
  const [busy, setBusy] = useState(false);
  // The key of the window on the screen, the key being loaded, and the sequence of the newest request.
  const shownKey = useRef(DEFAULT_KEY);
  const pendingKey = useRef<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    // A change that leaves the window as it is (a zoomed sector, a mode) asks nothing.
    if (key === pendingKey.current) return;
    // Back on the window on the screen: a request still in flight is stale, so it may not write.
    if (key === shownKey.current) {
      sequence.current += 1;
      pendingKey.current = null;
      setBusy(false);
      return;
    }
    const ticket = (sequence.current += 1);
    pendingKey.current = key;
    setBusy(true);
    const settle = (page: OwnershipFlowsPage) => {
      if (sequence.current !== ticket) return;
      shownKey.current = key;
      pendingKey.current = null;
      setShown({ state, page });
      setBusy(false);
    };
    loadFlows(inputFromKey(key)).then(settle, () => settle(OUTAGE_PAGE));
  }, [key, state, loadFlows]);

  return (
    <OwnershipFlowsView
      page={shown.page}
      mode={mode}
      state={shown.state}
      basePath={basePath}
      params={params}
      onModeChange={setMode}
      busy={busy}
    />
  );
}

/**
 * The flows instrument. The default view is the Suspense fallback, so the HTML
 * carries it and the island takes over once the link is read.
 */
export function OwnershipFlows(props: OwnershipFlowsProps) {
  return (
    <Suspense
      fallback={
        <OwnershipFlowsView
          page={props.initial}
          mode="positions"
          state={DESK_DEFAULT_WINDOW_STATE}
          basePath={props.basePath}
          params={new URLSearchParams()}
        />
      }
    >
      <LiveOwnershipFlows {...props} />
    </Suspense>
  );
}
