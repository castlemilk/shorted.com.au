// Shared by the admin console's market-moves token page and its server actions
// (app/actions/admin/marketMovesTokens.ts, which as a "use server" module may
// export only async functions).

/** The expiries the console offers, in days; 0 is never. */
export const TOKEN_EXPIRY_CHOICES = [30, 90, 365, 0] as const;

export type TokenExpiryDays = (typeof TOKEN_EXPIRY_CHOICES)[number];

/** The default the create form starts on. */
export const DEFAULT_TOKEN_EXPIRY_DAYS: TokenExpiryDays = 90;

/** The env var a workflow reads the token from (docs/feature/market-moves/README.md). */
export const TOKEN_ENV_VAR = "SHORTED_MARKET_MOVES_TOKEN";

export function expiryLabel(days: number): string {
  if (days === 0) return "Never";
  if (days === 365) return "1 year";
  return `${days} days`;
}
