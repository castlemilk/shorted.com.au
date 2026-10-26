/**
 * The longest stock-tab title before the root template's " | Shorted": about
 * the width Google shows in results. The Company and Strategy tabs ran 63-67
 * characters before it ("DRO Company Profile: Directors, Insiders & Operations
 * | Droneshield | Shorted" rendered at 77, 2026-10-21) and were cut off.
 */
export const STOCK_TAB_TITLE_MAX = 60;

/**
 * A stock tab's <title>, before the root template appends " | Shorted". The
 * code and the topic lead, because that is how per-ticker queries are phrased
 * ("dro canslim", "dro directors"); the company follows when the whole title
 * fits the budget. A name too long to fit (Commonwealth Bank of Australia) is
 * left to the description, and so is the code standing in for a name the
 * stock read could not supply.
 */
export function stockTabTitle(
  code: string,
  topic: string,
  company: string,
): string {
  const lead = `${code} ${topic}`;
  const full = `${lead} | ${company}`;
  return company && company !== code && full.length <= STOCK_TAB_TITLE_MAX
    ? full
    : lead;
}
