import { type BattlegroundStock } from "~/gen/shorts/v1alpha1/shorts_pb";

/**
 * Plain serializable row shape passed across the RSC boundary.
 * Never pass proto Message instances (or functions) from server to client.
 */
export interface BattlegroundRow {
  stockCode: string;
  companyName: string;
  industry: string;
  logoUrl: string;
  shortPct: number;
  shortPctChange4w: number;
  latestPrice: number;
  priceChange1m: number;
  daysToCover: number;
  squeezeScore: number;
  divergenceScore: number;
  marketCap: number;
}

export function toBattlegroundRow(stock: BattlegroundStock): BattlegroundRow {
  return {
    stockCode: stock.stockCode,
    companyName: stock.companyName,
    industry: stock.industry,
    logoUrl: stock.logoUrl,
    shortPct: stock.shortPct,
    shortPctChange4w: stock.shortPctChange4w,
    latestPrice: stock.latestPrice,
    priceChange1m: stock.priceChange1m,
    daysToCover: stock.daysToCover,
    squeezeScore: stock.squeezeScore,
    divergenceScore: stock.divergenceScore,
    marketCap: stock.marketCap,
  };
}

export function toBattlegroundRows(
  stocks: BattlegroundStock[],
): BattlegroundRow[] {
  return stocks.map(toBattlegroundRow);
}
