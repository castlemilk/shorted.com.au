"""document_meta (contract 2.5 / 6.1) against the shared fixture.

services/pkg/extractiontrust/testdata/document_meta_cases.json is the one
source of truth: every case's expected object is derived from its text here,
and the Go test asserts every expected object is inside the closed vocabulary.
Its "invalid" list pins validate_document_meta to extractiontrust.ParseDocumentMeta.
"""
import json

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
    assert dm.extract_document_meta(case["text"]) == case["expected"]


@pytest.mark.parametrize("name", _case_ids("invalid"))
def test_fixture_invalid_input_loses_exactly_its_bad_keys(name):
    case = next(c for c in _fixture()["invalid"] if c["name"] == name)
    assert dm.validate_document_meta(case["input"]) == case["expected"]


def test_fixture_is_not_empty():
    f = _fixture()
    assert len(f["cases"]) >= 10 and len(f["invalid"]) >= 10


def test_every_extracted_value_is_in_vocabulary():
    for case in _fixture()["cases"]:
        meta = dm.extract_document_meta(case["text"])
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
    # An impossible first date is withheld, never replaced by the next match.
    assert "period_end" not in dm.extract_document_meta(
        "for the year ended 31 June 2026. Prior: year ended 30 June 2025"
    )


def test_report_kind_order():
    assert dm.extract_document_meta("Appendix 4D\nAppendix 4E")["report_kind"] == "appendix_4e"
    assert dm.extract_document_meta("Interim Financial Report")["report_kind"] == "half_year_report"
    assert dm.extract_document_meta("FY26 Results Presentation")["report_kind"] == "other"
    assert dm.extract_document_meta("Results announcement. A webcast follows.")["report_kind"] == "results_announcement"


def test_entity_rules():
    assert dm.extract_document_meta("Name of entity: Gecko Ltd ABN 11 000 000 000")["entity"] == "Gecko Ltd"
    # A bare label with the value on the next line (a form's table cell).
    assert dm.extract_document_meta("Name of entity\nGecko Resources Limited\n")["entity"] == "Gecko Resources Limited"
    assert "entity" not in dm.extract_document_meta("Name of entity\nABN or equivalent company reference\n")
    # A possessive before ABN is prose, not a name.
    assert "entity" not in dm.extract_document_meta("The Company's ABN 49 004 028 077 is listed.")


def test_abn_spellings():
    assert dm.extract_document_meta("BHP Group Limited ABN 49004028077")["abn"] == "49 004 028 077"
    assert dm.extract_document_meta("BHP Group Limited (ABN: 49 004 028 077)")["abn"] == "49 004 028 077"
    assert dm.valid_abn("49 004 028 077") and dm.valid_abn("48 123 123 124")
    assert not dm.valid_abn("12 345 678 901") and not dm.valid_abn("49004028077")


def test_long_entity_is_dropped():
    assert "entity" not in dm.extract_document_meta("Name of entity: " + "X" * 250)
