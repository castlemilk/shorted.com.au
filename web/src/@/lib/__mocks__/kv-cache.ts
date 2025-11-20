/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-explicit-any */

export const CACHE_KEYS = {
  statistics: "cache:about:statistics",
  topStocks: (limit: number) => `cache:about:top-stocks:${limit}`,
  topShorts: (period: string, limit: number, offset: number) =>
    `cache:homepage:top-shorts:${period}:${limit}:${offset}`,
  industryTreeMap: (period: string, limit: number, viewMode: string) =>
    `cache:homepage:treemap:${period}:${limit}:${viewMode}`,
};

export const HOMEPAGE_TTL = 600;

export const getCached = jest.fn().mockResolvedValue(null);
export const setCached = jest.fn().mockResolvedValue(true);
export const deleteCached = jest.fn().mockResolvedValue(true);
export const isCacheAvailable = jest.fn().mockReturnValue(false);
export const getOrSetCached = jest.fn().mockImplementation(async (_key: string, fallback: () => Promise<any>) => {
  return await fallback();
});
