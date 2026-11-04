/**
 * Display formatting for ASX company names.
 *
 * Two shapes reach the UI:
 *  1. Names the old backend title-caser stored: "BHP GROUP LIMITED" became
 *     "Bhp Group" and "CSL LIMITED" became "Csl", which destroys ticker
 *     acronyms. The ownership rpcs clean names at the store read now: the Go
 *     copies, services/shorts/internal/store/shorts/company_name.go and
 *     services/market-data-sync/stocklist/company_name.go, are identical to
 *     this formatter (ticker and plain-word tables included), so the API serves
 *     "BHP Group". This formatter still repairs the rows stored that way.
 *  2. Raw ASIC / metadata names that are still SHOUTED ("BHP GROUP LIMITED").
 *
 * `formatCompanyName` repairs both at the display layer:
 *  - a word equal to the stock code (case-insensitive) always renders
 *    uppercase - "Bhp Group" + BHP → "BHP Group";
 *  - an all-caps source is title-cased, but 1-3 letter all-caps acronyms in
 *    that source keep their case - "BHP GROUP LIMITED" + BHP → "BHP Group";
 *  - trailing entity/security suffixes (LIMITED, LTD, ...) are dropped;
 *  - a mixed-case name is otherwise left alone - this never re-cases prose.
 *
 * Pure and dependency-free, so it is safe in both server and client chains.
 */

// Entity/security suffixes that add nothing to a display heading. The
// ORDINARY/ORD/CDI descriptors come from the ASIC PRODUCT field (e.g.
// "4DMEDICAL LIMITED ORDINARY"), which reaches the UI wherever names are read
// off the shorts table rather than company-metadata.
const TRAILING_SUFFIX =
  /[\s,]+(LIMITED|LTD\.?|CORPORATION|CORP\.?|INCORPORATED|INC\.?|PLC|N\.?L\.?|ORDINARY|ORD|CDI(\s+1:1)?)$/i;

/**
 * The ASIC PRODUCT field is `<company name> <security type> [qualifiers…]`:
 * "FIDUCIAN GROUP LTD ORDINARY FULLY PAID", "LENDLEASE GROUP FPO/UNITS
 * STAPLED", "BLOCK INC CDI 1:1 NYSE", "FLETCHER BUILDING ORD FOR. EXEMPT NZX",
 * "GRAINCORP LIMITED A CLASS ORDINARY". Everything from the FIRST security-type
 * token onward is instrument metadata, never part of the company name - so cut
 * there rather than trying to enumerate every trailing qualifier and venue.
 * Measured over 819 live ASIC names this takes the residual-descriptor rate
 * from 10.5% to 0%.
 */
// The trailing guard is "not followed by a letter" rather than \b, so the
// space-less "CDI1:1FOREXEMPT NYSE" form matches too (\b fails between the
// "I" and the "1", both word characters).
const SECURITY_TYPE =
  /[\s,]+(ORDINARY|ORD|FPO|CDI|UNITS?|STAPLED|NOTES?|[A-Z]\s+CLASS)(?![A-Za-z])/i;

const TOKENS = /([^A-Za-z0-9]+)/;

// Lowercased inside a title-cased name (never as the first word).
const MINOR_WORDS = new Set(["of", "and", "the", "for", "in", "on", "de"]);

// ASX tickers that stay capitals in any source: a word whose upper-case form is
// here is written upper even in a mixed-case name ("Qbe Insurance Group" reads
// "QBE Insurance Group"). RIO is deliberately absent: "Rio Tinto" is a word.
// Mirrors companyTickerWords in services/shorts/internal/store/shorts/company_name.go.
const TICKER_WORDS = new Set([
  "BHP", "CSL", "NAB", "ANZ", "QBE", "AMP", "IAG", "CBA", "WBC", "S32", "REA", "ASX",
]);

// Short English words a shouted name uses that are not acronyms: "RED METAL
// LIMITED" reads "Red Metal", while "NIB HOLDINGS" keeps its acronym. Mirrors
// plainShortWords in the same Go file.
const PLAIN_SHORT_WORDS = new Set([
  "AIR", "ALL", "ARK", "BAY", "BIG", "FOX", "GAS", "HOT", "ICE", "JET", "KEY",
  "LOW", "MAX", "NEW", "OIL", "OLD", "ONE", "RED", "SEA", "SKY", "SUN", "TOP",
  "WAY",
]);

/**
 * Upper-case the first LETTER, not the first character - a token can start
 * with a digit ("4DMEDICAL"), and capitalising position 0 there would leave
 * the whole word lowercase ("4dmedical" instead of "4Dmedical").
 */
function titleCaseWord(word: string): string {
  const firstLetter = word.search(/[A-Za-z]/);
  if (firstLetter < 0) return word;
  return (
    word.slice(0, firstLetter) +
    word.charAt(firstLetter).toUpperCase() +
    word.slice(firstLetter + 1).toLowerCase()
  );
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
  // Cut the instrument metadata tail first, so the entity-suffix strip below
  // sees a real trailing suffix ("SALUDA MEDICAL, INC. CDI USPROHEXCLQIB" →
  // "SALUDA MEDICAL, INC." → "Saluda Medical"). Never cut to nothing - a name
  // that IS a security word (or starts with one) keeps its original form.
  const securityCut = cleaned.search(SECURITY_TYPE);
  if (securityCut > 0) {
    const head = cleaned.slice(0, securityCut).trim();
    if (head) cleaned = head;
  }
  // Suffixes can stack ("… LIMITED" after "… CORPORATION"), and a trailing
  // full stop ("AGL Energy Limited.") would otherwise block the anchored
  // match, so drop trailing punctuation on each pass.
  let prev = "";
  while (prev !== cleaned) {
    prev = cleaned;
    cleaned = cleaned
      .replace(/[\s.]+$/, "")
      // A trailing parenthetical is a disambiguator, not part of the name,
      // and it blocks the anchored suffix match below:
      // "Environmental Group Limited (The)" -> "Environmental Group".
      .replace(/\s*\([^()]*\)$/, "")
      .replace(TRAILING_SUFFIX, "")
      .trim();
  }
  if (!cleaned) cleaned = name.trim();

  // Re-case when the source carries NO case information of its own - either
  // SHOUTED ("BHP GROUP") or entirely lower-case ("4dmedical", which is what
  // the pre-fix backend title-caser stored for digit-leading names, since it
  // capitalised character 0 instead of the first letter). A genuinely
  // mixed-case name is assumed to carry intentional casing and is left alone.
  const isShouting = cleaned === cleaned.toUpperCase();
  const isWhispering = cleaned === cleaned.toLowerCase();
  const needsRecasing = isShouting || isWhispering;

  let wordIndex = -1;
  const parts = cleaned.split(TOKENS);
  return parts
    .map((token, i) => {
      if (!/[A-Za-z]/.test(token)) return token; // separators / numbers
      wordIndex += 1;
      // A lone letter straight after an apostrophe is a possessive/contraction
      // suffix, never an acronym: "DOMINO'S" → "Domino's", not "Domino'S".
      // Applied even to a mixed-case source, because English never capitalises
      // it - and "Domino'S" is exactly the shape already stored in
      // company-metadata by the pre-fix backend title-caser.
      if (
        wordIndex > 0 &&
        token.length === 1 &&
        /['’]$/.test(parts[i - 1] ?? "")
      ) {
        return token.toLowerCase();
      }
      if (
        code &&
        token.toUpperCase() === code &&
        (isShouting || isAcronymLike(token))
      ) {
        return code;
      }
      // A ticker that stays capitals in any source ("Rea Group" with REA).
      if (TICKER_WORDS.has(token.toUpperCase())) return token.toUpperCase();
      // A minor word mid-name is lower-case in English title case, always -
      // so this is applied to a mixed-case source too, repairing the rows the
      // old backend title-caser stored as "Bank Of Queensland" / "Bendigo And
      // Adelaide Bank". A LEADING minor word keeps its capital ("The A2 Milk").
      if (wordIndex > 0 && MINOR_WORDS.has(token.toLowerCase())) {
        return token.toLowerCase();
      }
      if (!needsRecasing) return token;
      if (MINOR_WORDS.has(token.toLowerCase())) {
        // Leading minor word is title-cased ("THE A2 MILK" → "The A2 Milk"),
        // not treated as a short acronym.
        return titleCaseWord(token);
      }
      // Short all-caps acronyms in a shouted source stay uppercase. Not
      // applied to a lower-case source, where a 3-letter token is far more
      // likely a word than an acronym.
      if (
        isShouting &&
        token.length <= 3 &&
        !PLAIN_SHORT_WORDS.has(token.toUpperCase())
      ) {
        return token.toUpperCase();
      }
      return titleCaseWord(token);
    })
    .join("");
}

// Display name for every SEO-critical surface (title, og:title, h1, crawler
// summary, schema) and the stock header. `stock.name` is the raw ASIC PRODUCT
// string - SHOUTED, with a security-type descriptor - so it goes through the
// shared formatter. Not the backend's `cleanCompanyName` (above), which is
// what mangles the acronyms this repairs.
export function cleanCompanyName(name: string, code: string): string {
  return formatCompanyName(name, code) || name;
}
