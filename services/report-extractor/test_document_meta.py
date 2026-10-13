"""document_meta (contract 2.5 / 6.1) against the shared fixture.

services/pkg/extractiontrust/testdata/document_meta_cases.json is the one
source of truth: every case's expected object is derived from its text here,
and the Go test asserts every expected object is inside the closed vocabulary.
Its "invalid" list pins validate_document_meta to extractiontrust.ParseDocumentMeta.
"""
import datetime
import json
import re

import pytest

import document_meta as dm
from extractor_test_support import fixture_path


def _fixture():
    path = fixture_path("document_meta_cases.json")
    if not path.exists():
        pytest.skip("services/pkg/extractiontrust is not in this checkout")
    return json.loads(path.read_text(encoding="utf-8"))


def _case_ids(kind):
    try:
        return [c["name"] for c in _fixture()[kind]]
    except BaseException:  # noqa: BLE001 - collection must not fail without the fixture
        return []


@pytest.mark.parametrize("name", _case_ids("cases"))
def test_fixture_case(name):
    case = next(c for c in _fixture()["cases"] if c["name"] == name)
    assert dm.extract_document_meta(case["text"], case.get("report_date")) == case["expected"]


def test_a_fixture_cases_report_date_is_read():
    # NIC's 1H26 report names a forecast for a year that ends after it was
    # lodged: read without its report date, that year is the period.
    name = "nic_a_forecast_year_ending_after_the_report_date_is_not_its_own"
    case = next(c for c in _fixture()["cases"] if c["name"] == name)
    assert dm.extract_document_meta(case["text"])["period_end"] == "2026-12-31"
    assert dm.extract_document_meta(case["text"], case["report_date"]) == case["expected"]


@pytest.mark.parametrize("name", _case_ids("invalid"))
def test_fixture_invalid_input_loses_exactly_its_bad_keys(name):
    case = next(c for c in _fixture()["invalid"] if c["name"] == name)
    assert dm.validate_document_meta(case["input"]) == case["expected"]


def test_fixture_is_not_empty():
    f = _fixture()
    assert len(f["cases"]) >= 10 and len(f["invalid"]) >= 10


def test_every_extracted_value_is_in_vocabulary():
    for case in _fixture()["cases"]:
        meta = dm.extract_document_meta(case["text"], case.get("report_date"))
        assert dm.validate_document_meta(meta) == meta, case["name"]


# --- rules beyond the fixture -------------------------------------------------


def test_empty_text():
    assert dm.extract_document_meta("") == {}
    assert dm.extract_document_meta("Company Update\nNothing to see.") == {}


def test_a_figure_is_not_a_unit_statement():
    for text in ("Revenue of $412.6m.", "NPAT of US$58.8 billion", "EBITDA $1.2bn", "Capex $000,000"):
        assert "units" not in dm.extract_document_meta(text), text


def test_typographic_apostrophe_thousands():
    meta = dm.extract_document_meta("Statement of profit or loss ($\u2019000)\nNotes ($\u2019000)")
    assert meta["units"] == "thousands"
    assert meta["units_evidence"] == "$\u2019000"


def test_nearest_thousand_dollars_agrees_with_a_thousands_header():
    text = "Amounts are rounded to the nearest thousand dollars.\nIncome statement ($'000)"
    meta = dm.extract_document_meta(text)
    assert meta["units"] == "thousands" and meta["units_evidence"] == "nearest thousand dollars"
    # ...and conflicts with a millions header.
    assert "units" not in dm.extract_document_meta(text + "\nSegment note ($m)")


def test_thousands_of_dollars_only_as_a_unit_statement():
    assert dm.extract_document_meta("presented in thousands of Australian dollars")["units"] == "thousands"
    assert dm.extract_document_meta("presented in thousands of Australian dollars")["currency"] == "AUD"
    # Prose about thousands of customers is not a unit statement.
    assert "units" not in dm.extract_document_meta("We welcomed thousands of new customers.")


def test_header_currencies_disagreeing_omit_currency():
    meta = dm.extract_document_meta("Summary (US$m)\nAustralian operations (A$m)")
    assert "currency" not in meta
    assert meta["units"] == "millions"


def test_lower_case_prefix_is_not_a_currency():
    assert "currency" not in dm.extract_document_meta("plus$m things (us$m)")


def test_period_rules():
    assert dm.extract_document_meta("for the financial year ended 30 June 2026")["period_type"] == "annual"
    assert dm.extract_document_meta("for the twelve months ended 31 Dec 2025")["period_end"] == "2025-12-31"
    meta = dm.extract_document_meta("for the half\u2013year ended 31 December 2025")
    assert (meta["period_end"], meta["period_type"]) == ("2025-12-31", "half")
    # Guidance for a future year is not a period end; neither is "as at".
    assert "period_end" not in dm.extract_document_meta("guidance for the year ending 30 June 2027")
    assert "period_end" not in dm.extract_document_meta("Balance sheet as at 30 June 2026")
    # An impossible date where the period is read is withheld, never replaced
    # by another phrase's.
    assert "period_end" not in dm.extract_document_meta(
        "for the year ended 31 June 2026. Prior: year ended 30 June 2025"
    )


# --- period: the document's own -----------------------------------------------


def _period(text, report_date=None):
    meta = dm.extract_document_meta(text, report_date)
    return meta.get("period_end", ""), meta.get("period_type", "")


# VIT's own FY26 Appendix 4E (idsId=03130179), in its stored order: a dividend
# for the prior year, the reporting-period statement, a page heading.
VIT_PRIOR_YEAR_DIVIDEND = (
    "2.4\t On 22 August 2025, the Directors resolved to pay a dividend of 0.2 cents per ordinary share "
    "franked as to 100% \n"
    "in respect of the year ended 30 June 2025. The Record Date for the dividend was 8 September 2025, and the total \n"
)
VIT_STATEMENT = "1.\t The reporting period covers the year ended 30 June 2026. \n"
VIT_PREVIOUS_STATEMENT = "The previous reporting period covers the year ended 30 June 2025.\n"
VIT_HEADING = "1   |   VITURA HEALTH LIMITED  ASX APPENDIX 4E FOR THE YEAR ENDED 30 JUNE 2026\n"
# A later period named elsewhere that is a document's own: ARG's 1H26 Appendix
# 4D (idsId=03058019) names its half so.
LATER_OWN_HALF = "Limited and its controlled entity (Argo or Company), for the half-year ended 31 December 2025.\n"


def test_the_reporting_period_statement_not_the_first_period_named():
    # The first period VIT's 4E names is the prior year's dividend. Read as its
    # own, it kept the company's FY26 results off the stock page and out of picks.
    text = VIT_PRIOR_YEAR_DIVIDEND + VIT_STATEMENT + VIT_PREVIOUS_STATEMENT + VIT_HEADING
    assert _period(text, "2026-08-26") == ("2026-06-30", "annual")
    assert _period(text) == ("2026-06-30", "annual")


def test_the_statement_decides_over_a_later_period_named():
    # ACE's FY25 Appendix 4E (idsId=02985130) sets the label over its value; a
    # later half named after it does not move the period.
    statement = "Reporting period:\nFor the year ended 30 June 2025\nPrevious period:\n"
    assert _period(statement + LATER_OWN_HALF, "2026-09-25") == ("2025-06-30", "annual")
    # ...nor with the stop words a text layer drops.
    assert _period("1. reporting period covers year ended 30 June 2025.\n" + LATER_OWN_HALF, "2026-09-25") == \
        ("2025-06-30", "annual")
    # "Financial reporting period" is the same label.
    assert _period("Financial reporting period: year ended 30 June 2026\nfor the half-year ended 31 December 2026\n") == \
        ("2026-06-30", "annual")
    # AKG's label carries a qualifier in brackets (its 4E is in the fixture).
    assert _period("Reporting Period (RP):  Financial year ended 30 June 2026 (FY26)\n"
                   "for the half-year ended 31 December 2026\n") == ("2026-06-30", "annual")
    # A statement whose period ends after the report date (a slip in its year)
    # is not the document's own either, nor one ending on it.
    assert _period("Reporting period: year ended 30 June 2027\nfor the year ended 30 June 2026\n", "2026-08-20") == \
        ("2026-06-30", "annual")
    assert _period("Reporting period: half-year ended 13 March 2026\nfor the half year ended 31 December 2025\n",
                   "2026-03-13") == ("2025-12-31", "half")


def test_another_periods_statement_is_never_the_documents_own():
    # "The previous reporting period ..." states no period of the document's
    # own, and never outranks a later one named elsewhere.
    assert _period(VIT_PREVIOUS_STATEMENT) == ("", "")
    assert _period(VIT_PREVIOUS_STATEMENT + LATER_OWN_HALF, "2026-09-25") == ("2025-12-31", "half")
    # BPH's FY26 Appendix 4E (idsId=03132748) sets each label over its value,
    # the previous period's label not alone on its line.
    text = ("Financial Year Ended \nYear ended 30 June 2026 \nPrevious Corresponding Reporting Period \n"
            "Year ended 30 June 2025 \n")
    assert _period(text, "2026-08-31") == ("2026-06-30", "annual")
    # PCK's FY26 Appendix 4E (idsId=03132658) wraps that label a word to a
    # line: the words that make it another period's are on the lines above.
    text = ("Financial Year Ended \n30 June 2026 \nPrevious \nCorresponding \nReporting \nPeriod \n"
            "Year Ended 30 June 2025 \n")
    assert _period(text, "2026-08-28") == ("2026-06-30", "annual")


def test_a_line_of_prose_ending_in_the_reporting_period_is_not_a_label():
    # Only a label alone on its line (or after an item number, "The", "This"
    # or "Details of (the)") sets its value on the next line.
    text = ("Appendix 4E\nFor the year ended 30 June 2026\nDividends paid during the reporting period:\n"
            "For the year ended 30 June 2025 final dividend of 5.0 cents per share paid 15 September 2025\n")
    assert _period(text, "2026-08-25") == ("2026-06-30", "annual")
    # ...and the same on one line.
    assert _period("Appendix 4E\nFor the year ended 30 June 2026\nDividends paid during the reporting period: "
                   "year ended 30 June 2025\n", "2026-08-25") == ("2026-06-30", "annual")
    # FSA's FY26 Appendix 4E (idsId=03125331) labels its period "Details of
    # the reporting period", which decides over a later period named, and so
    # do VIT's "1. The reporting period covers ..." and QGL's FY26 Appendix 4E
    # (idsId=03146589), "This reporting period" over its range.
    later = "for the half-year ended 31 December 2026\n"
    assert _period("Details of the reporting period \n \nFinancial Year Ended \n30 June 2026 \n" + later) == \
        ("2026-06-30", "annual")
    assert _period(VIT_STATEMENT + later) == ("2026-06-30", "annual")
    assert _period("This reporting period\t\n" + "\t\n" * 7 + "1 July 2025 to 30 June 2026\n" + later) == \
        ("2026-06-30", "annual")


def test_a_period_still_to_be_reported_is_not_the_documents_own():
    # VIG's FY2025 annual report (idsId=03144078), lodged on 25 September 2026,
    # names its own year four times; its events after the reporting period
    # name a later half it is still to report.
    text = (
        "Annual Report - 30 June 2025 \n"
        "and the entities it controlled at the end of, or during, the year ended 30 June 2025. \n"
        "For the year ended 30 June 2025 sales revenue increased by 3% to $8,751,555 (2024: $8,498,254) and gross "
        "profit increased \n"
        "During the year ended 30 June 2025, the Company completed the acquisition of a 25% equity interest in LIT "
        "Technology Pty \n"
        "The acquisition was a non-adjusting event after the reporting period and therefore no adjustment was made "
        "to the FY2025 \n"
        "financial statements. The investment to be fully impaired in FY2026 and to be disclosed in the financial "
        "report for the half-year \n"
        "ended 31 December 2025. \n"
    )
    assert _period(text, "2026-09-25") == ("2025-06-30", "annual")
    assert _period(text) == ("2025-06-30", "annual")
    # Any of the lead's verbs, with no clause break before the period, within
    # the 80 characters before it.
    for lead in ("will be reported in the financial report for the", "to be included in the accounts for the",
                 "will be recognised in the", "will be presented in the financial report for the",
                 "to be released with the results for the", "to be lodged with the accounts for the",
                 "will be recognised in the financial statements of the Group for the"):
        assert _period(f"for the year ended 30 June 2025.\nThe gain {lead} half-year ended 31 December 2025.\n") == \
            ("2025-06-30", "annual"), lead
    assert _period("The results will be reported to shareholders. For the half-year ended 31 December 2025, revenue "
                   "rose.\n") == ("2025-12-31", "half")
    # A dividend that will be paid for a year is that year's (HLS's FY26
    # Appendix 4E, idsId=03126849), with or without a report date.
    for report_date in ("2026-08-19", None):
        assert _period("No final dividend will be paid for the year ended 30 June 2026.\n", report_date) == \
            ("2026-06-30", "annual"), report_date
    # With a report date, the lead counts only for a period that ended 6 or
    # more calendar months before it: VIG's half ended 9 before. Within 6 the
    # half is read, as a document lodged on time names its own (below).
    assert _period(text, "2026-06-24") == ("2025-06-30", "annual")
    within_6_months = ("A final dividend of 1.0 cent per share was paid for the year ended 30 June 2025.\n"
                       "Further details will be included in the financial report for the half-year ended 31 December "
                       "2025\n")
    assert _period(within_6_months, "2026-05-25") == ("2025-12-31", "half")
    assert _period(within_6_months, "2026-06-24") == ("2025-06-30", "annual")
    # The cost (pinned so a change is deliberate): VIG's own report, had it
    # been lodged within 6 months, would read the half.
    assert _period(text, "2026-05-25") == ("2025-12-31", "half")


def test_a_document_lodged_on_time_may_name_its_own_period_as_still_to_be_reported():
    # Within 6 months of its period's end the lead is no reason to drop it:
    # each of these is the document's own period, after a prior-year dividend
    # line that would otherwise decide.
    dividend = "A final dividend of 1.0 cent per share was paid for the year ended 30 June 2025.\n"
    for line, report_date, want in (
        ("Further details will be included in the financial report for the half-year ended 31 December 2025\n",
         "2026-02-24", ("2025-12-31", "half")),
        ("The audited accounts are expected to be released with the Annual Report for the year ended 30 June 2026\n",
         "2026-08-20", ("2026-06-30", "annual")),
        ("The accounts will be presented at the AGM for the year ended 30 June 2026\n",
         "2026-08-20", ("2026-06-30", "annual")),
        ("The gain is to be recognised in the half-year ended 31 December 2025\n",
         "2026-02-20", ("2025-12-31", "half")),
    ):
        assert _period(dividend + line, report_date) == want, line
    # Alone, it was no period at all.
    assert _period("Shares to be released from escrow on the results for the year ended 30 June 2026\n",
                   "2026-08-25") == ("2026-06-30", "annual")


def test_a_late_documents_own_period_is_the_one_it_names_most():
    # An FY2025 annual report lodged on 25 September 2026 names a later half
    # that ended 9 months before; its own year is named more often.
    text = ("for the year ended 30 June 2025.\nDuring the year ended 30 June 2025, sales rose.\n"
            "Subsequent to year end, during the half-year ended 31 December 2025, the Company raised $2.0 million\n")
    assert _period(text, "2026-09-25") == ("2025-06-30", "annual")
    # Only more than 7 calendar months after the latest month, and only with a
    # report date.
    assert _period(text, "2026-08-25") == ("2025-06-30", "annual")
    assert _period(text, "2026-07-25") == ("2025-12-31", "half")
    assert _period(text) == ("2025-12-31", "half")
    # A tie still reads the later month.
    assert _period("for the year ended 30 June 2025.\nOn 27 February 2026 the Company released its results for the "
                   "half-year ended 31 December 2025\n", "2026-09-25") == ("2025-12-31", "half")
    # The rule does not know the document's kind: a late half-year report that
    # names the prior year more often than its half reads the year (pinned so
    # a change is deliberate).
    late_4d = ("Appendix 4D\nHalf-year ended 31 December 2024\nThis report should be read in conjunction with the "
               "annual report for the year ended 30 June 2024.\nA final dividend was paid in October 2024 for the year "
               "ended 30 June 2024.\n")
    assert _period(late_4d, "2025-09-30") == ("2024-06-30", "annual")
    assert _period(late_4d, "2025-02-24") == ("2024-12-31", "half")


def test_a_mention_of_the_reporting_period_states_none():
    # 29M's 1H26 Appendix 4D (idsId=03130836): a sentence naming the prior
    # corresponding period after "the Reporting Period" is not the statement;
    # the half its pages are headed with is the period.
    text = (
        "There were no associates or joint ventures during the Reporting Period, or the half-year ended 30 June 2025 "
        "(the ‘Prior Corresponding Period’).  \n"
        "Appendix 4D and Half-Year Financial Report for 29Metals Limited and its Controlled Entities for the half-year "
        "ended 30 June 2026 \n"
    )
    assert _period(text, "2026-08-27") == ("2026-06-30", "half")


def test_a_4d_reporting_period_and_its_previous_corresponding_period():
    text = ("Reporting period: half-year ended 31 December 2025\n"
            "Previous corresponding period: half-year ended 31 December 2024\n")
    assert _period(text) == ("2025-12-31", "half")
    # ACL's Appendix 4D (idsId=03060337) sets each label over its value.
    text = ("Current reporting period:\nHalf-year ended 31 December 2025\n"
            "Previous reporting period:\nHalf-year ended 31 December 2024\n")
    assert _period(text, "2026-02-16") == ("2025-12-31", "half")
    # AKG's qualifier, XRF's 12-month period.
    assert _period("Reporting Period (RP):  Financial year ended 30 June 2026 (FY26)\n") == ("2026-06-30", "annual")
    assert _period("Details of the reporting period and the previous corresponding period: \n"
                   "Reporting period – 12-month period ended 30 June 2026 \n"
                   "Previous corresponding period – 12-month period ended 30 June 2025 \n") == ("2026-06-30", "annual")


def test_an_annual_report_naming_the_prior_half_and_year_reads_its_own_year():
    # QuickFee's FY26 Appendix 4E and annual report (idsId=03127953) names the
    # prior year first, then its own year and the half of an interim dividend.
    text = (
        "Previous corresponding period:     year ended 30 June 2025\n"
        "Additional information supporting the Appendix 4E disclosure requirements can be found in the review of \n"
        "operations and activities and the financial statements for the year ended 30 June 2026.\n"
        "An interim ordinary dividend of 0.5 cents per share was paid in March 2026 in respect of the half-year ended \n"
        "31 December 2025. No dividends of QuickFee Limited were paid for the previous financial period. Directors of \n"
        "QuickFee Limited approved a final ordinary dividend in respect of the year ended 30 June 2026.\n"
    )
    assert _period(text, "2026-08-21") == ("2026-06-30", "annual")


def test_a_period_ending_on_or_after_the_report_date_is_not_the_documents_own():
    # NIC's 1H26 report (idsId=03130351) names a sales quota "for the year
    # ended 31 December 2026".
    text = ("the consolidated financial statements for the half-year ended 30 June 2026.  \n"
            "9.0 million wmt to 14.3 million wmt for the year ended 31 December 2026. \n")
    want = ("2026-06-30", "half")
    assert _period(text, "2026-08-26") == want
    assert _period(text, datetime.date(2026, 8, 26)) == want
    assert _period(text, datetime.datetime(2026, 8, 26, 9, 30)) == want
    # Anything else is no report date.
    for bad in ("26/08/2026", "2026-08-26T09:30:00", "2026-02-30", 20260826):
        assert _period(text, bad) == _period(text), bad
    # BGD's 1H26 report (idsId=03072033): its auditor's declaration names the
    # day it was signed, the day the report was lodged.
    text = ("Barton Gold Holdings Limited \nACN 633 442 618 \nFinancial Report \nfor the half year ended 31 December 2025 \n"
            "Gold Holdings Limited for the half-year ended 13 March 2026. I declare that, to the best of my knowledge "
            "and belief, there \n")
    assert _period(text, "2026-03-13") == ("2025-12-31", "half")


def test_ends_compare_by_month_and_the_type_most_phrases_give():
    # C7A's FY26 annual report (idsId=03146180) has one slip among its
    # contents: a day that does not exist never outranks its month...
    contents = (
        "for the Year Ended 30 June 2026 ........ 25 \n"
        "Statement of Changes in Equity for the Year Ended 30 June 2026 ........ 27 \n"
        "Statement of Cash Flows for the Year Ended 31 June 2026 ........ 28 \n"
        "Notes to the Consolidated Financial Statements for the Year Ended 30 June 2026 ........ 29 \n"
    )
    assert _period(contents, "2026-09-30") == ("2026-06-30", "annual")
    # ...but where it is the month's first, the period is withheld.
    assert _period(contents.split("\n", 2)[2], "2026-09-30") == ("", "")
    # SGR's FY26 Appendix 4E (idsId=03133185) sets a table's "Half year ended"
    # over "30 June 2026" before its own "year ended 30 June 2026".
    text = (
        "Year ended \nHalf year ended \n30 June 2026\n31 December 2025\n"
        "Preliminary Final Report\nfor the year ended 30 June 2026\n"
        "Financial Statements for the year ended 30 June 2026, and the media release lodged with the ASX on 31 August 2026.  \n"
        "1  No dividend was declared for the year ended 30 June 2026.  \n"
    )
    assert _period(text, "2026-08-31") == ("2026-06-30", "annual")
    # ARG's Appendix 4D (idsId=03058019) breaks its first "Half -year" with a
    # space, once read as "year ended" and outvoted by the halves after it; it
    # is a half-year itself now.
    text = (
        "Results for announcement to the market\nHalf -year ended 31 December 2025\n"
        "Comparative figures being the half-year ended 31 December 2024\n"
        "Limited and its controlled entity (Argo or Company), for the half-year ended 31 December 2025.\n"
        "As lead auditor of Argo Investments Limited’s financial report for the half-year ended 31 December 2025 \n"
    )
    assert _period(text, "2026-02-09") == ("2025-12-31", "half")


def test_a_half_year_period_or_a_month_count_period_is_a_period_phrase():
    # AVE's 1H26 Appendix 4D (idsId=03130095) names its half only as a
    # "half-year period"; otherwise its comparatives and the prior year of an
    # R&D refund were all it named.
    text = (
        "or 'Avecho') and the entities it controlled at the end of, or during, the half-year period ended 30 June 2026 "
        "(the 'period'). \n"
        "Total revenue decreased by 89% to $59,602 for the period (half-year ended 30 June 2025: $560,069), reflecting the \n"
        "Development (R&D) Tax Incentive Scheme in respect of eligible R&D expenditure incurred during the year ended 31 \n"
        "December 2025. \n"
    )
    assert _period(text, "2026-08-26") == ("2026-06-30", "half")
    # GRR's 1H26 Appendix 4D (idsId=03133655).
    assert _period("The interim financial report for the six-month period ended 30 June 2026 has been prepared in "
                   "accordance with\n") == ("2026-06-30", "half")


def test_a_range_ends_its_period_when_it_is_one_half_or_one_year():
    # GNG's FY26 accounts (idsId=03128898) write their year only as a range
    # after "ended": its end is the period's, never its first day.
    assert _period("Group” or “consolidated entity”) for the financial year ended 1 July 2025 to "
                   "30 June 2026 (FY26) and the independent\n", "2026-08-24") == ("2026-06-30", "annual")
    # NHC's FY26 Appendix 4E (idsId=03139480) labels its year "Current period",
    # the value a range on the next line (the fixture has its whole head).
    assert _period("A. Statutory results\nCurrent period\t\nFrom 1 August 2025 to 31 July 2026\nPrevious period\t\n"
                   "From 1 August 2024 to 31 July 2025\n", "2026-09-15") == ("2026-07-31", "annual")
    # A statement's range decides as its phrase would: DGT's 1H26 Appendix 4D
    # (idsId=03062475) puts a kind before it, CCL's FY26 Appendix 4E
    # (idsId=03127365) a dash in it, ADH's (idsId=03128778) a 52-week year.
    assert _period("Reporting period: \nFor the half-year from 1 July 2025 to 31 December 2025 \n"
                   "for the year ended 30 June 2025\n", "2026-02-20") == ("2025-12-31", "half")
    assert _period("Current reporting period: \n01 July 2025 - 30 June 2026 \nPrior corresponding reporting period: \n"
                   "01 July 2024 - 30 June 2025 \n", "2026-08-20") == ("2026-06-30", "annual")
    assert _period("Current period:\t \t\n\t\n30 June 2025 to 28 June 2026 (52 weeks)\nPrior corresponding period:\t\n"
                   "1 July 2024 to 29 June 2025 (52 weeks)\n", "2026-08-24") == ("2026-06-28", "annual")
    # A previous period's range is never read (DGL's FY26 Appendix 4E,
    # idsId=03133803).
    assert _period("Prior corresponding reporting period:\n1 July 2024 - 30 June 2025\n", "2026-08-31") == ("", "")
    # CM8's half-year report heads a comparison so: it runs backwards.
    assert _period("Comparison of half-year ended 31 December 2025 to 31 December 2024 \n") == ("", "")
    # A range is one half or one year, give or take a week (a 27-week half,
    # EDV's 1H26, ran from 30 June 2025 to 4 January 2026), and its kind word
    # must agree; otherwise it states no period, whatever else is named.
    assert _period("Reporting period: 30 June 2025 to 4 January 2026\n", "2026-03-04") == ("2026-01-04", "half")
    for text in ("Reporting period: 1 June 2025 to 30 June 2026\n",  # a 13-month first period
                 "Reporting period: 1 October 2025 to 30 June 2026\n",  # nine months
                 "Reporting period: half-year from 1 July 2025 to 30 June 2026\n",
                 "for the half-year ended 1 July 2025 to 30 June 2026\n",
                 "Reporting period: year ended 31 December 2025 to 31 December 2024\n"):  # a year, backwards
        assert _period(text, "2026-08-31") == ("", ""), text
    # Its end is held to the report date like any other.
    assert _period("Current period: 1 July 2025 to 30 June 2026\nfor the half-year ended 31 December 2025\n",
                   "2026-06-30") == ("2025-12-31", "half")
    # BFG's 1H26 Appendix 4D (idsId=03124877) runs January to June, 180 days.
    assert _period("Current period: \n \n            1 January 2026 to 30 June 2026 \nPrevious corresponding period: \n \n"
                   "            1 January 2025 to 30 June 2025 \n", "2026-08-13") == ("2026-06-30", "half")
    # A 53-week year.
    assert _period("Current period: 29 June 2025 to 5 July 2026\n", "2026-08-25") == ("2026-07-05", "annual")
    # A range with an impossible date states no period, and the search goes
    # on to the next statement; an impossible end in a phrase withholds it.
    assert _period("Current period: 1 July 2025 to 31 June 2026\nReporting period: year ended 30 June 2026\n"
                   "for the half-year ended 31 December 2025\n") == ("2026-06-30", "annual")
    assert _period("Reporting period: year ended 31 June 2026\nfor the year ended 30 June 2025\n") == ("", "")
    # "<kind> ended <d1> to <d2>" is still a phrase its line can introduce as the
    # comparison.
    assert _period("Comparative figures are for the financial year ended 1 July 2024 to 30 June 2025\n",
                   "2026-08-24") == ("", "")


def test_a_dashed_range_after_ended_is_a_range():
    # GNG's defect in another spelling: the first day is never the end. fold()
    # makes an en or em dash a hyphen.
    for dash in ("-", "\u2013", "\u2014"):
        assert _period(f"for the financial year ended 1 July 2025 {dash} 30 June 2026 (FY26)\n", "2026-08-24") == \
            ("2026-06-30", "annual"), dash
    # The same span, kind and comparison checks as "to".
    for text in ("Comparison of half-year ended 31 December 2025 - 31 December 2024\n",
                 "for the half-year ended 1 July 2025 - 30 June 2026\n",
                 "Comparative figures are for the financial year ended 1 July 2024 - 30 June 2025\n"):
        assert _period(text, "2026-08-31") == ("", ""), text
    # A first day that runs on into "to" or "- <day Month>" is never an end,
    # even where what follows is no full date.
    for sep in (" to ", " - "):
        assert _period(f"for the financial year ended 1 July 2025{sep}30 June (FY26)\n", "2026-08-24") == ("", ""), sep
    # A range may wrap on either side of its dash, or set the dash on a line of
    # its own (AI1's layout); its first day is never the end.
    for wrapped in ("1 July 2025 -\n30 June 2026", "1 July 2025\n– 30 June 2026", "1 July 2025 \n- \n30 June 2026",
                    "1 July 2025 – 30 June 2026"):
        assert _period(f"for the financial year ended {wrapped} (FY26)\n", "2026-08-24") == ("2026-06-30", "annual"), \
            wrapped
    assert _period("Reporting period: financial year ended 1 July 2025\n– 30 June 2026\n"
                   "for the year ended 30 June 2026\n", "2026-08-24") == ("2026-06-30", "annual")
    # So a phrase over a bulleted date less than a half later states no
    # period, a range that is no half or year (no stored text is so).
    assert _period("Dividend for the half-year ended 31 December 2025\n- 15 March 2026: payment date\n",
                   "2026-02-24") == ("", "")


def test_a_half_year_broken_by_a_space_is_a_half_year():
    # NWH's 1H26 results (idsId=03061986) wrap "half-" at a line's end; NXT's
    # (idsId=03065047) and VGN's (idsId=03066107) do the same. Each read as
    # annual from the "year ended" after the break.
    assert _period("NRW Holdings Limited (ASX: NWH) is pleased to announce its financial results for the half-\n"
                   "year ended 31 December 2025 (HY26). NRW has reported revenue of $2.0 billion for the \n",
                   "2026-02-19") == ("2025-12-31", "half")
    # VGN's stored lines 25-27, the hyphen on a line of its own.
    assert _period("derived from the consolidated interim financial statements in Virgin Australia’s Interim "
                   "Financial Report for the half\n-\nyear ended 31 December 2025 which have been reviewed by Virgin "
                   "Australia’s auditor.\n", "2026-02-27") == ("2025-12-31", "half")
    for kind in ("half- year", "half - year", "half -year", "half year", "half-year", "halfyear", "half\nyear"):
        assert _period(f"for the {kind} ended 31 December 2025\n", "2026-02-24") == ("2025-12-31", "half"), kind
    # Any space between, as QBE's 1H26 4D (idsId=03125036) sets "Half Year"
    # with U+202F.
    for space in (" ", " ", " ", " "):
        assert _period(f"Half{space}Year ended 30 June 2026\n", "2026-08-14") == ("2026-06-30", "half"), ascii(space)
    assert _period("Reporting period: Half Year ended 30 June 2026\nfor the year ended 31 December 2025\n",
                   "2026-08-14") == ("2026-06-30", "half")
    # With no hyphen, never across a blank line: a sentence that ends "half"
    # over a table's "Year ended" is a year.
    assert _period("Revenue grew strongly in the first half\n\nYear ended 30 June 2026\nRevenue 10.0\n",
                   "2026-08-26") == ("2026-06-30", "annual")


def test_a_statement_after_an_item_letter_bullet_or_form_feed():
    # The label-only rule's leads: an item number in its other forms ("1)",
    # "(1)", "1:", "Item 1 -"), a letter or roman numeral item, a bullet, a
    # form feed. The statement decides over a later period named.
    for lead in ("A. ", "a) ", "(a) ", "Item 1 ", "Item 1. ", "\u2022 ", "- ", "* ", "\u00b7 ", "\f",
                 "1) ", "(1) ", "1: ", "Item 1: ", "Item 1 - ", "1 - ", "i. ", "ii. ", "iv) ", "(iv) "):
        assert _period(lead + "Reporting period: year ended 30 June 2025\nfor the half-year ended 31 December 2025\n") == \
            ("2025-06-30", "annual"), lead


def test_a_header_row_of_labels_states_no_period():
    # Labels in a row, then their values in the same order: "Current period"
    # is not over its own value.
    for label in ("Current period", "Reporting period", "Current reporting period"):
        assert _period(f"Previous corresponding period\n{label}\nYear ended 30 June 2025\nYear ended 30 June 2026\n",
                       "2026-08-25") == ("2026-06-30", "annual"), label
    assert _period("Previous corresponding period (pcp)\nCurrent period\nHalf-year ended 31 December 2024\n"
                   "Half-year ended 31 December 2025\n", "2026-02-24") == ("2025-12-31", "half")
    # Its values may start as a statement's value may.
    for lead in ("For the ", ": ", "- the ", "- ", "being the "):
        assert _period(f"Previous corresponding period\nCurrent period\n{lead}year ended 30 June 2025\n"
                       f"{lead}year ended 30 June 2026\n", "2026-08-25") == ("2026-06-30", "annual"), lead
    # A row of ranges is skipped too; ranges are read only in a statement, so
    # nothing is left to state the period.
    assert _period("Previous corresponding period\nCurrent period\n1 July 2024 to 30 June 2025\n1 July 2025 to 30 June 2026\n",
                   "2026-08-25") == ("", "")
    # A wrapped heading's tail above the label is no header row when the line
    # after its value starts with a label: the statement decides.
    assert _period("1. Details of the reporting period and the\nprevious corresponding period\nReporting period:\n"
                   "Year ended 30 June 2025\nPrevious corresponding period: Year ended 30 June 2024\n"
                   "On 27 February 2026 we released results for the half-year ended 31 December 2025\n",
                   "2026-09-25") == ("2025-06-30", "annual")
    # ADH's FY26 Appendix 4E (idsId=03128778) wraps its item 1 heading right
    # above its label, which is over its own value: its 52-week year.
    adh = ("1.\t \x07DETAILS OF THE CURRENT REPORTING PERIOD AND THE PRIOR \nCORRESPONDING\u00a0PERIOD\n"
           "Current period:\t \t\n\t\n30 June 2025 to 28 June 2026 (52 weeks)\nPrior corresponding period:\t\n"
           "1 July 2024 to 29 June 2025 (52 weeks)\n")
    assert _period(adh, "2026-08-24") == ("2026-06-28", "annual")
    # ...and so it is, wrapped a word earlier: its value is followed by a label,
    # not by another value.
    assert _period(adh.replace("AND THE PRIOR \nCORRESPONDING", "AND THE \nPRIOR CORRESPONDING"), "2026-08-24") == \
        ("2026-06-28", "annual")
    # "CORRESPONDING PERIOD" alone, a heading's tail, is no other period's
    # label, even with the prior period's value right under its own.
    assert _period(adh.replace("Prior corresponding period:\t\n", ""), "2026-08-24") == ("2026-06-28", "annual")
    # A label with its value on its own line is never in a header row,
    # whatever is above it: it decides over a later period named.
    assert _period("Previous corresponding period\nReporting period: half-year ended 31 December 2025\n"
                   "Half-year ended 31 December 2024\nfor the half-year ended 30 June 2026\n") == ("2025-12-31", "half")


def test_a_period_introduced_as_the_comparison_is_not_the_documents_own():
    # NHC's FY26 Appendix 4E (idsId=03139480), Santos's 2025 Appendix 4E
    # (idsId=03061561) and 4DX's FY26 Appendix 4E (idsId=03132205) name their
    # comparative period so: alone, it gives no period, never the comparative.
    assert _period("1.\tPercentage movements relate to the previous comparative period being the full year ended "
                   "31 July 2025. Highlights reflect 80 per cent interest  \n", "2026-09-15") == ("", "")
    assert _period("Comparisons are made to the financial year ended 31 December 2024. \n", "2026-02-18") == ("", "")
    assert _period("(previous corresponding period: Year ended 30 June 2025) \n", "2026-08-28") == ("", "")
    # Only before the phrase on its own line, with no clause break between.
    assert _period("Profit rose 12% on the prior year. For the half-year ended 31 December 2025, revenue was $4.2m\n") == \
        ("2025-12-31", "half")
    # ...and within the 80 characters before it (this "versus" is 89 before).
    assert _period("Revenue grew versus last year as new contracts from the expanded customer base came online during "
                   "the half-year ended 31 December 2025\n") == ("2025-12-31", "half")


def test_report_kind_order():
    assert dm.extract_document_meta("Appendix 4D\nAppendix 4E")["report_kind"] == "appendix_4e"
    assert dm.extract_document_meta("Interim Financial Report")["report_kind"] == "half_year_report"
    assert dm.extract_document_meta("FY26 Results Presentation")["report_kind"] == "other"
    assert dm.extract_document_meta("Results announcement. A webcast follows.")["report_kind"] == "results_announcement"


def _kind(text):
    return dm.extract_document_meta(text).get("report_kind", "")


def test_presentation_currency_and_basis_of_presentation_are_not_other():
    # Standard AASB wording in real financial statements (review C7 / C10).
    for text in (
        "Condensed interim financial statements\nfor the half-year ended 31 December 2025\n"
        "Functional and presentation currency\n",
        "Financial report for the half-year ended 31 December 2025\nBasis of preparation and presentation currency\n",
        "Contents\nBasis of presentation\nNotes to the financial statements\n",
        "Directors' report\nThe presentation of the financial statements has changed.\n",
    ):
        assert _kind(text) == "", text


def test_a_sentence_mentioning_a_presentation_or_webcast_is_not_other():
    for text in (
        "FY26 Results\nAn investor presentation and webcast will be held at 11am.\n",
        "Numbat Energy Limited\nFY26 Results\nInvestor briefing: management will host a results presentation and webcast\n",
        "1H26 Results\nThis release should be read in conjunction with the accompanying investor presentation.\n",
        "FY26 Results\nA briefing will be webcast live at 10am.\n",
        "FY26 Results\nWebcast details\nResults webcast: 10am AEST\n",
        "FY26 Results\nPillar 3 disclosures are released today.\n",
    ):
        assert _kind(text) == "", text


def test_other_only_in_the_head():
    # Past the first 400 characters (or the first five lines) a heading is a
    # slide or a section of the document, not its own name.
    filler = "Revenue rose on higher volumes across every segment\n" * 9
    assert _kind(filler + "Investor Presentation\n") == ""
    assert _kind("FY26 Results\nline\nline\nline\nline\nInvestor Presentation\n") == ""
    # A long sentence straddling the 400th character is taken whole, so it
    # is never cut into something that reads as a heading.
    lead = "x" * 380 + "\n"
    assert _kind(lead + "A results presentation will be held at 10am\n") == ""


def test_a_document_that_names_itself_other():
    for text in (
        "FY26 Results Presentation",
        "Investor Presentation - August 2026\nBilby Health Limited\n",
        "Investor Presentation \u2013 August 2026\n",  # typographic dash, folded
        "Investor Presentation May 2026\n",
        "Bilby Health Limited\nHalf Year Results Investor Presentation\n",
        "Half Year Results Presentation\n",
        "Transcript: FY26 results briefing\n",
        "Bilby Health Limited\nEarnings Call Transcript\n19 August 2026\n",
        "Bilby Health Limited\nFY26 Results Webcast\n",
        "Half Year Basel III Pillar 3 Disclosure\nas at 31 December 2025\n",
        # The heading outranks a results subtitle beneath it.
        "FY26 Full Year Results Presentation\nFull year results for the year ended 30 June 2026\n",
    ):
        assert _kind(text) == "other", text


def test_results_release_and_full_or_half_year_results_in_the_head():
    assert _kind("Bilby Health Limited\nResults Release\n") == "results_announcement"
    assert _kind("Bilby Health Limited\nFY26 Full Year Results\n") == "results_announcement"
    assert _kind("Bilby Health Limited\n1H26 Half-Year Results\n") == "results_announcement"
    assert _kind("Bilby Health Limited\nHALF YEAR RESULTS\nA webcast follows\n") == "results_announcement"
    # Only in the head: a presentation's slides say "half year results"
    # throughout, which does not make the deck a results announcement.
    filler = "Operations update and outlook for the group\n" * 10
    assert _kind(filler + "Our half year results were strong\n") == ""
    # A results presentation / briefing / call is not a results announcement.
    for text in ("Half Year Results Briefing\n", "Full Year Results Call\n", "Half year results teleconference\n"):
        assert _kind(text) != "results_announcement", text


def test_fixture_entities():
    # The same list extractiontrust's TestDocumentMetaFixtureEntities asserts
    # against cleanEntity: stored entities from prod and the name each states.
    entities = _fixture()["entities"]
    assert len(entities) >= 20
    for e in entities:
        assert dm.clean_entity(e["raw"]) == e["clean"], e["raw"]
        assert dm.clean_entity(e["clean"]) == e["clean"], e["clean"]
        assert dm.validate_document_meta({"entity": e["raw"]}).get("entity", "") == e["clean"], e["raw"]


def test_entity_skips_an_auditor_and_names_a_trust():
    # An annual report's first ABN is often its auditor's (AXR's subsidiary
    # statements, read 2026-10: Grant Thornton Audit): the next ABN names the
    # reporting entity, so a subsidiary's accounts still fail the entity check.
    text = (
        "Grant Thornton Audit Pty Ltd ABN 41 127 556 389\n"
        "Auditor's Independence Declaration\n"
        "Sturt Exploration Pty Ltd ABN 12 345 678 901\n"
    )
    assert dm.extract_document_meta(text)["entity"] == "Sturt Exploration Pty Ltd"
    # Only an auditor is skipped: a first ABN with no name before it still
    # yields no entity, never a later registry or adviser.
    assert "entity" not in dm.extract_document_meta(
        "ABN 12 345 678 901\nShare registry: Computershare Investor Services Pty Limited ABN 48 078 279 277\n"
    )
    # A trust's documents are lodged by its responsible entity; the trust is
    # the entity, named after the responsible entity's ABN.
    assert dm.extract_document_meta(
        "Equity Trustees Limited ABN 46 004 031 298, the Responsible Entity of Dominion Income Trust 1\n"
    )["entity"] == "Dominion Income Trust 1"
    assert dm.extract_document_meta(
        "Pinnacle Fund Services Limited (ABN 29 082 494 362) as responsible entity for Plato Global Alpha Fund\n"
    )["entity"] == "Plato Global Alpha Fund"
    # "the Scheme" names no scheme: the responsible entity stays.
    assert dm.extract_document_meta(
        "Ausbil Investment Management Limited ABN 26 076 316 473 as responsible entity of the Scheme\n"
    )["entity"] == "Ausbil Investment Management Limited"


def test_entity_rules():
    assert dm.extract_document_meta("Name of entity: Gecko Ltd ABN 11 000 000 000")["entity"] == "Gecko Ltd"
    # A bare label with the value on the next line (a form's table cell).
    assert dm.extract_document_meta("Name of entity\nGecko Resources Limited\n")["entity"] == "Gecko Resources Limited"
    assert "entity" not in dm.extract_document_meta("Name of entity\nABN or equivalent company reference\n")
    # A possessive before ABN is prose, not a name.
    assert "entity" not in dm.extract_document_meta("The Company's ABN 49 004 028 077 is listed.")


# --- entity: what the document says about itself -----------------------------


def _entity(text):
    return dm.extract_document_meta(text).get("entity", "")


def _go_source(name):
    path = fixture_path("document_meta_cases.json").parent.parent / name
    if not path.exists():
        pytest.skip("services/pkg/extractiontrust is not in this checkout")
    return path.read_text(encoding="utf-8")


def test_a_field_about_another_entity_is_skipped():
    # VIT's own Appendix 4E (idsId=03130179) was read as "Cortexa Pty Ltd", the
    # joint venture it deconsolidated, and withheld (its cover: the fixture).
    text = (
        "10.\t During the year ended 30 June 2026, the Company gained or lost control over the following entities:\n"
        "Name of entity\nCortexa Pty Ltd\nControl gained or lost\nLost\nType of transaction\n"
    )
    assert _entity(text) == ""
    # The same field on one line (a collapsed layout) is skipped too.
    assert _entity("Name of entity Cortexa Pty Ltd Control gained or lost Lost Type of transaction\n") == ""
    # IFG's Appendix 4E (idsId=03133776) read as "Prodigy9., Co Ltd", the
    # subsidiary it lost: a heading sentence above the field, labels under it.
    text = (
        "The following table shows the detail of entities over which control has been lost.\n"
        "Name of entity\nProdigy9., Co Ltd\nDate control lost\n1 June 2026\nCountry of incorporation\n"
    )
    assert _entity(text) == ""
    # Either alone is enough: the section heading, or the field's own labels on
    # its next two non-empty lines.
    assert _entity("7. Details of associates and joint venture entities\nName of entity\nAteria Health Limited\n") == ""
    for label in ("Date of the gain or loss of control", "% holding", "Ownership interest",
                  "Percentage holding", "Date of change in control", "Place of incorporation"):
        assert _entity(f"Name of entity\nCortexa Pty Ltd\n{label}\n") == "", label
    assert _entity("Name of entity (or group of entities)\nCortexa Pty Ltd\n") == ""


def test_after_a_skipped_field_the_next_field_then_the_abn_rule():
    # MFD's Appendix 4D (idsId=03133788): its control gained field names the
    # new subsidiary; the ABN rule then reads the company from its header.
    text = (
        "MAYFIELD CHILDCARE LIMITED (ABN: 53 604 970 390 HALF-YEAR REPORT - PERIOD ENDED 30 JUNE 2026\n"
        "Control over other entities\n"
        "Name of entity: Mayfield Childcare 360 Pty Ltd\nDate control gained: 26 March 2026\n"
    )
    assert _entity(text) == "MAYFIELD CHILDCARE LIMITED"
    text = (
        "4. Loss of Control Over Entities\nName of Entity:\nSRJ Technology Limited\nDate of Control lost:\n"
        "25 February 2026\n5. Dividends\nNot applicable\nAppendix 4E\n"
        "Name of entity\nGecko Resources Limited\nABN\n12 345 678 901\n"
    )
    assert _entity(text) == "Gecko Resources Limited"
    # A field straight after a skipped one reads that field's labels as its
    # heading, and is skipped too (a run of control fields, FRE's or AUA's).
    text = (
        "4. Loss of Control Over Entities\nName of Entity:\nSRJ Technology Limited\nDate of Control lost:\n"
        "Name of entity\nGecko Resources Limited\nABN\n12 345 678 901\n"
    )
    assert _entity(text) == ""


def test_the_reporting_entitys_own_field_is_kept():
    assert _entity("Appendix 4E\nPreliminary final report\n1. Company details\nName of entity:\n"
                   "Adisyn Ltd\nABN:\n30 155 473 304\nReporting period:\n") == "Adisyn Ltd"
    # "and its controlled entities" is not control gained or lost.
    assert _entity("BPH Energy Limited and its controlled entities\nAPPENDIX 4E - PRELIMINARY FINAL REPORT\n"
                   "Name of Entity\nBPH Energy Limited\nABN\n41 095 912 002\n") == "BPH Energy Limited"
    assert _entity("Name of Entity Whitehaven Coal Limited\nABN 68 124 425 396\n"
                   "Whitehaven Coal Limited and its controlled entities results for announcement\n") == "Whitehaven Coal Limited"
    # Neither a company named Control nor one named Associate is a section.
    assert _entity("Appendix 4E\nName of entity: Control Bionics Limited\nABN: 12 345 678 901\n") == "Control Bionics Limited"
    assert _entity("Associate Global Partners Limited and Controlled Entities\nAppendix 4E\n1. Company details\n"
                   "Name of entity:\nAssociate Global Partners Limited\nABN:\n") == "Associate Global Partners Limited"


def test_a_numbered_label_is_the_same_field():
    # WhiteHawk's half-year report (idsId=03133632) and SRJ's Appendix 4D (the
    # fixture) number the field as the form's item 1.
    assert _entity("Appendix 4D - Half Year Report\n1. Name of Entity\n\n\nWhiteHawk Limited\n"
                   "ABN 97 620 459 823\n") == "WhiteHawk Limited"
    assert _entity("10.1 Name of entity: Gecko Ltd\n") == "Gecko Ltd"
    # ...and is skipped the same way under a control heading.
    assert _entity("4. Loss of Control Over Entities\n4.1 Name of Entity\nSRJ Technology Limited\n") == ""


def test_a_lone_registration_line_names_the_entity_above_it():
    # IFG's Appendix 4E (idsId=03133776) states no ABN; its letterhead sets the
    # ACN under the company's name, and its control lost field is skipped.
    text = (
        "InFocus Group Holdings Limited (ASX: IFG)\nACN: 096 870 978\nifghltd.com.au\n"
        "The following table shows the detail of entities over which control has been lost.\n"
        "Name of entity\nProdigy9., Co Ltd\nDate control lost\n1 June 2026\nCountry of incorporation\n"
    )
    assert _entity(text) == "InFocus Group Holdings Limited"
    # An ABN, ARSN or ARBN alone on its line too (WhiteHawk's half-year report,
    # Lowell Resources Fund's Appendix 4E, SRJ's half-year accounts).
    assert _entity("WhiteHawk Limited\nABN 97 620 459 823\n") == "WhiteHawk Limited"
    assert _entity("Lowell Resources Fund (ASX: LRT)\nARSN 093 363 896\nAppendix 4E\n") == "Lowell Resources Fund"
    assert _entity("30 June 2026\nSRJ Technologies Group Plc\nARBN 642 229 856\n30 June 2026\n") == "SRJ Technologies Group Plc"


def test_a_subsidiarys_own_accounts_name_the_subsidiary():
    # AXR filed Sturt Exploration Pty Ltd's accounts (idsId=03133576). Their
    # only ABN is the auditor's, which the ABN rule skips; the cover's ACN line
    # names the subsidiary, so the entity check withholds the document.
    text = (
        "2025\nANNUAL FINANCIAL\nSTATEMENTS\nSturt Exploration Pty Ltd\nACN: 146 287 809\n\n"
        "For the Year Ended 30 June 2025\n"
        "Grant Thornton Audit Pty Ltd ACN 130 913 594 a subsidiary or related entity of Grant Thornton "
        "Australia Limited ABN 41 127 556 389 ACN 127 556 389.\n"
    )
    assert _entity(text) == "Sturt Exploration Pty Ltd"


def test_the_registration_line_rule_reads_only_what_the_others_do_not():
    # A field, or a name before an ABN, decides first.
    assert _entity("Name of entity: Gecko Resources Limited\nGecko Holdings Pty Ltd\nACN 123 456 789\n") == \
        "Gecko Resources Limited"
    assert _entity("Gecko Resources Limited ABN 11 000 000 000\nGecko Holdings Pty Ltd\nACN 123 456 789\n") == \
        "Gecko Resources Limited"
    # A name before an ACN, ARSN or ARBN on the same line is never read: it is
    # as often another company, in prose (NPM's report) or one stapled entity
    # of several (WOT's letterhead).
    assert _entity("NewPeak announced the acquisition of Goldstrike Mining Pty Ltd ACN 629 011 196 ('Goldstrike')\n") == ""
    assert _entity("WOTSO (ASX: WOT)\nA stapled security comprising:\nOstow Limited (ACN 636 701 267)\n"
                   "Planloc Limited (ACN 062 367 560)\n") == ""


def test_a_registration_line_under_another_organisation_is_skipped():
    # An auditor's, as in the ABN rule (ADY's annual report).
    assert _entity("For personal use only\nIn.Corp Audit & Assurance Pty Ltd\nABN 14 129 769 151\nLevel 1\n") == ""
    # A name under a role label: CDO's corporate directory (CDM's is in the
    # fixture) lists its manager with the manager's ABN.
    text = ("SECRETARY:\n\nWayne Davies\n\nMANAGER OF THE COMPANY:\n\nCadence Asset Management Pty Limited\n\n\n"
            "ABN: 68 106 551 062\n\nREGISTERED OFFICE:\n")
    assert _entity(text) == ""
    # LF1's directory: the fund first, then its custodian and responsible
    # entity under their roles, which are never read.
    text = (
        "The Fund\nLa Trobe Private Credit Fund\nARSN 686 964 312\nThe Custodian\nPerpetual Corporate Trust Limited\n"
        "ACN 000 341 533\nThe Responsible Entity of The Fund\nLa Trobe Financial Asset Management Limited\n"
        "ACN 007 332 363\n"
    )
    assert _entity(text) == "La Trobe Private Credit Fund"
    assert _entity(text.split("ARSN 686 964 312\n", 1)[1]) == ""
    # One of a list of entities, a registration line above its name: MGX's
    # subsidiaries (the fixture has the list under MGX itself).
    assert _entity("ABN: 45 100 105 388\nBROCKMAN MINERALS PTY LTD\nABN: 75 094 634 401\n") == ""


def test_the_second_line_of_a_wrapped_name_names_no_one():
    # A cover name wrapped over two lines leaves only legal forms and industry
    # words above the registration line (GL1's and LGM's annual reports; BMR's
    # is in the fixture): no entity, never "Resources Limited".
    assert _entity("Global Lithium\nResources Limited\nABN 58 626 093 150\nAnnual Financial\n") == ""
    assert _entity("Legacy Minerals\nHoldings Limited\nABN 43 650 398 897\nAnnual Report for the\n") == ""


# The same table as extractiontrust's TestCleanEntityFormerName.
_FORMER_NAMES = {
    "Ocean Sciences Ltd (formerly BPH Global Ltd)": "Ocean Sciences Ltd (formerly BPH Global Ltd)",
    "Altoro Metals Limited (ASX:ARO) (formerly Variscan Mines Limited)":
        "Altoro Metals Limited (formerly Variscan Mines Limited)",
    "Altoro Metals Limited (formerly Variscan Mines Limited) (ASX:ARO)":
        "Altoro Metals Limited (formerly Variscan Mines Limited)",
    "Racura Oncology Ltd (formerly known as Race Oncology Limited)":
        "Racura Oncology Ltd (formerly known as Race Oncology Limited)",
    "Ocean Sciences Ltd (formerly BPH Global Ltd) ABN 57 009 104 330": "Ocean Sciences Ltd (formerly BPH Global Ltd)",
    "Ocean Sciences Ltd (formerly )": "Ocean Sciences Ltd",
    "Moore Australia Audit (WA)": "Moore Australia Audit",
    "ASX: OCN (formerly BPH Global Ltd)": "",
    "T +61 2 8777 7777 (formerly 9999 9999)": "",
    "Ocean Sciences Ltd (FORMERLY BPH GLOBAL LTD)": "Ocean Sciences Ltd (FORMERLY BPH GLOBAL LTD)",
    "Ocean Sciences Ltd (previously BPH Global Ltd)": "Ocean Sciences Ltd (previously BPH Global Ltd)",
    "Ocean Sciences Ltd (previously known as BPH Global Ltd)": "Ocean Sciences Ltd (previously known as BPH Global Ltd)",
    "(formerly BPH Global Ltd), ": "",
    "(formerly BPH Global Ltd) (ASX: BP8)": "",
    "(formerly A Ltd) (formerly B Ltd)": "",
    "Name: (formerly BPH Global Ltd) Limited": "",
    "((formerly BPH Global Ltd)), ": "",
}


def test_a_former_name_stays_after_the_name():
    # BP8's own FY26 annual report (idsId=03145583, in the fixture) was
    # withheld as "Ocean Sciences Ltd": the company on record is "Bph Global".
    for raw, want in _FORMER_NAMES.items():
        assert dm.clean_entity(raw) == want, raw
    # The checks for a company's ending and its own token look past the
    # bracket. ARO's financial report (idsId=03145453) sets its ASX code and
    # its former name after its name: a sketch that kept the bracket but read
    # the ending off the whole line read no entity there. BST's Appendix 4E
    # puts its former name in the field's value.
    assert _entity("Financial Report\nFor the year ended\n30 June 2026\n"
                   "Altoro Metals Limited (ASX:ARO) (formerly Variscan Mines Limited)\nABN: 16 003 254 395\n") == \
        "Altoro Metals Limited (formerly Variscan Mines Limited)"
    assert _entity("Appendix 4E \nPreliminary final report \n1. Company details \nName of entity: \n"
                   "Boresight Ltd (formerly Boresight Pty Ltd) \nABN: \n") == "Boresight Ltd (formerly Boresight Pty Ltd)"
    # The name itself must still name a company: a former name lends it no
    # token of its own.
    assert _entity("Resources Limited (formerly Gecko Resources Limited)\nABN 58 626 093 150\n") == ""
    # A colon after "formerly" is the same bracket (the fixture's entities
    # carry it and the other cases for both languages).
    assert _entity("Ocean Sciences Ltd (Formerly: BPH Global Ltd)\nABN 57 009 104 330\n") == \
        "Ocean Sciences Ltd (Formerly: BPH Global Ltd)"


def test_a_former_name_alone_states_no_name():
    # Whichever rule reads it: a field's value, the text before an ABN, the
    # line above a registration line.
    assert _entity("Name of entity: (formerly Foo Limited)\n") == ""
    assert _entity("Name of entity\n(formerly Foo Limited)\n") == ""
    assert _entity("Ocean Sciences Ltd\n(formerly BPH Global Ltd) ABN 57 009 104 330\n") == ""
    assert _entity("Ocean Sciences Ltd\n(formerly BPH Global Ltd)\nABN 57 009 104 330\n") == ""
    # ...whatever follows the bracket: the trim once left "formerly BPH Global
    # Ltd)", which the entity check matched to Bph Global. The ABN rule reads
    # only the ABN's own line, cut at the ABN, so the name above it is not
    # read, and no registration line stands alone: no entity.
    assert _entity("Ocean Sciences Ltd\n(formerly BPH Global Ltd), ABN 57 009 104 330\n") == ""
    assert _entity("Name of entity: (formerly Foo Limited).\n") == ""
    assert _entity("Name of entity: (formerly BPH Global Ltd) (ASX: BP8)\n") == ""
    # ...and after the trim's characters, a dash, a comma or ":-".
    for lead in ("- ", "– ", ", "):
        assert _entity(f"Ocean Sciences Ltd\n{lead}(formerly BPH Global Ltd), ABN 57 009 104 330\n") == "", lead
    assert _entity("Name of entity :- (formerly BPH Global Ltd)\n") == ""


def test_a_proprietary_companys_former_name_is_not_kept():
    # A subsidiary's own accounts (AXR filed Sturt Exploration Pty Ltd's,
    # idsId=03133576) must not match the parent through an old name.
    assert _entity("Sturt Exploration Pty Ltd (formerly Axiant Resources Exploration Pty Ltd)\nACN: 146 287 809\n") == \
        "Sturt Exploration Pty Ltd"
    # ...however the legal form is written (the fixture's entities carry both).
    assert _entity("Sturt Exploration Proprietary Limited (formerly Axiant Resources Exploration Proprietary Limited)\n"
                   "ACN: 146 287 809\n") == "Sturt Exploration Proprietary Limited"
    assert dm.clean_entity("Sturt Exploration Pty. Ltd. (formerly Axiant Resources Exploration Pty. Ltd.)") == \
        "Sturt Exploration Pty. Ltd"
    # BST's Appendix 4E keeps its own former name: the company is no longer a
    # Pty Ltd.
    assert dm.clean_entity("Boresight Ltd (formerly Boresight Pty Ltd)") == "Boresight Ltd (formerly Boresight Pty Ltd)"


def test_a_labelled_name_under_a_control_heading_is_not_read_above_a_registration_line():
    # The field rule skips it; the registration line under it must not read it
    # back (the next registration line is under a list's, so nothing is read).
    text = ("Appendix 4E\nControl lost over entities\nEntity name: Cortexa Pty Ltd\nACN 123 456 789\n"
            "Vitura Health Limited\nACN 629 071 594\n")
    assert _entity(text) == ""
    # Only a labelled one: IS3's 1H26 report (idsId=03133770) sets its own page
    # header right after that section of its Appendix 4D.
    text = ("6. Details of associates and joint venture entities \n \nNot applicable. \n \n \nFor personal use only\n"
            "\n\nI SYNERGY GROUP LIMITED \nACN: 613 927 361  \n")
    assert _entity(text) == "I SYNERGY GROUP LIMITED"
    # The heading up to three lines above the labelled line, and "of" is that
    # label too.
    assert _entity("Control lost over entities\nThe entity was sold on 1 June 2026\nConsideration: $5m\n"
                   "Company name: Cortexa Pty Ltd\nACN 123 456 789\n") == ""
    assert _entity("Control lost over entities\nof Cortexa Pty Ltd\nACN 123 456 789\n") == ""
    # A label over the company's own name is read (AKG's amended Appendix 4E,
    # idsId=03137734, in the fixture).
    assert _entity("APPENDIX 4E: PRELIMINARY FINAL REPORT \n1.\nCompany details\n"
                   "Name: Academies Australasia Group Limited\nABN: 93 000 003 725\n") == \
        "Academies Australasia Group Limited"


def test_a_responsible_entitys_letterhead_names_the_trust():
    # CQR's letterhead is in the fixture. Its second half alone: a role with
    # only its preposition after it introduces the name under it.
    assert _entity("Responsible entity of\nCharter Hall Retail REIT\nABN 34 357 213 849\n"
                   "Level 20, No.1 Martin Place\n") == "Charter Hall Retail REIT"
    # The phrase may name the trust itself, after licence lines of any spelling
    # (CDP's letterhead, its responsible entity's ABN and AFSL on lines of
    # their own).
    assert _entity("Scentre Management Limited\nABN 41 001 670 579\nAFSL No. 230329\n"
                   "as responsible entity of Carindale Property Trust\nARSN 093 261 744\n") == "Carindale Property Trust"
    assert _entity("Gecko Funds Management Limited\nACN 123 456 789\n"
                   "in its capacity as responsible entity for the Gecko Property Fund\n") == "Gecko Property Fund"
    # "the Scheme" names no trust: the responsible entity stays.
    assert _entity("Gecko Funds Management Limited\nACN 123 456 789\nas responsible entity of the Scheme\n") == \
        "Gecko Funds Management Limited"
    # Up to five registration and licence lines before the phrase (the window
    # is eight lines: those, the phrase, the trust and its registration line).
    letterhead = ("Gecko Funds Management Limited\nACN 123 456 789\nABN 12 345 678 901\nAFSL 123456\n"
                  "AFS Licence No. 654321\nARBN 111 222 333\nARSN 444 555 666\nResponsible entity of\n"
                  "Gecko Property Trust\nARSN 093 261 744\n")
    assert _entity(letterhead) == "Gecko Property Trust"
    assert _entity(letterhead.replace("ARSN 444 555 666\n", "ARSN 444 555 666\nAFSL 777777\n")) == \
        "Gecko Funds Management Limited"
    # The trust after the bare phrase needs its own registration line.
    assert _entity("Charter Hall\nRetail Management Limited\nACN 069 709 468\nAFSL 246996\nResponsible entity of\n"
                   "Charter Hall Retail REIT\nLevel 20, No.1 Martin Place\n") == "Retail Management Limited"
    # Only right after the responsible entity's own registration and licence
    # lines: MRE's disclosure (idsId=03144652) names its fund on a subject line
    # of its own after the letterhead's address and the ASX addressee block, so
    # the responsible entity stays the entity and the letter is withheld.
    assert _entity("The Trust Company (RE Services) Limited \nACN 003 278 831 \nAFSL 235150 \n"
                   "Level 14, 123 Pitt Street \nSydney, NSW, 2000 \n") == "The Trust Company (RE Services) Limited"
    # A label naming the role-holder stays a role label, however it ends
    # (NSR's directory).
    assert _entity("Responsible Entity of NSPT \nNational Storage Financial Services Limited (“the Responsible "
                   "Entity”), a wholly owned subsidiary of \nNational Storage Holdings Limited \n"
                   "ACN 600 787 246  \nAFSL 475 228  \n") == ""


def test_a_name_line_that_starts_with_its_role_is_skipped():
    # A directory that sets the role and the name on one line, the role
    # qualified ("Joint", "Company", "Legal", "Tax") or plural.
    for text in (
        "Investment Manager: Cadence Asset Management Pty Limited\nABN: 68 106 551 062\n",
        "Trustee: Perpetual Trust Services Limited\nABN 48 000 142 049\n",
        "Trustees: Perpetual Trust Services Limited\nABN 48 000 142 049\n",
        "Share Registry: Computershare Investor Services Pty Limited\nABN 48 078 279 277\n",
        "Custodian - Perpetual Corporate Trust Limited\nACN 000 341 533\n",
        "Joint Lead Manager - Morgans Corporate Limited\nABN 32 010 539 607\n",
    ):
        assert _entity(text) == "", text
    # Anchored at the line's start, never a search inside the name: the
    # covers of Corporate Travel Management, Cleanaway Waste Management and
    # Income Asset Management Group.
    assert _entity("AUSTRALIA  •  NEW ZEALAND  •  NORTH AMERICA  •  ASIA  •  EUROPE \n"
                   "   Corporate Travel Management Limited \n   ACN: 131 207 611 \n") == \
        "Corporate Travel Management Limited"
    assert _entity("Appendix 4E\nCleanaway Waste Management Limited \nABN 74 101 155 220\n") == \
        "Cleanaway Waste Management Limited"
    assert _entity("30 June 2026 \nIncome Asset Management Group Limited (IAM)  \nACN 010 653 862 \n") == \
        "Income Asset Management Group Limited"
    # A role label is never stripped the way "Name:" is: the name after it is
    # another organisation's, which the entity check withholds.
    assert dm.clean_entity("Trustee: Perpetual Trust Services Limited") == "Trustee: Perpetual Trust Services Limited"


def test_a_name_of_entity_fields_value_is_not_read_again_by_the_registration_line_rule():
    # That field was rule 1's to read or skip: VIT's defect, with the skipped
    # control field's value carrying its own ACN.
    text = ("Vitura Health Limited ACN 629 071 594\nAppendix 4E\nThe Company lost control over the following entity:\n"
            "Name of entity\nCortexa Pty Ltd\nACN 123 456 789\nDate control lost")
    assert _entity(text) == ""


def test_a_numbered_line_names_a_company_or_is_not_the_field():
    # A contents entry names no one...
    assert _entity("1. Name of entity and reporting period 2\n2. Results for announcement to the market 3\n") == ""
    # ...and the search goes on to the field itself (WhiteHawk's half-year
    # report numbers it as the form's item 1).
    assert _entity("1. Name of entity and reporting period 2\n2. Results for announcement to the market 3\n"
                   "1. Name of Entity\n\n\nWhiteHawk Limited\nABN 97 620 459 823\n") == "WhiteHawk Limited"
    assert _entity("1. Name of entity: Gecko Resources Limited\n") == "Gecko Resources Limited"


def test_a_control_heading_up_to_three_lines_above_the_label():
    # The section's heading need not be the line just above the field.
    text = ("The Company gained control over the following entity:\nAcquired 1 March 2026\nConsideration $5m\n"
            "Name of entity\nGoldstrike Mining Pty Ltd\nPrincipal activity\n")
    assert _entity(text) == ""


def test_the_first_field_not_skipped_decides_even_when_it_states_no_name():
    # DorsaVi's own field states no company name; a joint venture's field
    # after it is never read.
    text = ("Appendix 4E\nName of entity\nDorsaVi Limited and controlled entities\nABN\n"
            "Details of joint ventures and associates\nOwnership interest\n2026\n2025\n"
            "Name of entity\nGoldstrike Mining Pty Ltd\n")
    assert _entity(text) == ""


def test_a_name_with_entity_in_it_is_not_read_above_a_registration_line():
    # It is a label or a role, not a name: CDP's letterhead sets "as
    # responsible entity of Carindale Property Trust" over the trust's ARSN.
    assert _entity("2026 Annual Report\nas responsible entity of Carindale Property Trust \nARSN 093 261 744\n") == ""


def test_a_name_and_its_number_on_one_line_are_not_a_list_marker():
    # Only a line that starts with a registration number marks a list (MGX's
    # subsidiaries, in the fixture). An entry with its number on the same line
    # is read past, and the name under it is read: the entity check decides.
    assert _entity("Geraldton Bulk Handling Pty Ltd ACN 100 105 388\nBrockman Minerals Pty Ltd\nACN 094 634 401\n") == \
        "Brockman Minerals Pty Ltd"


@pytest.mark.parametrize(
    "go_name,py_set",
    [("entityStopTokens", dm.ENTITY_STOP_TOKENS), ("entityGenericTokens", dm.ENTITY_GENERIC_TOKENS)],
)
def test_entity_token_lists_match_the_go_source(go_name, py_set):
    # The registration line rule reads a name only with a token outside both
    # lists EntityMatches reads it with: a word added on one side fails here.
    body = re.search(r"var " + go_name + r" = map\[string\]bool\{(.*?)\n\}", _go_source("entity.go"), re.S)
    assert body, go_name
    entries = re.findall(r'"([^"]*)":\s*(\w+)', body.group(1))
    assert entries and all(value == "true" for _, value in entries)
    assert {token for token, _ in entries} == set(py_set)


def test_not_a_name_patterns_match_the_go_source():
    # clean_entity's "not a name" rules are cleanEntity's, pattern for pattern:
    # the fixture's entities pin the values it carries, this pins every pattern.
    body = re.search(r"notANameREs = \[\]\*regexp\.Regexp\{(.*?)\n\t\}", _go_source("documentmeta.go"), re.S)
    assert body
    assert re.findall(r"regexp\.MustCompile\(`([^`]*)`\)", body.group(1)) == [rx.pattern for rx in dm._NOT_A_NAME_RES]


def test_abn_spellings():
    assert dm.extract_document_meta("BHP Group Limited ABN 49004028077")["abn"] == "49 004 028 077"
    assert dm.extract_document_meta("BHP Group Limited (ABN: 49 004 028 077)")["abn"] == "49 004 028 077"
    assert dm.valid_abn("49 004 028 077") and dm.valid_abn("48 123 123 124")
    assert not dm.valid_abn("12 345 678 901") and not dm.valid_abn("49004028077")


def test_long_entity_is_dropped():
    assert "entity" not in dm.extract_document_meta("Name of entity: " + "X" * 250)
