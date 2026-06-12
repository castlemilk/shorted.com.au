/**
 * Storybook full mock for ../getTooltipData.
 *
 * The real module imports kv-cache (ioredis — Node net/tls), which crashes
 * Vite's browser build. It is also a transitive import of EVERY treemap
 * widget story: industry-treemap-widget.tsx statically imports
 * TreemapTooltip, which statically imports getTooltipData — so this mock is
 * required for the story module graph to build at all, not just for the
 * hover interaction. Registered WITHOUT `{ spy: true }` in
 * `.storybook/preview.tsx`.
 *
 * Stories set behavior per story:
 *   mocked(getTooltipData).mockImplementation((code) =>
 *     Promise.resolve(tooltipDataFixture(code)),
 *   )
 *
 * The interfaces are re-imported as types only, so nothing real evaluates.
 */
import { fn } from "storybook/test";
import type { TooltipData } from "../getTooltipData";

export type {
  SerializedStockDetails,
  SerializedTimeSeriesData,
  SerializedTimeSeriesPoint,
  TooltipData,
} from "../getTooltipData";

export const getTooltipData =
  fn<(productCode: string) => Promise<TooltipData>>();
