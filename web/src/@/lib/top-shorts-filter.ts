export interface TopShortsInstrumentCandidate {
  productCode?: string;
  name?: string;
}

const LISTED_EQUITY_CODE_PATTERN = /^[A-Z0-9]{3,4}$/;
const ETF_NAME_PATTERN = /\bETF\b/i;
const COUPON_PERCENT_NAME_PATTERN = /[0-9]+(\.[0-9]+)?\s*%/;

export function isEligibleTopShortsInstrument(
  stock: TopShortsInstrumentCandidate,
): boolean {
  const productCode = (stock.productCode ?? "").trim().toUpperCase();
  const name = stock.name ?? "";

  return (
    LISTED_EQUITY_CODE_PATTERN.test(productCode) &&
    !ETF_NAME_PATTERN.test(name) &&
    !COUPON_PERCENT_NAME_PATTERN.test(name)
  );
}

export function hasOnlyEligibleTopShortsInstruments(
  stocks: readonly TopShortsInstrumentCandidate[] | null | undefined,
): boolean {
  if (!stocks) return false;
  return stocks.every((stock) => isEligibleTopShortsInstrument(stock));
}

export function filterEligibleTopShorts<T extends TopShortsInstrumentCandidate>(
  stocks: readonly T[] | null | undefined,
): T[] {
  if (!stocks) return [];
  return stocks.filter((stock) => isEligibleTopShortsInstrument(stock));
}

export function filterTopShortsResponse<
  TStock extends TopShortsInstrumentCandidate,
  TResponse extends { timeSeries?: TStock[] },
>(response: TResponse): TResponse {
  const timeSeries = response.timeSeries;
  if (!timeSeries) return response;

  const filteredTimeSeries = filterEligibleTopShorts(timeSeries);
  if (filteredTimeSeries.length === timeSeries.length) return response;

  return {
    ...response,
    timeSeries: filteredTimeSeries,
  };
}
