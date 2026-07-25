/**
 * Display formatting for ASX company names.
 *
 * Two shapes reach the UI:
 *  1. Backend-title-cased names — services/shorts/.../postgres.go
 *     `cleanCompanyName` lowercases the ASIC name then title-cases it, which
 *     destroys ticker acronyms: "BHP GROUP LIMITED" becomes "Bhp Group",
 *     "CSL LIMITED" becomes "Csl". (Root cause; fixing it there needs a
 *     backend deploy AND a re-sync of company-metadata.)
 *  2. Raw ASIC / metadata names that are still SHOUTED ("BHP GROUP LIMITED").
 *
 * `formatCompanyName` repairs both at the display layer:
 *  - a word equal to the stock code (case-insensitive) always renders
 *    uppercase — "Bhp Group" + BHP → "BHP Group";
 *  - an all-caps source is title-cased, but 1-3 letter all-caps acronyms in
 *    that source keep their case — "BHP GROUP LIMITED" + BHP → "BHP Group";
 *  - trailing entity/security suffixes (LIMITED, LTD, ...) are dropped;
 *  - a mixed-case name is otherwise left alone — this never re-cases prose.
 *
 * Pure and dependency-free, so it is safe in both server and client chains.
 */

// Entity/security suffixes that add nothing to a display heading.
const TRAILING_SUFFIX =
  /[\s,]+(LIMITED|LTD\.?|CORPORATION|CORP\.?|INCORPORATED|INC\.?|PLC|N\.?L\.?)$/i;

const TOKENS = /([^A-Za-z0-9]+)/;

// Lowercased inside a title-cased name (never as the first word).
const MINOR_WORDS = new Set(["of", "and", "the", "for", "in", "on", "de"]);

function titleCaseWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Does this word look like a mangled acronym rather than a real word?
 * A word with a vowel anywhere after the first letter is pronounceable
 * ("Rio", "Nab"), so we leave it alone; "Bhp"/"Csl"/"Anz" are not.
 * This keeps the code-match rule from SHOUTING legitimate names like
 * "Rio Tinto" (code RIO).
 */
function isAcronymLike(word: string): boolean {
  return !/[aeiou]/i.test(word.slice(1));
}

export function formatCompanyName(
  name: string | undefined | null,
  stockCode?: string,
): string {
  const code = stockCode?.trim().toUpperCase();
  if (!name) return code ?? "";

  let cleaned = name.trim();
  // Suffixes can stack ("… LIMITED" after "… CORPORATION").
  let prev = "";
  while (prev !== cleaned) {
    prev = cleaned;
    cleaned = cleaned.replace(TRAILING_SUFFIX, "").trim();
  }
  if (!cleaned) cleaned = name.trim();

  // Only re-case when the source is SHOUTED; a mixed-case name is assumed to
  // already carry intentional casing (e.g. "Bhp Group" from the backend).
  const isShouting = cleaned === cleaned.toUpperCase();

  let wordIndex = -1;
  return cleaned
    .split(TOKENS)
    .map((token) => {
      if (!/[A-Za-z]/.test(token)) return token; // separators / numbers
      wordIndex += 1;
      if (
        code &&
        token.toUpperCase() === code &&
        (isShouting || isAcronymLike(token))
      ) {
        return code;
      }
      if (!isShouting) return token;
      if (wordIndex > 0 && MINOR_WORDS.has(token.toLowerCase())) {
        return token.toLowerCase();
      }
      // Short all-caps acronyms in a shouted source stay uppercase.
      if (token.length <= 3) return token.toUpperCase();
      return titleCaseWord(token);
    })
    .join("");
}
