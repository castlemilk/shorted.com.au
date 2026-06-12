/**
 * Storybook full mock for ../getTopShorts.
 *
 * The real module imports kv-cache (ioredis — Node net/tls) and React's
 * server `cache()`, which crash Vite's browser build. Registered WITHOUT
 * `{ spy: true }` in `.storybook/preview.tsx`, so this file fully replaces
 * the module and the original is never evaluated.
 *
 * Stories set behavior per story:
 *   mocked(getTopShortsData).mockResolvedValue(topShortsResponseFixture())
 */
import { fn } from "storybook/test";
import type { GetTopShortsResponse } from "~/gen/shorts/v1alpha1/shorts_pb";

export const getTopShortsData =
  fn<
    (
      period: string,
      limit: number,
      offset: number,
    ) => Promise<GetTopShortsResponse | undefined>
  >();
