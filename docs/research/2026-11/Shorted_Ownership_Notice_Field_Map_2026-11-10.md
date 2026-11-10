# Ownership notice compatibility: field map and synthetic fixtures

**Research date:** 10 November 2026. **Tracking:** [#971](https://github.com/castlemilk/shorted.com.au/issues/971). **Status:** implementation design, based on official published forms and guidance; no actual post-commencement filings were sampled.

The immediate compatibility slice should recognise the new Australian notice families, return `unsupported_format` before legacy voting-only extraction or a model call, and preserve the source and extraction attempt for later processing. This document also specifies the richer semantics needed by a later parser. The semantic fixtures below are future acceptance criteria, not a claim that the compatibility slice extracts these values.

All examples are synthetic. They contain no real holder, issuer, ACN, filing or trading signal. Dates after 10 November 2026 are deliberately future test inputs. Nothing here authorises a deployment or declares a filing legally compliant.

## 1. Official source register

| ID | Official source | Specific locations used |
|---|---|---|
| S1 | [ASIC substantial holding notice landing page](https://www.asic.gov.au/regulatory-resources/forms/forms-folder/substantial-holding-notice) | Commencement and permitted form periods; links to the official templates |
| S2 | [SHN DOCX, published 30 July 2026](https://download.asic.gov.au/media/gt4phfce/substantial-holding-notice-20260730.docx) | Items 1–12; instructions 1–14; dropdown values in the DOCX content controls |
| S3 | [Transitional Form 603](https://download.asic.gov.au/media/l3wjdjam/transitional-form-603-published-30-july-2026.pdf) | First-page title; sections 1–5; instructions 6, 7, 9 and 10 |
| S4 | [Transitional Form 604](https://download.asic.gov.au/media/o4jnxgav/transitional-form-604-published-30-july-2026.pdf) | First-page title; sections 1–4; instructions 5–7 and 9 |
| S5 | [Transitional Form 605](https://download.asic.gov.au/media/t4bd4ys1/transitional-form-605-published-30-july-2026.pdf) | First-page title; sections 1–3; instructions 2 and 7 |
| S6 | [ASIC RG 222, published 30 July 2026](https://download.asic.gov.au/media/elnnq3zb/rg222-published-30-july-2026.pdf) | RG 222.9–17, .29–30 (tables 2–3), .38–43 and .179–182 |
| S7 | [ASIC RG 5, published 30 July 2026](https://download.asic.gov.au/media/yigb4qwy/rg5-published-30-july-2026.pdf) | RG 5.184–186, .212–230 and .237–238 |
| S8 | [Treasury Laws Amendment (Strengthening Financial Systems and Other Measures) Act 2025](https://www.legislation.gov.au/C2025A00072/asmade/text) | Schedule 1: inserted Corporations Act sections 671BK, 671BL and 671BM; commencement table |

S2 was read as DOCX XML, including dropdown choices. S3–S5 were read as PDF text. These are blank official templates, not representative samples of issuer-rendered PDFs or OCR output. The marker variations and layout cases below are proposed robustness tests.

ASIC specifies the new regime from **4 December 2026** and permits the transitional templates from that date through **3 June 2027**. A transitional template is another document format within the enhanced regime, not a third set of economic meanings. The official landing page says to use the existing forms before commencement. [S1]

## 2. Recognition contract for the immediate fail-safe

### Verified positive markers

| Family | Exact observed marker | Supporting structure |
|---|---|---|
| New SHN | Standalone title `Substantial Holding Notice` | Immediately following statutory heading contains `671BB`; item 3 is `Reason for notice`; item 4 contains the A/B summary; item 6 is `Previous and present derivative-based percentages` |
| Transitional 603 | Standalone title `Transitional Form 603` | Statutory heading contains `671BB`; initial-holder form body |
| Transitional 604 | Standalone title `Transitional Form 604` | Statutory heading contains `671BB`; change-of-interests form body |
| Transitional 605 | Standalone title `Transitional Form 605` | Statutory heading contains `671BB`; cessation form body |

Sources: S2 title and items 3–6; S3–S5 first-page headings. Transitional templates also have an introductory note giving the permitted date interval. That note is corroboration, not a required marker: a completed form may omit it.

Recommended detector behaviour is deliberately separate from legal interpretation:

1. Keep line/page boundaries in the original extraction. For matching only, normalise horizontal Unicode spaces, case and repeated whitespace, remove BOM/zero-width separators, and treat a form feed as a page boundary. Allow a title to wrap across adjacent lines. Retain the raw text and match location.
2. Require a title block plus nearby statutory heading. The transitional title must end at the form number or a layout-cell boundary; a sentence beginning with the form name is insufficient. For SHN, require its holding-summary label together with either the item 3 reason selector or item 6 derivative summary. Footnotes can interrupt labels: the official C row inserts instruction number 8 before its letter code.
3. Recognise title blocks within the available text window, including a notice after a covering letter. A quoted mention in prose is not a title. A packet containing both a full legacy notice and a strongly recognised new-format notice is ambiguous: hold it as `unsupported_format`, including when accompanying prose describes the new template as reference material. An earlier legacy notice does not establish that later complete new-format structure can be safely ignored.
4. Recognised enhanced-format evidence takes precedence over the generic `603`, `604` or `605` match and over earlier legacy notice structure. Stop before direct voting extraction, LLM fallback and any ownership-row write. Record `unsupported_format`, the recognised family, source reference and detector/extractor version. Negative examples should preserve legacy prose that merely discusses reform, rather than exempting a complete attached new-format template.
5. Weak or conflicting evidence remains reviewable. A date, `SHN`, `671BB`, a reference to reform, or economic-interest terminology alone must not relabel a legacy notice. An unreadable document must not silently become a supported legacy form or a New Zealand notice.

These rules are a proposed detection contract. They are not proof that all future renderings will be recognised. Available page/text limits, unreadable titles, and image-only scans remain coverage limits. A post-commencement notice using an altered or legacy-shaped template without these markers also remains a coverage risk; date-only inference cannot solve that risk. The guard does not yet verify whether an attached new-format document is a blank reference template or an operative disclosure, so both are conservatively held when their structure is recognisable.

### Current gate fixtures

The JSON is a scenario specification. `legacy_path` means the enhanced-format detector does not intercept; it does not assert that the synthetic snippet alone is a complete parseable filing. `unsupported_format` means zero model calls and zero ownership-value writes. The preserved source/attempt is required for every held document.

```json
{
  "schema": "shorted.ownership.compatibility-gate.v1",
  "synthetic": true,
  "cases": [
    {
      "id": "shn_title_and_structure",
      "text": "Substantial Holding Notice\nCorporations Act 2001 Section 671BB\n3. Reason for notice\nInitial [x] Change [ ] Ceasing [ ]\n4. Previous and present holding percentage in the Chapter 6C body",
      "expect": {"format": "au_shn_2026", "outcome": "unsupported_format", "model_calls": 0, "ownership_writes": 0}
    },
    {
      "id": "shn_wrapped_title_after_cover",
      "text": "Synthetic cover letter\fSUBSTANTIAL\nHOLDING NOTICE\nCorporations Act 2001 Section 671BB\n4. Previous and present holding percentage in the Chapter 6C body\n6. Previous and present derivative-based percentages",
      "expect": {"format": "au_shn_2026", "outcome": "unsupported_format", "model_calls": 0, "ownership_writes": 0}
    },
    {
      "id": "transitional_603",
      "text": "Transitional Form 603\nSection 671BB, Corporations Act 2001\nNotice of initial substantial holder",
      "expect": {"format": "au_603_transitional_2026", "outcome": "unsupported_format", "model_calls": 0, "ownership_writes": 0}
    },
    {
      "id": "transitional_604_wrapped",
      "text": "Transitional\nForm 604\nSection 671BB, Corporations Act 2001\nNotice of change of interests of substantial holder",
      "expect": {"format": "au_604_transitional_2026", "outcome": "unsupported_format", "model_calls": 0, "ownership_writes": 0}
    },
    {
      "id": "transitional_605",
      "text": "Transitional Form 605\nSection 671BB, Corporations Act 2001\nNotice of ceasing to be a substantial holder",
      "expect": {"format": "au_605_transitional_2026", "outcome": "unsupported_format", "model_calls": 0, "ownership_writes": 0}
    },
    {
      "id": "legacy_annexure_mentions_reform",
      "text": "Form 604\nNotice of change of interests of substantial holder\n2. Previous and present voting power\nAnnexure A: We expect to use Transitional Form 604 after 4 December 2026. The new Substantial Holding Notice refers to section 671BB and deemed economic interests.",
      "expect": {"outcome": "legacy_path", "enhanced_format_detected": false}
    },
    {
      "id": "generic_notice_title_without_new_structure",
      "text": "Substantial Holding Notice\nForm 603\nNotice of initial substantial holder\n2. Details of voting power",
      "expect": {"outcome": "legacy_path", "enhanced_format_detected": false}
    },
    {
      "id": "form_number_in_new_template_must_not_win",
      "text": "Synthetic cover: replaces a Form 604\fSubstantial Holding Notice\nCorporations Act 2001 Section 671BB\n3. Reason for notice\nChange [x]\n4. Previous and present holding percentage in the Chapter 6C body",
      "expect": {"format": "au_shn_2026", "outcome": "unsupported_format", "model_calls": 0, "ownership_writes": 0}
    },
    {
      "id": "legacy_plus_current_shn_packet",
      "text": "Form 604\n1. Details of substantial holder\n2. Previous and present voting power\nThe earlier form is superseded by the following current notice.\fSubstantial Holding Notice\nCorporations Act 2001 Section 671BB\n3. Reason for notice\n4. Previous and present holding percentage in the Chapter 6C body",
      "expect": {"format": "au_shn_2026", "outcome": "unsupported_format", "model_calls": 0, "ownership_writes": 0}
    },
    {
      "id": "legacy_plus_complete_reference_template_is_ambiguous",
      "text": "Form 604\n1. Details of substantial holder\n2. Previous and present voting power\nAnnexure: reference template, described here as not the current notice.\fSubstantial Holding Notice\nCorporations Act 2001 Section 671BB\n3. Reason for notice\n4. Previous and present holding percentage in the Chapter 6C body",
      "expect": {"format": "au_shn_2026", "outcome": "unsupported_format", "model_calls": 0, "ownership_writes": 0}
    }
  ]
}
```

## 3. Source field map for the later semantic parser

### SHN: locations and value families

The letters are the form's identifiers, not interchangeable percentages. [S2 items 4–8; S6 table 2; S8 section 671BL]

| Code/location | Normalised meaning | Capture |
|---|---|---|
| A, item 4 | `holding_percentage` | Combined relevant/economic-interest measure; votes, percent, previous/current, movement |
| B, item 4 | `voting_power_percentage` | Voting measure; same dimensions |
| C, item 6 | `derivative_based_holding_percentage` | D + E + F |
| D, item 6 | `relatable_derivative_percentage` | Relevant interests arising through derivatives |
| E, item 6 | `deemed_physical_derivative_percentage` | Deemed interests from physically settleable derivatives |
| F, item 6 | `deemed_nonphysical_derivative_percentage` | Deemed interests from non-physically settleable derivatives |
| G, item 6 | `offsetting_short_position_percentage` | Separate disclosed offsetting measure |
| Item 5 | Relevant-interest rows | Holder, registered/entitled holder, basis, agreements, class, quantity |
| Item 7 | Deemed-economic-interest rows | Holder, basis, agreements, class, quantity |
| Item 8 | Offsetting-position rows | Holder, basis, agreements, class, quantity |
| Item 9 | Transactions | Date, affected person, category, details, consideration, class, quantity |
| Items 1–3, 10–12 | Context | Entity, discloser/group, initial/change/ceasing, associates, exemption declaration |

Item 3 supplies the reason; a correction is not a fourth checkbox. Instructions 6 and 8 require A and C respectively, including zero C. Instructions 1 and 3 distinguish unknown information from inapplicable items; items 5, 7, 8 and 12 may be removed without renumbering the remainder. Repeated class tables must retain their class identity. [S2]

The DOCX dropdowns expose these statutory-basis choices: item 5 has `608(1)(a)`, `608(1)(b)`, `608(1)(c)`, `608(2)`, `608(3)(a)`, `608(3)(b)` and `608(8)`; item 7 has `671AA`–`671AD` for physical and `671AF`–`671AI` for nonphysical derivatives; item 8 has `671AS`–`671AV`. Preserve the chosen codes and accompanying prose, not just the dropdown label. Item 9's transaction category is also accompanied by detail; its catch-all choice must remain representable. [S2 content controls and instruction 9; S6 RG 222.38–39]

### Transitional layouts

| Format | Main body | Additional data path | Consequence for extraction |
|---|---|---|---|
| 603 | Section 1 initial date; section 2 B/votes/class; sections 3–4 relevant-interest and holder rows | Instructions 6–7: denominator and derivative/offsetting measures in annexures; instruction 10: economic/offsetting transactions | B is available in a familiar table, but the table is not the complete enhanced holding |
| 604 | Section 1 change/previous-notice dates; section 2 previous/current B; sections 3–4 changes/present relevant interests | Instructions 5–6: denominator, economic/offsetting details and movement transactions in annexures | Do not treat an unparsed annexure as zero economic interest |
| 605 | Section 1 cessation/previous-notice dates; section 2 changes; section 3 associations | Instructions 2 and 7: economic/offsetting data, denominator and applicable movement in annexures | There is no main-body present-B summary; cessation does not supply a numeric zero |

Sources: S3–S5, listed sections/instructions. A is not an explicitly labelled main-table field in these templates. Preserve separately any A value actually reported in an annexure; do not manufacture A from B.

## 4. Recommended semantic contract

This section proposes storage/API semantics. It does not imply that the present database or protocol already implements them.

### Identity, format and dates

- `jurisdiction`: explicit `au`, `nz` or `unknown`; unknown Australian format is never an NZ fallback.
- `document_format`: keep distinct legacy 603/604/605, transitional 603/604/605, new SHN, supported NZ formats and unknown. Suggested names appear in the fixtures; they are not existing API enum values.
- `legal_regime`: separate from layout, e.g. `au_pre_2026_12_04`, `au_enhanced_2026_12_04`, `nz` or `unknown`. Assign from document evidence and relevant dates, retaining a reason/confidence; conflicting evidence requires review.
- `event_kind`: `initial`, `change`, `ceasing` or `unknown`. SHN uses the declared checkbox; transitional numbers map to the corresponding declared event. Missing/multiple selections are unresolved, not inferred from arithmetic.
- Keep `notice_date`, `effective_change_date`, `previous_notice_date`, market publication time and ingestion time separate. A notice dated 3 December and published 5 December is not automatically an enhanced-regime notice.
- Corrections use `supersedes_disclosure_id` or an equivalent revision relationship with evidence. A changed extraction of the same PDF uses `extraction_revision`, not a new market transaction.

### Observed values and completeness

Each measurement needs `measure`, `period`, `value_status`, decimal-string `percent`, integer-string `votes` when supplied, and a source locator. Recommended statuses are `reported`, `unknown`, `missing`, `unreadable` and `not_applicable`. Only `reported` contains a numeric value; observed zero remains distinguishable from every other status.

Preserve the existing voting-power fields as B. Introduce other measures additively; do not change an old field's meaning to A or C. Record numerator and denominator separately from security quantity. Do not multiply a rounded percent into a fabricated reported vote count.

Unknown annexure content makes extraction partial. Record whether an annexure was referenced, obtained and parsed. Never substitute zero for an absent annexure, an unrecognised class or an empty template control. Distinguish a form's example placeholders from values actually entered by a discloser.

The legal rule treating disclosed zero C as nil component measures for movement calculations is separate from the observation record. If a later compliance model needs it, store an explicit derived assertion with section 671BK(2)(a) as provenance. It must not overwrite the fact that D–G were not individually observed. [S8 section 671BK]

### Arithmetic, overlap and short positions

- A is not B + C: D is a derivative-related relevant-interest component, so that sum can double-count. Preserve A as reported.
- Validate C against D + E + F only when all necessary values are reported on compatible dates and basis. Use the source's decimal precision to define rounding tolerance. A discrepancy is a review flag; preserve the reported values.
- Keep G separate. Do not net it from A, B, C, E or F; do not equate it to Shorted's market-wide short-position series. [S7 RG 5.237–238]
- Class quantities and votes are different units. Preserve voting rights per security where stated; do not average class percentages or assume all classes have one vote. Only a complete compatible class breakdown permits a derived voting total.
- Multiple statutory bases for one interest row do not create multiple parcels. The form expressly permits multiple bases on the same row. [S2 instruction 7]
- Do not sum all named holders or associates. Shared underlying interests can overlap; physical derivatives can move between relevant-interest and deemed-interest treatment as hedging changes. [S7 RG 5.184–186, .212–230]
- Where a source establishes that an associate and discloser have the same derivative, the legislation supplies specific no-double-counting rules for E/F and G. Store that relationship and its evidence; equal quantities or similar names alone do not establish it. [S8 sections 671BL(3)–(4), 671BM(3)–(4)]

### Events, legal thresholds and provenance

A valid initial notice may have B below 5%, or even zero in the bidder case. RG 222 also explains that opposite-direction movements cannot simply be collapsed. Therefore the old voting-only plausibility threshold must not decide whether a new-format disclosure exists. [S6 RG 222.9–17]

If later work calculates statutory movement triggers, section 671BK uses **one or more percentage points**, including corresponding component changes and conditional G movements. Do not implement a strict `> 1` threshold based on the looser wording in RG 5.225. The immediate compatibility slice should make no compliance calculation. [S8 section 671BK; S7 RG 5.225]

Every observation should retain the source document identity/hash, page/section/row or text span, raw label/value, extractor version and extraction time. Append correction and extraction history; expose one clearly identified current interpretation without erasing earlier evidence. A replay of the same source and extractor version must not duplicate ownership events or user alerts.

## 5. Future semantic fixture matrix

For compactness, `pct` values below are decimal strings keyed by the official A–G codes; each is explicitly reported unless a `statuses` entry says otherwise. `votes_total` is the issuer's voting denominator. `source_fields` identifies exact form items or transitional instructions. All cases targeting enhanced formats must still produce `unsupported_format` in the current narrow slice. The expectations below apply only after a separate, reviewed semantic parser exists.

```json
{
  "schema": "shorted.ownership.semantic-scenarios.v1",
  "synthetic": true,
  "current_slice": "recognise_and_hold_only",
  "cases": [
    {
      "id": "initial_economic_holding_below_voting_threshold",
      "format": "au_shn_2026",
      "source_fields": ["S2:item3", "S2:item4:A,B", "S2:item6:C,D,E,F,G", "S2:item7"],
      "input": {"reason": "initial", "notice_date": "2026-12-07", "votes_total": "100000000", "pct": {"A": "5.50", "B": "2.00", "C": "3.50", "D": "0.00", "E": "0.00", "F": "3.50", "G": "0.00"}},
      "expect": {"event_kind": "initial", "legal_regime": "au_enhanced_2026_12_04", "legacy_voting_power_pct": "2.00", "reject_below_4_95": false}
    },
    {
      "id": "initial_bidder_with_zero_votes",
      "format": "au_shn_2026",
      "source_fields": ["S2:item3", "S2:item4", "S2:item6", "S6:RG222.15-17"],
      "input": {"reason": "initial", "declared_basis": "bidder_at_start_of_bid_period", "pct": {"A": "0.00", "B": "0.00", "C": "0.00"}},
      "expect": {"event_kind": "initial", "reject_below_4_95": false, "infer_ceasing": false}
    },
    {
      "id": "component_shift_without_change_in_c",
      "format": "au_shn_2026",
      "source_fields": ["S2:item3", "S2:item6:E,F", "S2:item9", "S8:s671BK(1)(b)"],
      "input": {"reason": "change", "previous_pct": {"A": "6.00", "B": "2.00", "C": "4.00", "D": "0.00", "E": "2.00", "F": "2.00"}, "pct": {"A": "6.00", "B": "2.00", "C": "4.00", "D": "0.00", "E": "1.00", "F": "3.00"}},
      "expect": {"event_kind": "change", "retain_event_when_c_delta_zero": true, "component_delta_pp": {"E": "-1.00", "F": "1.00"}}
    },
    {
      "id": "offsetting_short_is_separate",
      "format": "au_shn_2026",
      "source_fields": ["S2:item6:G", "S2:item8", "S7:RG5.237"],
      "input": {"pct": {"A": "6.00", "B": "2.00", "C": "4.00", "D": "0.00", "E": "0.00", "F": "4.00", "G": "2.25"}},
      "expect": {"holding_pct": "6.00", "derivative_pct": "4.00", "offsetting_pct": "2.25", "create_net_holding": false, "write_market_short_series": false}
    },
    {
      "id": "ceasing_with_residual_interest",
      "format": "au_shn_2026",
      "source_fields": ["S2:item3", "S2:item4", "S2:item6"],
      "input": {"reason": "ceasing", "pct": {"A": "4.20", "B": "3.00", "C": "1.20", "D": "0.00", "E": "0.00", "F": "1.20", "G": "0.00"}},
      "expect": {"event_kind": "ceasing", "legacy_voting_power_pct": "3.00", "force_zero": false}
    },
    {
      "id": "transitional_603_annexure_supplies_economic_measures",
      "format": "au_603_transitional_2026",
      "source_fields": ["S3:section2", "S3:instruction7", "synthetic:annexureA"],
      "input": {"notice_date": "2026-12-08", "main_pct": {"B": "2.00"}, "annexure_pct": {"A": "5.50", "C": "3.50", "D": "0.00", "E": "0.00", "F": "3.50", "G": "0.00"}},
      "expect": {"event_kind": "initial", "legal_regime": "au_enhanced_2026_12_04", "holding_pct": "5.50", "legacy_voting_power_pct": "2.00"}
    },
    {
      "id": "transitional_604_missing_annexure",
      "format": "au_604_transitional_2026",
      "source_fields": ["S4:section2", "S4:instruction6"],
      "input": {"previous_pct": {"B": "6.00"}, "pct": {"B": "5.00"}, "annexure_referenced": true, "annexure_available": false},
      "expect": {"event_kind": "change", "extraction_completeness": "partial", "statuses": {"A": "missing", "C": "missing", "D": "missing", "E": "missing", "F": "missing", "G": "missing"}, "fill_economic_zero": false}
    },
    {
      "id": "transitional_605_has_no_current_voting_summary",
      "format": "au_605_transitional_2026",
      "source_fields": ["S5:sections1-2", "S5:instruction7"],
      "input": {"cessation_date": "2026-12-09", "annexure_available": false},
      "expect": {"event_kind": "ceasing", "current_voting_power_pct": null, "current_voting_power_status": "missing", "force_zero": false}
    },
    {
      "id": "two_classes_with_different_voting_rights",
      "format": "au_shn_2026",
      "source_fields": ["S2:item4:B", "S2:item5:class_and_voting_rights"],
      "input": {"votes_total": "120000000", "pct": {"B": "5.00"}, "class_rows": [{"class": "SYNTH_ORD", "issuer_securities": "100000000", "held_securities": "4000000", "votes_per_security": "1"}, {"class": "SYNTH_PREF", "issuer_securities": "10000000", "held_securities": "1000000", "votes_per_security": "2"}]},
      "expect": {"derived_holder_votes": "6000000", "derived_voting_power_pct": "5.00", "divide_security_count_by_all_securities": false}
    },
    {
      "id": "one_parcel_multiple_relevant_interest_bases",
      "format": "au_shn_2026",
      "source_fields": ["S2:item5", "S2:instruction7"],
      "input": {"rows": [{"synthetic_parcel": "P1", "holder": "SYNTH_HOLDER", "quantity": "6000000", "legal_bases": ["608(1)(a)", "608(3)(b)"]}]},
      "expect": {"preserved_row_count": 1, "securities_in_row": "6000000", "sum_once_per_legal_basis": false}
    },
    {
      "id": "same_derivative_associate_overlap",
      "format": "au_shn_2026",
      "source_fields": ["S2:item7", "S8:s671BL(3)-(4)"],
      "input": {"votes_total": "100000000", "source_explicitly_links_same_derivative": true, "interest_kind": "F", "rows": [{"holder": "SYNTH_HOLDER", "derivative": "SYNTH_D1", "votes": "4000000"}, {"holder": "SYNTH_ASSOCIATE", "derivative": "SYNTH_D1", "votes": "3000000"}]},
      "expect": {"preserved_row_count": 2, "derived_unique_votes_for_derivative": "4000000", "sum_to_seven_million": false}
    },
    {
      "id": "reported_zero_is_not_missing_components",
      "format": "au_shn_2026",
      "source_fields": ["S2:item6:C", "S2:instructions3,8", "S8:s671BK(2)(a)"],
      "input": {"pct": {"C": "0.00"}, "component_cells_blank": ["D", "E", "F", "G"], "items_explicitly_inapplicable": [7, 8]},
      "expect": {"statuses": {"C": "reported", "D": "missing", "E": "missing", "F": "missing", "G": "missing"}, "rows7_status": "not_applicable", "rows8_status": "not_applicable", "synthesise_reported_component_zeros": false}
    },
    {
      "id": "explicit_unknown_holder_identity",
      "format": "au_shn_2026",
      "source_fields": ["S2:item5:person_entitled", "S2:instruction1"],
      "input": {"person_entitled_raw": "unknown"},
      "expect": {"person_entitled_value": null, "person_entitled_status": "unknown", "merge_with_missing": false}
    },
    {
      "id": "multiple_reason_checkboxes",
      "format": "au_shn_2026",
      "source_fields": ["S2:item3"],
      "input": {"selected_reasons": ["initial", "change"]},
      "expect": {"event_kind": "unknown", "review_reason": "conflicting_reason_selection", "jurisdiction": "au"}
    },
    {
      "id": "correction_preserves_original",
      "format": "au_shn_2026",
      "source_fields": ["synthetic:explicit_correction_statement", "S2:item4"],
      "input": {"disclosure_id": "SYNTH_CORRECTED", "explicitly_supersedes": "SYNTH_ORIGINAL", "effective_change_date": "2026-12-08", "original_pct": {"A": "6.10"}, "corrected_pct": {"A": "6.01"}},
      "expect": {"retain_original": true, "supersedes_disclosure_id": "SYNTH_ORIGINAL", "infer_new_trade": false}
    },
    {
      "id": "legacy_notice_published_after_commencement",
      "format": "au_604_legacy",
      "source_fields": ["synthetic:legacy_notice_date", "synthetic:market_publication_timestamp"],
      "input": {"notice_date": "2026-12-03", "effective_change_date": "2026-12-02", "published_at": "2026-12-05T00:00:00Z"},
      "expect": {"infer_enhanced_regime_from_publication_only": false, "preserve_document_format": "au_604_legacy"}
    },
    {
      "id": "reported_derivative_sum_conflict",
      "format": "au_shn_2026",
      "source_fields": ["S2:item6"],
      "input": {"pct": {"C": "4.00", "D": "1.00", "E": "1.00", "F": "1.00"}},
      "expect": {"review_reason": "reported_component_sum_conflict", "preserve_reported_c": "4.00", "silently_replace_c": false}
    },
    {
      "id": "replay_and_reextraction_are_not_new_events",
      "format": "au_shn_2026",
      "source_fields": ["synthetic:source_identity", "synthetic:extractor_version"],
      "input": {"source_id": "SYNTH_SOURCE", "attempt_versions": ["v1", "v1", "v2"]},
      "expect": {"disclosure_count": 1, "distinct_extraction_versions": 2, "duplicate_market_alerts": 0, "retain_attempt_audit": true}
    }
  ]
}
```

Additional boundary cases for the later parser: a transitional template outside its stated interval; a document containing contradictory dates; an unreadable or incomplete reason selector; unrecognised classes; an explicitly declared non-one voting ratio; partially hedged physical derivatives; group notices with shared interests; transaction rows with opposite-direction changes; unsigned or unattached annexure references; and unchanged template placeholders. These should retain source evidence and produce precise completeness/review flags, not fabricated observations.

## 6. Completion boundary

The narrow slice is successful when the new-family gate runs before both legacy extraction and model fallback, held attempts are visible and reprocessable, and legacy/NZ fixtures remain correctly routed. Product/API coverage must identify the unprocessed notice family; absence of an ownership row must not imply absence of a disclosed interest.

Full A–G storage, per-class/interest detail, revision linking, richer public API fields, semantic fixture execution and actual issuer-rendering/OCR validation remain separate work. Passing marker tests alone does not establish readiness to publish enhanced ownership values after commencement.

[S1]: https://www.asic.gov.au/regulatory-resources/forms/forms-folder/substantial-holding-notice
[S2]: https://download.asic.gov.au/media/gt4phfce/substantial-holding-notice-20260730.docx
[S3]: https://download.asic.gov.au/media/l3wjdjam/transitional-form-603-published-30-july-2026.pdf
[S4]: https://download.asic.gov.au/media/o4jnxgav/transitional-form-604-published-30-july-2026.pdf
[S5]: https://download.asic.gov.au/media/t4bd4ys1/transitional-form-605-published-30-july-2026.pdf
[S6]: https://download.asic.gov.au/media/elnnq3zb/rg222-published-30-july-2026.pdf
[S7]: https://download.asic.gov.au/media/yigb4qwy/rg5-published-30-july-2026.pdf
[S8]: https://www.legislation.gov.au/C2025A00072/asmade/text
