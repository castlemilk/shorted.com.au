import {
  type BattlegroundStock,
  type ShortCampaign,
  type GetShortCampaignScoreboardResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";

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

/**
 * Plain serializable short-campaign row (same rule as BattlegroundRow:
 * never pass proto Message instances across the RSC boundary).
 */
export interface ScoreboardRow {
  stockCode: string;
  companyName: string;
  industry: string;
  logoUrl: string;
  peakDate: string;
  peakShortPct: number;
  priceAtPeak: number;
  return3m: number | null;
  return6m: number | null;
  shortsWon3m: boolean | null;
  shortsWon6m: boolean | null;
  currentShortPct: number;
  latestPrice: number;
}

export interface ScoreboardData {
  rows: ScoreboardRow[];
  totalCount: number;
  campaignsTotal: number;
  shortsWinRate3m: number;
  shortsWinRate6m: number;
}

export function toScoreboardRow(campaign: ShortCampaign): ScoreboardRow {
  return {
    stockCode: campaign.stockCode,
    companyName: campaign.companyName,
    industry: campaign.industry,
    logoUrl: campaign.logoUrl,
    peakDate: campaign.peakDate,
    peakShortPct: campaign.peakShortPct,
    priceAtPeak: campaign.priceAtPeak,
    return3m: campaign.has3m ? campaign.return3m : null,
    return6m: campaign.has6m ? campaign.return6m : null,
    shortsWon3m: campaign.has3m ? campaign.shortsWon3m : null,
    shortsWon6m: campaign.has6m ? campaign.shortsWon6m : null,
    currentShortPct: campaign.currentShortPct,
    latestPrice: campaign.latestPrice,
  };
}

export function toScoreboardData(
  response: GetShortCampaignScoreboardResponse,
): ScoreboardData {
  return {
    rows: response.campaigns.map(toScoreboardRow),
    totalCount: response.totalCount,
    campaignsTotal: response.campaignsTotal,
    shortsWinRate3m: response.shortsWinRate3m,
    shortsWinRate6m: response.shortsWinRate6m,
  };
}
