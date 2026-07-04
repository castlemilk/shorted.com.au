# Influence Layer — Editorial Standards & Data Licensing

Gate for everything published under Track A (donations, contracts, tax,
MP interests, lobbying, integrity data). Every surface — cards, explorers,
editorial features, newsroom articles, tweets — must pass this document.

## 1. The defamation posture (read this first)

Australia is the most plaintiff-friendly defamation jurisdiction in the
English-speaking world. Under the (post-2021) uniform Acts we get a
serious-harm threshold and a public-interest defence, but neither is a safe
harbour: **truth (justification) is the primary defence, and the risk is
imputation — what a reasonable reader takes the material to insinuate, not
what it literally says.** A page that lays out true facts can still convey a
defamatory imputation through headline, juxtaposition framing, iconography,
or selective emphasis.

### Hard rules

1. **Publish primary-source facts with citations.** Every figure links to the
   register/dataset/document it came from, with an as-at date.
2. **Juxtaposition, not accusation.** "Donated $250k (AEC); won $40M in
   tenders (AusTender)" is publishable. "Bought influence", "cash for
   contracts", "corrupt" attached to a named entity is not — ever, in any
   surface including tweets, OG images, chart titles, and alt text.
3. **No causal language between money and outcomes** unless a court or
   integrity body has made that finding (then cite the finding). Banned verbs
   next to a named entity: bribed, bought, rigged, corrupt(ed), rorted,
   kickback. Permitted framing: "received", "was awarded", "declared",
   "disclosed", "coincided with" is BORDERLINE — prefer plain dates.
4. **Integrity-body material**: report allegations as allegations with the
   body's own wording ("NACC is investigating…", "ICAC found…"). Never
   upgrade an investigation to a finding. Include outcomes (cleared/dismissed)
   with the same prominence when they exist.
5. **MP interests**: registers disclose *what* is held, never quantity or
   value. Never state or imply portfolio size, returns, or trading profit.
   "Holds shares in X (Register of Members' Interests, as at DATE)" only.
6. **Right-of-reply for editorial features** (not for automated data cards):
   any feature article centring a living person or a specific company's
   conduct gets a documented attempt to contact them before publication.
7. **Corrections**: a visible corrections policy; fix + annotate, don't
   silently edit. Preserve the correction trail.
8. **Data disputes**: every influence surface carries a "Report an error"
   link. Disputed rows get flagged and hidden pending re-verification against
   the primary source.

### Review gates

- Automated surfaces (cards/explorers): the *template* is reviewed against
  rules 1-5 once; changes to template copy re-trigger review.
- Editorial features + newsroom output touching influence data: human review
  against this doc before publish. The newsroom grounding ledger must resolve
  every claim to a primary source (same mechanism as stock takes).
- Tweets: templates only; no free-form generation naming entities alongside
  influence data.

## 2. Accuracy standards

- **Entity resolution confidence**: donations/tenders/tax joined to an ASX
  code via the ABN spine display only at match confidence = exact ABN or
  verified manual mapping. Fuzzy name matches are analyst-only (never
  public) until verified.
- **Same-name traps**: donor names are free text; "XYZ Pty Ltd" ≠ "XYZ
  Holdings". When in doubt, don't join.
- **Temporal honesty**: AEC disclosure thresholds changed 1 July 2026
  ($16.9k → $5k, near-real-time). Never chart pre/post series as one line
  without a break annotation; totals across the boundary need a methodology
  note.
- **AusTender values are life-of-contract maximums**, not annual spend —
  label every dollar figure accordingly.
- **Tax ≠ wrongdoing**: the ATO dataset states plainly that nil tax payable
  is often legitimate (losses, offsets). The "$0 tax" framing must carry the
  ATO's own caveat and show total income + taxable income alongside tax
  payable.

## 3. Licensing audit (as at July 2026)

| Dataset | Source | Licence | Republication | Notes |
|---|---|---|---|---|
| Corporate tax transparency | ATO via data.gov.au | CC-BY 3.0 AU | Yes, with attribution | Only the 3 legislated fields exist; no profit/offsets |
| Donations / party returns | AEC Transparency Register | CC-BY 4.0 (AEC copyright notice) | Yes, with attribution | Cite "AEC Transparency Register, as at DATE"; new scheme from 2026-07-01 |
| Contract notices | AusTender / data.gov.au | CC-BY 3.0 AU (historical) / AusTender terms (weekly export) | Yes, with attribution | Verify current terms note on tenders.gov.au before launch |
| Grants | GrantConnect | CC-BY 4.0 | Yes, with attribution | |
| ABN bulk extract | ABR via data.gov.au | CC-BY 3.0 AU | Yes (spine only, not republished wholesale) | The join key for everything |
| Register of Members'/Senators' Interests | APH (PDFs) | Parliamentary material; © Commonwealth | Extracted facts OK with attribution; don't mirror PDFs wholesale | We parse primary PDFs ourselves — never ingest openpolitics.au / politiciantrades.au data |
| Lobbyist register (federal) | AGD | CC-BY 4.0 | Yes, with attribution | State registers vary — audit each before ingest |
| Ministerial diaries | NSW/QLD gov | CC-BY 4.0 (verify per dept) | Yes, with attribution | Federal has no equivalent |
| NACC / ICAC materials | Respective bodies | © the body; fair-dealing quoting | Quote + link, don't republish reports | Rule 4 applies |
| ACNC bulk data | data.gov.au | CC-BY 3.0 AU | Yes, with attribution | |

Every ingested source gets a `source_licence` value in the DB (same pattern
as `house_prices`) and an attribution line in the UI footer of any surface
that renders it. Anything not CC-licensed is gated read-path-side the way
the housing crawl tier is (and note: the audit found the housing licence
gate leaks on one read path — fix that pattern before reusing it).

## 4. Scope discipline

Public figures acting in public capacity (donations, declared interests,
awarded contracts) are in scope. Private individuals, family members not on
a register, home addresses, and any data obtained other than from official
publications are out of scope, full stop.
