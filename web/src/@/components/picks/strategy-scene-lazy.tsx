"use client";

import dynamic from "next/dynamic";

/**
 * The scene's animation, fetched in the browser only: a real import() from
 * a client module, so the canvas code is a chunk of its own, loaded after
 * the page is interactive, and never part of the server render (where there
 * is no canvas). Until it lands, and wherever it never runs, the SVG still
 * underneath is the scene.
 */
export const StrategySceneLazy = dynamic(
  () => import("./strategy-scene-canvas").then((m) => m.StrategySceneCanvas),
  { ssr: false, loading: () => null },
);
