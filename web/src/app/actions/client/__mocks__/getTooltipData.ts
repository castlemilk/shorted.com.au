/**
 * Storybook full mock for ../getTooltipData (the client edge-read facade).
 *
 * Registered WITHOUT `{ spy: true }` in `.storybook/preview.tsx`: spy mode
 * fails on this module because Storybook's automock codegen sees the
 * type-only re-exports (`export type { SerializedStockDetails, ... }`) as
 * runtime exports and emits references to them, crashing the story bundle
 * with "SerializedStockDetails is not defined".
 *
 * Stories set behavior per story:
 *   mocked(getTooltipDataClient).mockImplementation((code) =>
 *     Promise.resolve(tooltipDataFixture(code)))
 */
import { fn } from "storybook/test";
import type { TooltipData } from "../../tooltip/getTooltipData";

export type {
  SerializedStockDetails,
  SerializedTimeSeriesData,
  TooltipData,
} from "../../tooltip/getTooltipData";

export const getTooltipDataClient =
  fn<(productCode: string) => Promise<TooltipData>>();
