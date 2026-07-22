/**
 * Storybook full mock for ../getIndustryTreeMap.
 *
 * The real module imports kv-cache (ioredis — Node net/tls) and React's
 * server `cache()`, which crash Vite's browser build. Registered WITHOUT
 * `{ spy: true }` in `.storybook/preview.tsx`, so this file fully replaces
 * the module and the original is never evaluated.
 *
 * Stories set behavior per story:
 *   mocked(getIndustryTreeMap).mockResolvedValue(industryTreemapFixture())
 */
import { fn } from "storybook/test";
import type { IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import type { ViewMode } from "~/gen/shorts/v1alpha1/market_pb";

export const getIndustryTreeMap =
  fn<
    (
      period: string,
      limit: number,
      viewMode: ViewMode,
    ) => Promise<IndustryTreeMap>
  >();
