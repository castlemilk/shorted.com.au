/**
 * A stock's short percentage as a page shows it. One rule for every surface
 * of the stock page: the title and description, the header, the crawler
 * summary, the Dataset and the social card.
 *
 * A position that rounds to zero at the digits shown is never printed as a
 * zero. ANT, 164 shares short, was titled "ANT Short Interest: 0.00%", its
 * header and summary read "0.00%", its Dataset said `value: 0` and its card
 * "0.0%": each a measured zero for a reported position. Such a position has
 * no level to state, and where a figure must appear it reads "<0.01%".
 *
 * The value is checked before it is formatted: the edge read returns the
 * API's JSON as sent, and protojson leaves a zero float out, so the field can
 * be absent whatever the Stock type says.
 */

function isPositive(percentageShorted: number | undefined): percentageShorted is number {
  return (
    typeof percentageShorted === "number" &&
    Number.isFinite(percentageShorted) &&
    percentageShorted > 0
  );
}

/**
 * The level to state, to `digits` decimals ("9.42"), or null when there is
 * none: absent, zero, not a finite positive number, or rounding to zero.
 */
export function statedShortPercent(
  percentageShorted: number | undefined,
  digits = 2,
): string | null {
  if (!isPositive(percentageShorted)) return null;
  const fixed = percentageShorted.toFixed(digits);
  return Number(fixed) === 0 ? null : fixed;
}

/**
 * The figure a reader sees: the stated level ("9.42%"), or the bound a
 * position too small to state sits under ("<0.01%", "<0.1%" at one digit).
 * Null when there is no position at all, which each surface words its own way.
 */
export function shortPercentFigure(
  percentageShorted: number | undefined,
  digits = 2,
): string | null {
  const stated = statedShortPercent(percentageShorted, digits);
  if (stated) return `${stated}%`;
  return isPositive(percentageShorted) ? `<${(10 ** -digits).toFixed(digits)}%` : null;
}
