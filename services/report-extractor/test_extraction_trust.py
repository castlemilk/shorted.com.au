"""Parity tests: extraction_trust.py against services/pkg/extractiontrust (Go).

The shared fixture testdata/results_titles.json is asserted here AND by the Go
package's results_titles_test.go, so the Python targeting and the Go trust
funnel agree on every headline. The inline lists below are copied from the Go
tests of the same names, so a Go-side case the port disagrees with fails here.
"""
import json

import pytest

import extraction_trust as t
from extractor_test_support import fixture_path


def _titles():
    path = fixture_path("results_titles.json")
    if not path.exists():
        pytest.skip("services/pkg/extractiontrust is not in this checkout")
    return json.loads(path.read_text(encoding="utf-8"))


def test_is_results_document_shared_fixture():
    cases = _titles()
    assert len(cases) >= 30
    wrong = [c for c in cases if t.is_results_document(c["title"], c["report_kind"]) != c["want"]]
    assert wrong == []


def test_fixture_carries_the_titles_the_contract_names():
    got = {c["title"]: c["want"] for c in _titles() if c["report_kind"] == ""}
    for title, want in {
        "BHP Appendix 4E and 2026 Annual Report": True,
        "Half Year Basel III Pillar 3 Disclosure": False,
        "2026 US Annual Report (Form 20-F)": False,
        "FY26 Results Presentation": False,
        "Appendix 4D and Half Year Report": True,
        "Items impacting the FY26 result": False,
        "Webcast": False,
        "Preliminary Final Report": True,
        "Annual Report 2025": True,
    }.items():
        assert got.get(title) is want, title


# Copied from TestIsResultsDocumentReportKind.
@pytest.mark.parametrize(
    "title,kind,want",
    [
        ("Annual Report 2025", "other", False),
        ("Appendix 4E and Annual Report", " Other ", False),
        ("", "appendix_4e", True),
        ("   ", "appendix_4d", True),
        ("", "annual_report", True),
        ("", "half_year_report", True),
        ("", "results_announcement", True),
        ("", "", False),
        ("", "other", False),
        ("", "half_year_results", False),
        ("Company Update", "appendix_4e", False),
        ("Appendix 4E and Annual Report", "", True),
        ("Appendix 4E and Annual Report", "results_announcement", True),
        ("FY26 Results Presentation", "appendix_4e", False),
    ],
)
def test_report_kind(title, kind, want):
    assert t.is_results_document(title, kind) is want


# Copied from TestIsResultsDocumentAgreesOnExistingRejections.
@pytest.mark.parametrize(
    "title",
    [
        "FY26 Results Date and Market Briefing",
        "AMX to present FY26 Results at Coffee Microcaps Webinar",
        "Advanced Braking Technology FY26 Results Webinar",
        "Dividend/Distribution - AMA",
        "Update - Dividend/Distribution - ALK",
        "Confirmation of Final Dividend Payment Date",
        "Trading Halt",
        "Change of Director's Interest Notice",
        "Quarterly Activities Report",
        "Notice of Annual General Meeting",
        "FY26 Dividend Declared and On-Market Share Buy-Back",
        "Neuren H1 2026 Financial Results Webinar on 26 August 2026",
        "Results of Meeting",
        "Results of 2025 Annual General Meeting",
        "Results of General Meeting - Share Issue Approvals",
        "Notice of FY26 Results Market Briefing",
        "PolyNovo FY26 Results Presentation - Registration Details",
        "Quarterly Activities/Appendix 4C Cash Flow Report",
        "Quarterly Activity Report and Appendix 4C",
        "1Q26 4C Results - Investor Presentation",
        "FY25 Results Presentation",
        "Investor Presentation",
        "Half Year Results Presentation",
    ],
)
def test_existing_rejections(title):
    assert t.is_results_document(title) is False


# Copied from TestIsResultsDocumentAgreesOnStatutoryHeadlines.
@pytest.mark.parametrize(
    "title",
    [
        "Appendix 4E & Financial Report for year ended 30 June 2026",
        "FY26 Appendix 4E and Annual Report",
        "Appendix 4E & Annual Report for Year Ending 30 June 2026",
        "Annual Report to shareholders",
        "FY26 Financial Results and Dividend",
        "FY26 Results Release",
        "Media Release - Result for year ended 30 June 2026",
        "FY26 Financial Results Release and Webinar",
        "2026 GYG Full Year Report and Appendix 4E",
        "Telix HY26 Results Announcement",
        "Media Release - Full Year Results to 30 June 2026",
        "Half Yearly Report and Accounts",
        "1H25 Results Surging Revenue and Profitability",
        "2H26 Results",
        "Appendix 4E - Preliminary Final Report",
        "Appendix 4D and FY26 Half Year Report",
        "FY2025 Full year results",
        "Appendix4E and Annual Report",
        "Half Year Financial Report",
        "Annual Financial Report 2026",
        "Financial Report for the half year ended 31 December 2025",
        "Results Summary - Full Year Ended 30 June 2026",
        "Half Year Results and Interim Dividend",
    ],
)
def test_statutory_headlines(title):
    assert t.is_results_document(title) is True


# Copied from TestIsResultsDocumentNormalisesPunctuation.
@pytest.mark.parametrize(
    "title,want",
    [
        ("Chairman\u2019s Address to Shareholders", False),
        ("CEO\u2019s AGM Speech", False),
        ("Appendix 4D \u2013 Half\u2011Year Report", True),
        ("Appendix 4E \u2014 Preliminary Final Report", True),
        ("Update \u2013 Dividend/Distribution \u2013 CBA", False),
        ("Annual\u00A0Report\u00A02025", True),
    ],
)
def test_normalised_punctuation(title, want):
    assert t.is_results_document(title) is want


# Copied from TestNormalise.
@pytest.mark.parametrize(
    "raw,want",
    [
        ("", ""),
        ("   ", ""),
        ("  Hello\tWorld \n", "hello world"),
        ("Chairman\u2019s \u201CAddress\u201D", 'chairman\'s "address"'),
        ("4\u20136%", "4-6%"),
        ("a\u2014b\u2212c\u2011d", "a-b-c-d"),
        ("non\u00A0breaking\u202Fthin\u2009space", "non breaking thin space"),
        ("zero\u200Bwidth\u00ADsoft", "zerowidthsoft"),
        ("wait\u2026", "wait..."),
        ("STATUTORY NPAT2 $5,142M", "statutory npat2 $5,142m"),
    ],
)
def test_normalise(raw, want):
    assert t.normalise(raw) == want


def _denylist():
    path = fixture_path("fewshot_example.json")
    if not path.exists():
        pytest.skip("services/pkg/extractiontrust is not in this checkout")
    ex = json.loads(path.read_text(encoding="utf-8"))
    return t.FewShotDenylist(
        [
            (t.RETIRED_FEWSHOT_TEXT, t.RETIRED_FEWSHOT_EXTRACTION_TEXTS),
            (ex["text"], [e["extraction_text"] for e in ex["extractions"]]),
        ]
    )


# Copied from TestIsFewShotText.
@pytest.mark.parametrize(
    "text,want",
    [
        ("Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million", True),
        ("Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp", True),
        ("Basic earnings per share was 94.2 cents", True),
        ("interim dividend of 45 cents per share, fully franked", True),
        ("Operating cash flow was $2,156 million", True),
        ("EBITDA was $2,891 million, representing a margin of 56.2%", True),
        ("FY2025 guidance: Revenue growth of 6-8% expected", True),
        ("BASIC EARNINGS PER SHARE WAS 94.2 CENTS", True),
        ("Revenue from continuing operations for the half year ended 31 December 2024\nwas $5,142 million", True),
        ("Basic earnings per share was 94.2 cents.", True),
        ("  Operating cash flow was $2,156 million  ", True),
        ("FY2025 guidance: Revenue growth of 6\u20138% expected", True),
        ("Operating\u00A0cash flow was $2,156\u00A0million", True),
        ("The Board declared an interim dividend of 45 cents per share, fully franked.", True),
        ("Revenue from continuing operations for the half year ended 31 December 2030 was $3,847 million", True),
        ("basic earnings per share was 48.3 cents for h1 fy2031", True),
        ("Quokka Minerals Limited (ASX: QKA) Appendix 4D and half year report for H1 FY2031.", True),
        ("Statutory NPAT2 $5,142m", False),
        ("Revenue was $5,142 million", False),
        ("Basic earnings per share was 94.2 cents, up 3% on the prior corresponding period", False),
        ("Operating cash flow was", False),
        ("Basic earnings per share was 21.9 cents", False),
        ("", False),
        (" . ", False),
    ],
)
def test_fewshot_denylist(text, want):
    assert (text in _denylist()) is want


def test_denylist_texts_carry_every_echo():
    texts = _denylist().texts
    for want in [
        "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million, an increase of 8% on the prior corresponding period.",
        "The Board declared an interim dividend of 45 cents per share, fully franked.",
    ]:
        assert want in texts
    keys = [t.fewshot_key(x) for x in texts]
    assert len(keys) == len(set(keys))


def test_grounded_entry_matches_go():
    deny = _denylist()
    ok = {"source_text": "Revenue was $5,142 million", "alignment": "match_fuzzy"}
    assert t.grounded_entry(ok, deny)
    assert t.grounded_entry({"source_text": "Revenue was $5,142 million"}, deny)  # legacy row
    for bad in ("unaligned", "", None, 3, "MATCH_EXACT"):
        assert not t.grounded_entry({"source_text": "x", "alignment": bad}, deny), bad
    assert not t.grounded_entry({"source_text": "Basic earnings per share was 94.2 cents"}, deny)
    assert t.grounded_entry({"alignment": " match_exact "}, deny)


def test_trusted_metrics_drops_and_strips():
    deny = _denylist()
    metrics = {
        "revenue": {"source_text": "Revenue $10m", "value_millions": "10", "alignment": "match_exact",
                    "char_start": "1", "char_end": "9"},
        "eps": [
            {"source_text": "Basic earnings per share was 94.2 cents", "value_cents": "94.2"},
            {"source_text": "EPS 3.1c", "value_cents": "3.1", "alignment": "match_lesser"},
        ],
        "ebitda": {"source_text": "EBITDA $3m", "alignment": "unaligned"},
        "junk": "not an entry",
    }
    before = json.dumps(metrics, sort_keys=True)
    assert t.trusted_metrics(metrics, deny) == {
        "revenue": {"source_text": "Revenue $10m", "value_millions": "10"},
        "eps": [{"source_text": "EPS 3.1c", "value_cents": "3.1"}],
    }
    assert json.dumps(metrics, sort_keys=True) == before  # input untouched
    assert t.trusted_metrics(None, deny) == {}
