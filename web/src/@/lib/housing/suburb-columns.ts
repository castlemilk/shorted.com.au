/**
 * Decoding for the columnar suburb-metric RPCs (GetSuburbIndex +
 * GetSuburbMetricColumns, #505). A column is a packed float per suburb in the
 * index's sal_code order plus a null mask; the mask is what keeps a measured
 * zero (a suburb genuinely 0% under water) distinguishable from "no source".
 *
 * Bit order is least-significant-bit first: row i is byte i>>3, bit i&7, and a
 * set bit means NULL. That matches the Go encoder (`setBit` in
 * postgres_suburb_columns.go) and is pinned by suburb-columns.test.ts.
 */

export function isNullAt(mask: Uint8Array, index: number): boolean {
  const byte = index >> 3;
  if (byte >= mask.length) return false;
  return (mask[byte]! & (1 << (index & 7))) !== 0;
}

/** Aligns one column to the index's sal_codes → Map<sal_code, value | null>. */
export function decodeColumn(
  salCodes: readonly string[],
  values: ArrayLike<number>,
  nullMask: Uint8Array,
): Map<string, number | null> {
  if (values.length !== salCodes.length) {
    throw new Error(`column has ${values.length} values for ${salCodes.length} suburbs`);
  }
  const out = new Map<string, number | null>();
  for (let i = 0; i < salCodes.length; i++) {
    out.set(salCodes[i]!, isNullAt(nullMask, i) ? null : values[i]!);
  }
  return out;
}

/** Decodes a filter bitset (1 = match) to the set of matching sal_codes. */
export function decodeMatchMask(salCodes: readonly string[], matchMask: Uint8Array): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < salCodes.length; i++) {
    if (isNullAt(matchMask, i)) out.add(salCodes[i]!);
  }
  return out;
}
