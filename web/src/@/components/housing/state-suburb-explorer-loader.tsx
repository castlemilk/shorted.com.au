"use client";

import dynamic from "next/dynamic";

import type { StateSuburbExplorerProps } from "./state-suburb-explorer";
import { StateSuburbExplorerSkeleton } from "./state-suburb-explorer-skeleton";

export const StateSuburbExplorer = dynamic<StateSuburbExplorerProps>(
  () => import("./state-suburb-explorer").then((m) => m.StateSuburbExplorer),
  { ssr: false, loading: () => <StateSuburbExplorerSkeleton /> },
);

export type { StateSuburbExplorerProps };
export { StateSuburbExplorerSkeleton };
