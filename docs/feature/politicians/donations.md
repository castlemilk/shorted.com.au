# Donations — the AEC funding layer

Plan of record (2026-08-01) for ingesting the AEC Transparency Register and
publishing political funding beside the register of interests. Gate:
[../../influence-editorial-standards.md](../../influence-editorial-standards.md).
Reconnaissance was done against the live bulk exports before this design; every
claim about the data below was measured, not assumed.

## 1. What the data actually is (measured 2026-08-01)

Three GET-only bulk zips at `transparency.aec.gov.au/Download/`:
**AllAnnualData** (13 CSVs, FY1998-99 → FY2024-25, ~230k rows),
**AllElectionsData** (12 CSVs, elections 1996 → 2025), **AllReferendumData**
(2023 referendum only). Regenerated continuously (amendments land mid-year) —
ingest must be idempotent snapshot-replace, never assume a published FY is
frozen. Licence: **CC BY 4.0** (aec.gov.au copyright policy; Crown copyright,
attribute "© Commonwealth of Australia"; must not imply AEC endorsement).

The load-bearing shape:

- **Party level is rich.** Party returns (totals), detailed receipts (124k
  itemised rows, recipient = party branch / associated entity / significant
  third party), donations made (66k donor-side rows). Party Returns carries
  `Party Group` — branch→party rollup is in the data.
- **Member level is thin and must be framed as such.** Annual
  MemberOfParliamentReturns: **52 rows, ~16 members, FY2020-21+** (mostly
  crossbench + a few frontbenchers). Election candidate returns: the honest
  member layer — 2025: 1,461 returns (**73% nil**), itemised donations name
  only **69 candidates**, and Climate 200 is $11.2m of the $18.7m itemised.
  A member funding surface therefore states its own coverage or it lies by
  construction.
- **Donor→ASX is a party-level story.** Exact-normalised-name matching against
  `company-metadata`: ~30 annual donors + ~155 receipts payers are listed
  companies (~$95m/2FY of receipts); election donors match **zero** listed
  companies. "Which ASX company funded my MP" has no data under the old scheme.
- **The reform commences 1 Jan 2027** ($5k threshold, near-real-time notices,
  caps); 1 Jul 2026 was transitional rules only. First new-scheme notices
  ~Feb 2027; latest FY anywhere in the corpus is 2024-25. (The editorial
  standards doc's "1 July 2026" line is corrected alongside this plan.)
- No donor-side ABN in donation rows (ABN/ACN only on third-party/campaigner
  entity returns), no addresses anywhere. Names are unnormalised (five
  spellings of one entity), whitespace-padded, and byte-identical duplicate
  rows are legitimate. The site's Kendo JSON API exposes stable
  `ClientFileId`s + authoritative recipient types — noted for v2 identity; v1
  uses normalised names + return-type context, which the CSVs support.

## 2. Editorial position

Amounts are **publishable here** (unlike the register of interests): AEC data
is CC BY 4.0 and the standards doc's own example blesses "Donated $250k (AEC)".
The rules that bind:

1. Every figure cites "AEC Transparency Register, as at DATE" and the surface
   carries the Crown-copyright attribution + no-endorsement posture.
2. **Right-censoring stated everywhere**: values below the disclosure threshold
   in force for that year are absent from the data — a low total is a
   disclosure fact, not a funding fact.
3. **Reform break annotation**: any series that will later cross 1 Jan 2027
   carries the methodology note now (threshold change, caps, cadence), so the
   chart never silently splices regimes.
4. **Attribution honesty**: donations to a party are never rendered as
   donations to a member. Member surfaces show only returns that NAME the
   member (their MP returns, their candidate returns) and state the nil-return
   and coverage facts plainly.
5. Donor→company links: exact normalised name or curated override only —
   ambiguous normalised names are dropped (82 of 4,412 company names collide
   and are excluded). Same withhold discipline as securities resolution.
6. No causal or influence vocabulary, ever. Juxtaposition with plain dates.
   "Received", "declared", "lodged". The banned list from the standards doc
   applies to every string including aria-labels and test fixtures.
7. Candidate→politician joins: surname + division + party exact (the summary
   file carries `Electorate Name`/`Party Name`), curated overrides for the
   rest, ambiguity withholds. Slugs are never guessed from names.

## 3. Data model — migration `000105_add_aec_donations` (namespaced `aec_`)

Deliberately OUTSIDE the register subsystem: these tables carry `amount_cents`
(bigint) columns lawfully; the register's no-magnitude guard tests scan the
register migrations and must stay untouched. All tables carry
`source_url`, `source_licence` ('CC-BY-4.0'), `snapshot_at`.

- `aec_party_returns` — FY, party name (verbatim), party group, totals
  (receipts/payments/debts) in cents.
- `aec_receipts` — FY, return_type, recipient name (verbatim + normalised),
  received_from (verbatim + normalised), receipt_type, amount_cents,
  occurrence counter (byte-identical duplicates are real).
- `aec_donations_made` — FY, donor name (verbatim + normalised), made_to
  (verbatim + normalised), date, amount_cents, occurrence.
- `aec_mp_returns` — FY, return_type (member/senator), member name verbatim,
  total_donations_cents, donor_count, `politician_id` nullable FK (resolved).
- `aec_candidate_returns` — election event, candidate name verbatim, party,
  electorate name/state, nil_return, total_gift_cents, donor_count,
  expenditure_cents, amendment_no, `politician_id` nullable FK.
- `aec_candidate_donations` — election event, candidate name verbatim, donor,
  date, amount_cents, `candidate_return` linkage.
- `aec_entity_aliases` — the single curated control surface (mirrors
  `register_security_aliases`): normalised name → {company stock_code |
  politician_id | party group | ignore}, curated_by/at, note. The resolvers
  read this FIRST, then exact rules, never fuzzy.
- `mv_aec_party_funding` — party group × FY rollups (receipts, donations,
  donor counts, listed-company donor counts/amounts) for the explorer.
- Company matching table/view: normalised-name exact join to
  `company-metadata` excluding the 82 ambiguous names, plus curated aliases.

Politician resolution rules (order): curated alias → MP-return name matched to
exactly one politician by honorific-stripped surname + given name →
candidate matched by division + surname + (party where recorded) to exactly
one politician holding that division in the matching parliament. Anything else
stays NULL (published under its verbatim name only on party-level surfaces,
never on a member page).

## 4. Pipeline — `shorted influence -mode aec-donations`

Separate mode from the existing evidence feed (`aec.go` keeps feeding
industry-intelligence untouched; shared fetch/normalisation helpers extracted,
not duplicated). Downloads the three zips, parses (reusing `aec.go`'s
FY/date/amount parsing + trim/`\xa0` handling), snapshot-replaces the `aec_*`
tables in one transaction, runs resolution, refreshes the MV. Idempotent;
`REGISTER_DRY_RUN` conventions do not apply (this is not the register) but a
`-dry` flag prints counts without writing. Excluded from `-mode all` like the
register modes. Dead series (2001/2004 media files) and the referendum zip are
parsed but only counted in v1.

## 5. Surfaces (v1)

1. **`/politicians/donations` — the funding explorer** (server, ISR, no
   searchParams; client island for filters like the activity page):
   - Party funding by FY: receipts + declared donations per party group
     (stacked per-party bars or small multiples, house SVG kit, amber+party
     colours), FY selector, right-censoring note, reform-break methodology
     note.
   - **Top donors** (FY-scoped, party-filterable): verbatim-name rows with
     amounts, listed-company chips (exact/curated matches only) linking to
     `/shorts/{code}`.
   - **Listed-company donors rail**: the ~155-company juxtaposition — company,
     total paid to each party group in the FY, receipt-type split (donation vs
     "other receipt" vs subscription — the distinction is in the data and must
     be rendered; a conference fee is not a donation).
   - Coverage/methodology band: what a return is, thresholds by year, the 2027
     reform note, attribution, report-an-error.
2. **Profile: "Funding returns" section** — ONLY when the member resolves to
   MP returns or candidate returns: their annual MP-return totals, their
   election returns (including "lodged a nil return for the 2025 election" —
   a publishable fact), itemised donors where they exist. Coverage sentence
   always ("Itemised election donations exist for 69 of 1,451 candidates in
   2025."). Absent data renders nothing.
3. **Hub cross-link** card to the explorer.
4. Compare/party pages: v2. New-scheme real-time feed: build the ingest hook
   in v2 when the AEC ships it (~2027).

## 6. Verification gates

Go + jest suites as the register layer (vocabulary sweeps extended with the
funding-specific bans), parity test for new public rpcs
(`GetDonationsOverview`, `ListPartyFunding`, `ListTopDonors`,
`GetPoliticianFunding`), migration guard test for the `aec_` namespace (cents
integers only, licence columns present, no register table touched), dev-DB
ingest run with measured row counts matching the recon inventory, adversarial
review round (three lenses incl. an attribution-honesty lens), live browser
pass, bundle budgets. Prod rollout: migration 000105 hand-applied (session
pooler) → merge → run `-mode aec-donations` once → flush.
