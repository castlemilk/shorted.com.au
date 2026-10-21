# October newsroom review and generated assets

## Completed checks

- Read all seven articles and reviewed source-ledger verification limits. Independently downloaded 17 official ASIC CSVs and compared the 118 sidecar points marked verified: no mismatches. The separate JSON records this bounded result; it does not certify every price, company filing or derived screen rank.
- Opened NEXTDC's 21 October release through its EQS reprint, the Australian Government fuel statistics page, the 6 May fuel-security package release, and cited secondary WiseTech/shipping/oil reporting. Retained attribution and the original ledgers' access limitations rather than claiming inaccessible ASX PDFs were read.
- Removed unsupported conclusions about individual short sellers' intentions, entries, profits and covering. Corrected NEXTDC's position-date/publication-date distinction: 15 October precedes the halt, but its T+4 report was published later. Corrected Artrya's one-day multiplier to approximately 2.7.
- Kept the oil spot-price attribution but removed the unqualified five-month-high claim; the government page uses a different weekly benchmark and does not support that superlative. Clarified reserve-measure comparability and commitments exceeding the initial IEA release total.
- Generated seven distinct conceptual headers with built-in OpenAI imagegen, exported 1600×900 WebP headers and separate 800×450 thumbnails, preserved originals and exact prompts, and inspected full-size and 160×90 collection proofs. All art is explicitly credited as AI-generated illustration, never as a verified photograph or measured chart.
- Preserved the pre-existing data-drawn SVG/PNG covers and series JSON unchanged. New art replaces only editorial header/social imagery; measured figures remain in the article's tables and live chart.
- Added an exact-URL thumbnail mapping for these seven reviewed headers, with unchanged fallback for all unknown/external URLs. Only card-grid and compact story-stack images use the small variant; article headers and lead stories retain full size.
- All seven import-MDX dry runs pass. All 207 take-writer tests pass. Seven focused thumbnail/component tests pass. Production source files pass ESLint with zero warnings; this repository ignores test files in ESLint, so those are qualified by Jest instead.

## Publication boundary

This PR updates repository content and assets. Merging deploys the static asset files but does not itself import or publish the seven database-backed newsroom articles. No production database write, publication job, paid API generation, social post, credential change or infrastructure permission change was performed here. Existing article source ledgers retain their original verification scope. Exact-head hosted CI remains required before merge. Browser rendering on the live site is not claimed by local MDX and asset checks.
