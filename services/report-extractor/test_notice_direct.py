"""notice_direct: validation, consensus, the write rules and the gold set (no model call).

The gold set (testdata/notices/gold.json) is read by hand, so these tests hold the validator
to it: every hand reading must validate against its own quotes, and a withheld-expected entry
must have no reading. The consensus is driven by a fake client, so no test reaches OpenRouter.
"""
import json
import os
import re
from pathlib import Path

import pytest

import direct_extract as dx
import notice_direct as nd

HERE = Path(__file__).parent
GOLD = HERE / "testdata" / "notices" / "gold.json"

TEXT = (
    "Form 604 Corporations Act 2001 Section 671B Notice of change of interests of substantial holder. "
    "To Company Name/Scheme: Zip Co Limited. "
    "1. Details of substantial holder: Name: Vanguard Group Pty Ltd. ACN: 000 000 019. "
    "2. Details of voting power: The previous notice was given to the company on 3 March 2026. "
    "The previous notice stated voting power of 5.12%. The present voting power is 6.40%. "
    "Previous notice: 35,000,000 ordinary shares, 5.12%. Present notice: 42,500,000 ordinary shares, 6.40%. "
    "Date of change: 14 October 2026."
)
HEADLINE_604 = "Change in substantial holding from VGI"
ANNOUNCED = "2026-10-16"
# ASIC's count on issue that fits TEXT's figures: 42.5m votes at 6.40% is 664m shares.
SHARES = 660_000_000


def answer_604(**over):
    a = {
        "is_substantial_holder_notice": True,
        "holder_name": "Vanguard Group Pty Ltd",
        "form": "604",
        "previous_pct": 5.12,
        "previous_votes": 35000000,
        "present_pct": 6.40,
        "present_votes": 42500000,
        "event_date": "2026-10-14",
        "ceased": False,
        "subject_company": "Zip Co Limited",
        "quotes": {
            "holder_name": "Name: Vanguard Group Pty Ltd",
            "subject_company": "To Company Name/Scheme: Zip Co Limited",
            "previous_pct": "stated voting power of 5.12%",
            "previous_votes": "35,000,000 ordinary shares",
            "present_pct": "present voting power is 6.40%",
            "present_votes": "42,500,000 ordinary shares",
            "event_date": "Date of change: 14 October 2026",
        },
    }
    a.update(over)
    return a


def validate(answer, text=TEXT, headline=HEADLINE_604, shares=SHARES, scan=False):
    return nd.validate_notice(answer, text, headline=headline, announced_on=ANNOUNCED,
                              shares_on_issue=shares, scan=scan, model="m")


# --- placeholders, names and keys -----------------------------------------------------------

@pytest.mark.parametrize("name", ["SEE ANNEXURE 1", "Refer to Annexure A", "As per annexure", "N/A",
                                   "Refer attached", "This notice is given by", "Name", "A B C"])
def test_placeholders_are_withheld(name):
    assert nd.placeholder_reason(name) != ""


@pytest.mark.parametrize("name", ["Vanguard Group Pty Ltd", "Perpetual", "Macquarie Group Limited",
                                  "Carma Holdings", "Australian Retirement Trust"])
def test_holders_are_not_placeholders(name):
    assert nd.placeholder_reason(name) == ""


def test_a_name_that_points_at_an_annexure_but_names_a_holder_is_read_as_a_holder():
    # The parser's rule: a pointer that does not open the name leaves a holder a holder.
    assert nd.placeholder_reason("Vanguard Group, listed in Annexure A") == ""


def test_holder_key_drops_legal_suffixes_and_case():
    assert nd.holder_key("Vanguard Group Pty Ltd") == "name:vanguard group"
    assert nd.holder_key("VANGUARD GROUP PTY LTD") == "name:vanguard group"
    assert nd.holder_key("Smith & Co") == "name:smith and"  # the trailing 'co' is a legal suffix
    assert nd.holder_key("Ltd") == ""


def test_institution_index_drops_a_name_two_institutions_share():
    idx = nd.institution_index([("vanguard", "Vanguard Group", ["Vanguard"]), ("x", "Vanguard", [])])
    assert "vanguard" not in idx
    assert nd.institution_index([("vanguard", "Vanguard Group", ["Vanguard Australia"])])["vanguard group"] == "vanguard"


# --- headline, votes, dates -----------------------------------------------------------------

@pytest.mark.parametrize("headline,form", [
    ("Becoming a substantial holder from MQG", "603"),
    ("Initial substantial holder notice", "603"),
    ("Change in substantial holding from VGI", "604"),
    ("Change of interests of substantial holder", "604"),
    ("Ceasing to be a substantial holder from MUFG", "605"),
    ("Notification of buy-back", ""),
])
def test_the_headline_names_the_form(headline, form):
    assert nd.form_from_headline(headline) == form


def test_votes_fit_the_share_count_within_the_parsers_tolerance():
    assert nd.votes_consistent(42_500_000, 6.40, 664_000_000)          # ratio ~1.0
    assert nd.votes_consistent(42_500_000, 6.40, 340_000_000)          # ratio 2.0 exactly
    assert not nd.votes_consistent(42_500_000, 6.40, 100_000_000)      # ratio 4.2
    assert not nd.votes_consistent(42_500_000, 6.40, 1_500_000_000)    # ratio 0.4
    assert nd.votes_consistent(None, 6.40, 1e9)
    assert nd.votes_consistent(42_500_000, 6.40, 0)                    # no count on record: not checked


def test_an_event_date_is_kept_only_within_the_year_before_the_release():
    assert nd.plausible_event_date("2026-10-14", "2026-10-16") == "2026-10-14"
    assert nd.plausible_event_date("2026-10-17", "2026-10-16") == "2026-10-17"  # the day after
    assert nd.plausible_event_date("2026-10-20", "2026-10-16") == ""
    assert nd.plausible_event_date("2024-10-01", "2026-10-16") == ""
    assert nd.plausible_event_date("not a date", "2026-10-16") == ""


# --- validate_notice ---------------------------------------------------------------------------

def test_a_604_read_from_the_text_with_quotes_validates():
    n, why = validate(answer_604(), shares=664_000_000)
    assert why == "" and n is not None
    assert (n.form, n.holder_name, n.previous_pct, n.present_pct) == ("604", "Vanguard Group Pty Ltd", 5.12, 6.40)
    assert (n.previous_votes, n.present_votes, n.event_date, n.ceased) == (35_000_000, 42_500_000, "2026-10-14", False)
    assert n.holder_key == "name:vanguard group"


def test_the_form_must_agree_with_the_headline():
    assert validate(answer_604(form="605", ceased=True, previous_pct=5.12, present_pct=None,
                               quotes={"holder_name": "Name: Vanguard Group Pty Ltd",
                                       "previous_pct": "stated voting power of 5.12%"}),
                    headline=HEADLINE_604)[1] == "form_contradicts_headline"


def test_no_headline_withholds_rather_than_guesses():
    assert validate(answer_604(), headline="Notification of buy-back")[1] == "no_headline"


def test_a_604_must_state_both_percentages():
    a = answer_604(present_pct=None)
    assert validate(a)[1] == "missing_present_pct"
    assert validate(answer_604(previous_pct=None))[1] == "missing_previous_pct"


def test_a_603_states_the_present_figure_and_no_previous_one():
    a = {"is_substantial_holder_notice": True, "holder_name": "Vanguard Group Pty Ltd", "form": "603",
         "present_pct": 5.5, "present_votes": 55000000, "previous_pct": 2.0, "event_date": None, "ceased": False,
         "quotes": {"holder_name": "Name: Vanguard Group Pty Ltd", "present_pct": "present voting power is 6.40%"}}
    text = TEXT.replace("present voting power is 6.40%", "present voting power is 5.50%") \
               .replace("42,500,000 ordinary shares, 6.40%", "55,000,000 ordinary shares, 5.50%")
    a["quotes"]["present_pct"] = "present voting power is 5.50%"
    a["quotes"]["present_votes"] = "55,000,000 ordinary shares"
    n, why = validate(a, text=text, headline="Becoming a substantial holder from VGI")
    assert why == "" and n.form == "603" and n.previous_pct is None and n.present_pct == 5.5


def test_a_603_under_five_percent_is_implausible():
    a = {"holder_name": "Vanguard Group Pty Ltd", "form": "603", "present_pct": 4.2, "present_votes": 28_000_000,
         "quotes": {}}
    assert validate(a, headline="Becoming a substantial holder")[1] == "implausible_under_5"


def test_a_605_ceases_and_states_the_previous_figure_only():
    text = TEXT.replace("Change in", "Ceasing") + " The holder ceased to hold 5.12% of the shares."
    a = {"is_substantial_holder_notice": True, "holder_name": "Vanguard Group Pty Ltd", "form": "605",
         "previous_pct": 5.12, "previous_votes": None, "present_pct": None, "present_votes": None,
         "event_date": None, "ceased": True,
         "quotes": {"holder_name": "Name: Vanguard Group Pty Ltd", "previous_pct": "stated voting power of 5.12%"}}
    n, why = validate(a, text=text, headline="Ceasing to be a substantial holder from VGI")
    assert why == "" and n.ceased is True and n.present_pct is None and n.form == "605"


def test_ceased_is_only_for_a_605():
    a = answer_604(ceased=True)
    assert validate(a)[1] == "ceased_outside_605"


def test_a_604_under_five_in_the_present_figure_is_withheld_not_ceased():
    a = answer_604(present_pct=4.2, quotes={**answer_604()["quotes"], "present_pct": "present voting power is 6.40%"})
    assert validate(a)[1] == "under_5_in_604"


def test_a_change_over_fifty_points_is_withheld():
    a = answer_604(previous_pct=5.12, present_pct=60.0,
                   quotes={**answer_604()["quotes"], "present_pct": "present voting power is 6.40%"})
    assert validate(a)[1] == "change_over_50"


def test_a_quote_must_be_in_the_text():
    q = {**answer_604()["quotes"], "previous_pct": "stated voting power of"}
    assert validate(answer_604(quotes=q))[1] == "value_not_in_quote_previous_pct"
    q = {**answer_604()["quotes"], "previous_pct": "a sentence the notice never wrote, with 5.12"}
    assert validate(answer_604(quotes=q))[1] == "quote_not_in_notice_previous_pct"


def test_a_figure_without_a_quote_is_withheld():
    q = {k: v for k, v in answer_604()["quotes"].items() if k != "present_votes"}
    assert validate(answer_604(quotes=q))[1] == "no_quote_present_votes"


def test_the_holder_must_be_named_in_the_notice():
    assert validate(answer_604(holder_name="Macquarie Group Limited",
                               quotes={**answer_604()["quotes"], "holder_name": "Vanguard Group Pty Ltd"}))[1] \
        == "name_not_in_notice"


def test_a_placeholder_holder_is_no_holder():
    assert validate(answer_604(holder_name="SEE ANNEXURE 1"))[1] == "no_holder"


def test_votes_that_do_not_fit_the_share_count_are_inconsistent():
    assert validate(answer_604(), shares=100_000_000)[1] == "inconsistent_votes"


def test_a_scan_skips_the_text_checks_and_keeps_the_rest():
    a = answer_604(quotes={})
    n, why = validate(a, text="", scan=True)
    assert why == "" and n.present_pct == 6.40
    assert validate(answer_604(holder_name="SEE ANNEXURE A"), text="", scan=True)[1] == "no_holder"


def test_a_non_notice_and_a_malformed_answer_are_withheld_as_such():
    assert validate({"is_substantial_holder_notice": False})[1] == "not_a_notice"
    assert validate({})[1] == "malformed"
    # A reply with no JSON object is a model failure in the consensus, never a reading.
    with pytest.raises(dx.ModelCallError):
        extractor({"P": "not json at all", "C": answer_604()}).extract(ctx())
    assert validate(answer_604(form="606"))[1] == "no_form"


def test_implausible_percentages_are_withheld():
    assert validate(answer_604(present_pct=120.0))[1] == "implausible_present_pct"


# --- consensus ------------------------------------------------------------------------------------

class FakeClient:
    """Answers each model with the scripted reply, or raises a model failure."""

    def __init__(self, replies):
        self.replies = replies
        self.calls = []

    def chat(self, model, system, user, usage=None, temperature=0.0, images=None):
        self.calls.append((model, bool(images)))
        r = self.replies[model]
        if isinstance(r, Exception):
            raise r
        import json as _j
        return _j.dumps(r)


def extractor(replies, **over):
    kw = dict(primary="P", checker="C", arbiter="A")
    kw.update(over)
    return nd.NoticeExtractor(client=FakeClient(replies), **kw)


def ctx(scan=False, text=TEXT):
    return nd.ReadContext(text=text, images=[b"png"] if scan else None, headline=HEADLINE_604,
                          announced_on=ANNOUNCED, shares_on_issue=SHARES, scan=scan)


def test_a_scan_with_no_share_count_on_record_is_withheld_not_validated():
    assert validate(answer_604(quotes={}), text="", scan=True, shares=0)[1] == "no_share_count"


def test_a_reading_without_its_votes_is_withheld_as_missing_votes():
    assert validate(answer_604(previous_votes=None))[1] == "missing_previous_votes"
    assert validate(answer_604(present_votes=None))[1] == "missing_present_votes"


def test_two_readers_that_agree_recover_the_notice():
    ex = extractor({"P": answer_604(), "C": answer_604()})
    n, outcome = ex.extract(ctx())
    assert outcome == "agree" and n.present_pct == 6.40


def test_a_disagreement_is_settled_by_the_arbiter_when_it_sides_with_one_reader():
    wrong = answer_604(present_votes=42_000_000)
    wrong["quotes"] = {**answer_604()["quotes"], "present_votes": "42,500,000 ordinary shares"}
    ex = extractor({"P": answer_604(), "C": wrong, "A": answer_604()})
    n, outcome = ex.extract(ctx())
    assert outcome == "majority" and n.present_votes == 42_500_000


def test_no_majority_is_withheld_as_disputed():
    # three readings, three different vote counts: nothing has two of three
    ex = extractor({"P": answer_604(), "C": answer_604(present_votes=1), "A": answer_604(present_votes=2)})
    assert ex.extract(ctx()) == (None, "disputed")


def test_the_arbiter_siding_with_the_checker_is_a_majority_too():
    wrong = answer_604(present_votes=42_000_000)
    wrong["quotes"] = {**answer_604()["quotes"], "present_votes": "42,500,000 ordinary shares"}
    ex = extractor({"P": wrong, "C": answer_604(), "A": answer_604()})
    n, outcome = ex.extract(ctx())
    assert outcome == "majority" and n.present_votes == 42_500_000


def test_both_readers_invalid_is_withheld_with_the_reason():
    bad = answer_604(form="603")  # contradicts the 604 headline
    ex = extractor({"P": bad, "C": bad, "A": bad})
    assert ex.extract(ctx()) == (None, "invalid_form_contradicts_headline")


def test_a_model_failure_propagates_and_is_never_an_outcome():
    ex = extractor({"P": answer_604(), "C": dx.ModelCallError("C: HTTP 503")})
    with pytest.raises(dx.ModelCallError):
        ex.extract(ctx())


def test_a_scan_is_sent_as_images_to_both_vision_readers_and_never_to_the_text_primary():
    client = FakeClient({"SP": answer_604(), "SC": answer_604(), "P": answer_604(), "C": answer_604()})
    nd.NoticeExtractor(client=client, primary="P", checker="C", arbiter="A",
                       scan_primary="SP", scan_checker="SC").extract(ctx(scan=True))
    assert client.calls == [("SP", True), ("SC", True)]


def test_the_scan_readers_are_vision_models_on_openrouter():
    # OpenRouter's input_modalities (checked 2026-11-05): deepseek/deepseek-v4-flash is text only;
    # gemini-2.5-flash-lite and gemini-2.5-flash take images. A scan that reaches the text primary
    # becomes a model error on every notice, so the pinned pair must differ from it.
    assert dx.PRIMARY_MODEL not in (nd.SCAN_PRIMARY_MODEL, nd.SCAN_CHECKER_MODEL)
    assert nd.SCAN_PRIMARY_MODEL == "google/gemini-2.5-flash-lite"
    assert nd.SCAN_CHECKER_MODEL == "google/gemini-2.5-flash"


def test_a_scan_disagreement_is_withheld_without_an_arbiter():
    # no arbiter for a scan: the arbiter would be one of the two vision readers again
    client = FakeClient({"SP": answer_604(), "SC": answer_604(present_votes=1), "A": answer_604()})
    ex = nd.NoticeExtractor(client=client, primary="P", checker="C", arbiter="A",
                            scan_primary="SP", scan_checker="SC")
    assert ex.extract(ctx(scan=True)) == (None, "disputed")
    assert all(m != "A" for m, _ in client.calls)


def test_the_extractor_needs_a_checker():
    with pytest.raises(ValueError):
        extractor({}, checker=None).extract(ctx())


# --- systemic failure ---------------------------------------------------------------------------

@pytest.mark.parametrize("errors,calls,want", [(4, 100, False), (5, 100, True), (3, 15, True),
                                               (3, 16, False), (0, 0, False)])
def test_model_errors_that_look_systemic(errors, calls, want):
    assert nd.systemic(errors, calls) is want


# --- the write rules ---------------------------------------------------------------------------

class FakeCursor:
    def __init__(self, rowcount=1, fetch=None):
        self.rowcount = rowcount
        self.sql = []
        self._fetch = fetch

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.sql.append((" ".join(sql.split()), params))

    def fetchone(self):
        return self._fetch

    def fetchall(self):
        return self._fetch or []


def test_a_recovered_notice_is_written_only_over_a_missing_row_or_a_model_row():
    n = nd.validate_notice(answer_604(), TEXT, headline=HEADLINE_604, announced_on=ANNOUNCED,
                           shares_on_issue=SHARES, scan=False, model="P")[0]
    cur = FakeCursor(rowcount=1)
    assert nd.write_recovered(cur, "https://x/1.pdf", "ZIP", ANNOUNCED, n) is True
    upsert, attempt = cur.sql
    assert "'model')" in upsert[0] and "WHERE substantial_holder_notices.read_by = 'model'" in upsert[0]
    assert upsert[1][13] == nd.NOTICE_PARSER_VERSION
    assert "outcome = 'parsed', read_by = 'model'" in attempt[0]


def test_a_parser_row_is_kept_and_its_attempt_is_not_changed_when_no_row_is_written():
    n = nd.validate_notice(answer_604(), TEXT, headline=HEADLINE_604, announced_on=ANNOUNCED,
                           shares_on_issue=SHARES, scan=False, model="P")[0]
    cur = FakeCursor(rowcount=0)  # the upsert's WHERE found a parser-read row
    assert nd.write_recovered(cur, "https://x/1.pdf", "ZIP", ANNOUNCED, n) is False
    assert len(cur.sql) == 1, "no attempt update when no notice was written"


def test_a_withheld_second_read_keeps_the_outcome_and_marks_the_model():
    cur = FakeCursor()
    nd.record_withheld(cur, "https://x/1.pdf", "no_voting_power", "disputed")
    sql, params = cur.sql[0]
    assert "read_by = 'model'" in sql and "AND read_by = 'parser'" in sql
    assert "outcome" not in sql.split("SET", 1)[1].split("WHERE", 1)[0]
    assert params[0] == "model: disputed (parser: no_voting_power)"


def test_selection_reads_only_parser_withheld_notices_largest_company_first():
    sql = " ".join(nd.SELECT_SQL.split())
    assert "a.read_by = 'parser'" in sql
    assert "('no_text', 'no_voting_power', 'no_holder')" in sql
    assert "THEN btrim(cm.market_cap::text)::float8 END DESC NULLS LAST" in sql
    assert "ann.announcement_date >= %(since)s::date" in sql


def test_the_upsert_never_touches_a_parser_row():
    sql = " ".join(nd.UPSERT_SQL.split())
    assert sql.endswith("WHERE substantial_holder_notices.read_by = 'model'")
    assert "read_by = 'model'" in sql.split("ON CONFLICT")[1].split("WHERE")[0]


# --- the document: text layer, scans and the gate's own PDFs -------------------------------------

def make_pdf(pages):
    import pymupdf

    doc = pymupdf.open()
    for text in pages:
        page = doc.new_page()
        if text:
            # A text box wraps the line: insert_text would run past the page edge and drop it.
            page.insert_textbox(pymupdf.Rect(40, 40, 555, 800), text, fontsize=9)
    data = doc.tobytes()
    doc.close()
    return data


def test_a_text_layer_document_reads_its_first_four_pages():
    pdf = make_pdf([TEXT, "page two " * 20, "page three " * 20, "page four " * 20, "page five SHOULD NOT APPEAR " * 5])
    text, scan, pages = nd.document_text(pdf)
    assert scan is False and pages == 5
    assert "Vanguard Group" in text and "page four" in text and "SHOULD NOT APPEAR" not in text


def test_a_scan_has_no_text_layer_and_is_rasterised():
    pdf = make_pdf([""])
    text, scan, pages = nd.document_text(pdf)
    assert scan is True and text == "" and pages == 1
    images = nd.document_images(pdf, pages)
    assert len(images) == 1 and images[0].startswith(b"\x89PNG")


def test_a_pdf_that_is_not_a_pdf_is_a_fetch_failure():
    class Resp:
        status_code = 200
        content = b"<html>Sorry, cannot display PDF.</html>"

    class Sess:
        def get(self, *a, **k):
            return Resp()

    with pytest.raises(nd.FetchError):
        nd.fetch_pdf("https://www.asx.com.au/asxpdf/x.pdf", Sess())


def test_fetch_pdf_follows_the_access_terms_page_to_the_document():
    # ASX answers displayAnnouncement.do with its access-terms page: a hidden form field names the PDF.
    terms = (b'<html><body><form name="showAnnouncementPDFForm" method="post">'
             b'<input type="hidden" name="pdfURL" value="https://announcements.asx.com.au/asxpdf/x/y.pdf">'
             b'</form></body></html>')
    calls = []

    class Resp:
        def __init__(self, content):
            self.status_code = 200
            self.content = content

    class Sess:
        def get(self, url, **k):
            calls.append(url)
            return Resp(b"%PDF-1.4 doc" if url.endswith(".pdf") else terms)

    got = nd.fetch_pdf("https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=1", Sess())
    assert got.startswith(b"%PDF") and calls == [
        "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=1",
        "https://announcements.asx.com.au/asxpdf/x/y.pdf",
    ]


def test_fetch_pdf_names_asx_cannot_display_and_a_page_without_a_link():
    class Resp:
        def __init__(self, content):
            self.status_code = 200
            self.content = content

    for body, reason in ((b'<p class="error"><span>Sorry, cannot display PDF.</span></p>', "cannot display"),
                         (b"<html>nothing here</html>", "no pdfURL")):
        class Sess:
            def get(self, url, **k):
                return Resp(body)
        with pytest.raises(nd.FetchError) as e:
            nd.fetch_pdf("https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?idsId=1", Sess())
        assert reason in str(e.value)


def test_candidates_are_ordered_by_a_numeric_market_cap_never_by_text():
    # company-metadata.market_cap is text: "SUSPENDED" sorted first under a text ORDER BY, so a run
    # over the largest companies read suspended ones (production, 2026-11-05).
    assert "SUSPENDED" not in nd.SELECT_SQL
    assert "::float8 END DESC NULLS LAST" in nd.SELECT_SQL


def test_a_one_code_notice_about_a_company_outside_the_record_is_withheld_not_filed_under_the_holder():
    # NAB lodged a 603 about Spenda (SPX, not in ASIC's report); ASX listed it under NAB. Filed under
    # NAB it made NAB a 13.58% holder of itself (production, 2026-11-05).
    companies = {"NAB": "National Australia Bank Limited", "SPX": "Spenda Limited"}
    assert nd.resolve_target(["NAB"], "Becoming a substantial holder", "Spenda Limited", companies, frozenset({"NAB"})) == ""
    # The same document with Spenda live resolves to Spenda; one that names NAB itself stays NAB.
    assert nd.resolve_target(["NAB"], "Becoming a substantial holder", "Spenda Limited", companies, frozenset({"NAB", "SPX"})) == "SPX"
    assert nd.resolve_target(["NAB"], "Becoming a substantial holder", "National Australia Bank Limited", companies, frozenset({"NAB"})) == "NAB"
    # A document whose company line could not be read keeps the listed code, as before.
    assert nd.resolve_target(["NAB"], "Becoming a substantial holder", "", companies, frozenset({"NAB"})) == "NAB"


# --- the run: budget, dry run, systemic errors ----------------------------------------------------

class FakeConn:
    """The run's database. shares is one count for every code, or {code: count}; companies and live
    are the reference the run reads once (company-metadata names, ASIC's live codes)."""

    def __init__(self, rows, shares=0, companies=None, live=("ZIP",)):
        self.rows = rows
        self.shares = shares
        self.companies = companies if companies is not None else {"ZIP": "Zip Co Limited"}
        self.live = list(live)
        self.commits = 0
        self.statements = []
        self.params = []

    def cursor(self):
        conn = self

        class Cur(FakeCursor):
            def execute(self, sql, params=None):
                conn.statements.append(" ".join(sql.split()))
                conn.params.append(params)
                if "FROM substantial_holder_notice_attempts a" in sql:
                    self._fetch = conn.rows
                elif "TOTAL_PRODUCT_IN_ISSUE" in sql:
                    shares = conn.shares
                    if isinstance(shares, dict):
                        shares = shares.get(params[0], 0)
                    self._fetch = (shares,)
                elif "to_regclass" in sql:
                    self._fetch = (False,)
                elif 'FROM "company-metadata"' in sql and "company_name IS NOT NULL" in sql:
                    self._fetch = list(conn.companies.items())
                elif 'SELECT DISTINCT "PRODUCT_CODE"' in sql:
                    self._fetch = [(c,) for c in conn.live]
                else:
                    self._fetch = None
                self.rowcount = 1
                self.sql.append((" ".join(sql.split()), params))

            def fetchall(self):
                return self._fetch or []

        return Cur(rowcount=1)

    def commit(self):
        self.commits += 1

    def close(self):
        pass


def row(url, code="ZIP", outcome="no_voting_power", announced=ANNOUNCED, headline=HEADLINE_604, cap=10**9,
        company="Zip Holdings Limited", listed=None):
    """One candidate as SELECT_SQL returns it; listed is the codes ASX lists the notice under."""
    return (url, code, outcome, "", announced, headline, cap, company, list(listed or [code]))


def test_a_dry_run_reads_and_writes_nothing(monkeypatch):
    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: make_pdf([TEXT]))
    conn = FakeConn([row("https://www.asx.com.au/asxpdf/1.pdf")], shares=664_000_000)
    ex = extractor({"P": answer_604(), "C": answer_604()})
    counts = nd.run(conn, ex, limit=0, workers=1, budget_min=10, since="", dry_run=True)
    assert counts["recovered:agree"] == 1 and counts.get("written") is None
    assert conn.commits == 0
    assert not any(s.startswith("INSERT INTO substantial_holder_notices") for s in conn.statements)


def test_a_real_run_writes_a_recovered_notice_and_commits(monkeypatch):
    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: make_pdf([TEXT]))
    conn = FakeConn([row("https://www.asx.com.au/asxpdf/1.pdf")], shares=664_000_000)
    ex = extractor({"P": answer_604(), "C": answer_604()})
    counts = nd.run(conn, ex, limit=0, workers=1, budget_min=10, since="", dry_run=False)
    assert counts["written"] == 1 and conn.commits == 1
    assert any(s.startswith("INSERT INTO substantial_holder_notices") for s in conn.statements)


def test_a_withheld_second_read_is_recorded_not_written(monkeypatch):
    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: make_pdf([TEXT]))
    conn = FakeConn([row("https://www.asx.com.au/asxpdf/1.pdf")], shares=664_000_000)
    bad = answer_604(form="603")
    counts = nd.run(conn, extractor({"P": bad, "C": bad, "A": bad}), limit=0, workers=1, budget_min=10,
                    since="", dry_run=False)
    assert counts["withheld:invalid_form_contradicts_headline"] == 1
    assert any("SET read_by = 'model', detail" in s for s in conn.statements)


def test_model_errors_are_counted_and_never_recorded(monkeypatch):
    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: make_pdf([TEXT]))
    rows = [row(f"https://www.asx.com.au/asxpdf/{i}.pdf") for i in range(6)]
    conn = FakeConn(rows, shares=664_000_000)
    ex = extractor({"P": dx.ModelCallError("P: HTTP 503"), "C": dx.ModelCallError("C: HTTP 503")})
    counts = nd.run(conn, ex, limit=0, workers=1, budget_min=10, since="", dry_run=False)
    assert counts["model_error"] >= 5
    assert counts["systemic"] == 1
    assert not any("read_by = 'model'" in s for s in conn.statements), "a model failure is not an attempt"


def test_a_zero_budget_starts_nothing(monkeypatch):
    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: make_pdf([TEXT]))
    conn = FakeConn([row("https://www.asx.com.au/asxpdf/1.pdf")])
    counts = nd.run(conn, extractor({"P": answer_604(), "C": answer_604()}), limit=0, workers=1,
                    budget_min=0, since="", dry_run=True)
    assert counts.get("recovered:agree") is None and counts["not_started"] == 1


def test_a_read_still_running_past_the_budget_and_its_grace_is_abandoned_and_nothing_recorded(monkeypatch):
    # The first live run hung for 106 minutes past its budget inside a model call, until the pod's
    # deadline killed it with nothing logged. A read past the budget plus BUDGET_GRACE_S is
    # abandoned: counted, logged, nothing written, and the run returns without waiting for it.
    import threading

    release = threading.Event()

    def hang(extractor, cand, *args, **kwargs):
        release.wait(30)
        return {"kind": "fetch_failed", "reason": "released"}

    monkeypatch.setattr(nd, "read_one", hang)
    monkeypatch.setattr(nd, "BUDGET_GRACE_S", 0.5)
    conn = FakeConn([row("https://www.asx.com.au/asxpdf/1.pdf")], shares=664_000_000)
    try:
        counts = nd.run(conn, extractor({}), limit=0, workers=1, budget_min=0.001, since="", dry_run=False)
    finally:
        release.set()
    assert counts["abandoned"] == 1 and conn.commits == 0
    assert counts.get("fetch_failed") is None


def test_the_notice_client_tries_twice_with_a_two_minute_timeout(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    ex = nd.from_env()
    assert ex is not None
    assert ex.client.timeout == 120.0 and ex.client.max_attempts == 2


def test_a_fetch_failure_is_not_an_attempt(monkeypatch):
    def boom(url, session=None):
        raise nd.FetchError("HTTP 403")

    monkeypatch.setattr(nd, "fetch_pdf", boom)
    conn = FakeConn([row("https://www.asx.com.au/asxpdf/1.pdf")], shares=664_000_000)
    counts = nd.run(conn, extractor({}), limit=0, workers=1, budget_min=10, since="", dry_run=False)
    assert counts["fetch_failed"] == 1 and conn.commits == 0


# --- the gold set ------------------------------------------------------------------------------

def gold_entries():
    if not GOLD.exists():
        return []
    return json.loads(GOLD.read_text())["notices"]


def test_the_gold_set_has_thirty_notices_across_the_outcomes_and_both_kinds():
    entries = gold_entries()
    assert len(entries) == 30
    assert {e["parser_outcome"] for e in entries} == {"no_text", "no_voting_power", "no_holder"}
    assert sum(1 for e in entries if e["scan"]) >= 5
    assert sum(1 for e in entries if not e["scan"]) >= 5
    assert len({e["url"] for e in entries}) == 30


@pytest.mark.parametrize("entry", gold_entries(), ids=lambda e: e["id"])
def test_a_gold_reading_validates_against_its_own_document(entry):
    if entry.get("reading_status") == "awaiting hand reading":
        pytest.skip("no hand reading recorded yet (gold.json reading_status)")
    text = "" if entry["scan"] else (HERE / entry["text_file"]).read_text()
    reading = entry["reading"]
    if reading is None:
        assert entry["withheld_expected"] is True
        return
    n, why = nd.validate_notice(reading, text, headline=entry["headline"], announced_on=entry["announced_on"],
                                shares_on_issue=entry.get("shares_on_issue") or 0, scan=entry["scan"], model="gold")
    assert why == "", why
    assert n.form == reading["form"]
    assert n.present_pct == reading.get("present_pct") and n.previous_pct == reading.get("previous_pct")


# --- review fixes: 605, event dates, share counts, parity with the Go parser ----------------

CEASE_TEXT = TEXT.replace("Change in", "Ceasing") + " The holder ceased to hold 5.12% of the shares."
CEASE_HEADLINE = "Ceasing to be a substantial holder from VGI"


def answer_605(**over):
    a = {"is_substantial_holder_notice": True, "holder_name": "Vanguard Group Pty Ltd", "form": "605",
         "previous_pct": 5.12, "previous_votes": None, "present_pct": None, "present_votes": None,
         "event_date": None, "ceased": True,
         "quotes": {"holder_name": "Name: Vanguard Group Pty Ltd", "previous_pct": "stated voting power of 5.12%"}}
    a.update(over)
    return a


def test_a_605_that_states_a_present_figure_at_or_over_five_is_withheld():
    over5 = answer_605(present_pct=6.2, quotes={"holder_name": "Name: Vanguard Group Pty Ltd",
                                              "previous_pct": "stated voting power of 5.12%",
                                              "present_pct": "present voting power is 6.40%"})
    assert validate(over5, text=CEASE_TEXT, headline=CEASE_HEADLINE)[1] == "contradicts_605"


def test_a_605_whose_present_figure_is_not_lower_than_the_previous_is_withheld():
    # the probe that passed review: previous 6.20 and present 7.10 were both kept and ceased
    text = CEASE_TEXT + " Previous 6.20%. Present 4.10%."
    lower_now = answer_605(previous_pct=6.20, present_pct=4.10,
                           quotes={"holder_name": "Name: Vanguard Group Pty Ltd",
                                   "previous_pct": "Previous 6.20%", "present_pct": "Present 4.10%"})
    assert validate(lower_now, text=text, headline=CEASE_HEADLINE)[0] is not None
    text = CEASE_TEXT + " Previous 6.20%. Present 7.10%."
    up = answer_605(previous_pct=6.20, present_pct=7.10,
                    quotes={"holder_name": "Name: Vanguard Group Pty Ltd",
                            "previous_pct": "Previous 6.20%", "present_pct": "Present 7.10%"})
    assert validate(up, text=text, headline=CEASE_HEADLINE)[1] == "contradicts_605"
    rising = answer_605(previous_pct=4.90, present_pct=4.95)
    assert validate(rising, text=CEASE_TEXT, headline=CEASE_HEADLINE)[1] == "implausible_previous_under_5"


def test_a_605_is_read_with_no_votes_and_its_figures_are_not_written():
    n, why = validate(answer_605(previous_votes=35_000_000), text=CEASE_TEXT, headline=CEASE_HEADLINE)
    assert why == "" and n.ceased and n.previous_votes is None and n.present_votes is None
    cur = FakeCursor(rowcount=1)
    assert nd.write_recovered(cur, "https://x/1.pdf", "ZIP", ANNOUNCED, n) is True
    params = cur.sql[0][1]
    assert params[8] is None and params[9] is None, "a 605 stores no percentages, as notice.go"
    assert params[12] is True


def test_an_event_date_is_kept_only_when_its_quote_states_it():
    ok = validate(answer_604())[0]
    assert ok.event_date == "2026-10-14"
    no_quote = answer_604(quotes={**answer_604()["quotes"], "event_date": None})
    assert validate(no_quote)[0].event_date is None
    invented = answer_604(quotes={**answer_604()["quotes"], "event_date": "Date of change: 14 October 2026"},
                          event_date="2026-09-01")
    assert validate(invented)[0].event_date is None, "a date its quote does not state is not stored"
    quote_is_not_the_date = answer_604(quotes={**answer_604()["quotes"], "event_date": "Form 604 Corporations Act"})
    assert validate(quote_is_not_the_date)[0].event_date is None


def test_a_date_in_a_numeric_quote_is_matched_by_its_parts():
    assert nd.date_in_quote("2026-10-14", "dated 14/10/2026")
    assert nd.date_in_quote("2026-10-14", "on 14 Oct 2026")
    assert not nd.date_in_quote("2026-10-14", "on 14 Oct 2025")


def test_a_date_one_reader_disputes_drops_the_date_and_keeps_the_notice():
    no_date = answer_604(event_date=None, quotes={**answer_604()["quotes"], "event_date": None})
    ex = extractor({"P": answer_604(), "C": no_date, "A": no_date})
    n, outcome = ex.extract(ctx())
    assert outcome == "agree" and n.present_pct == 6.40 and n.event_date is None


def test_a_date_both_readers_state_is_kept():
    ex = extractor({"P": answer_604(), "C": answer_604()})
    n, outcome = ex.extract(ctx())
    assert outcome == "agree" and n.event_date == "2026-10-14"


PG_URL = os.environ.get("REPORT_EXTRACTOR_TEST_POSTGRES_URL", "")

PG_SCHEMA = """
CREATE TEMP TABLE asx_announcements (pdf_url text, announcement_date date, headline text, stock_code text);
CREATE TEMP TABLE "company-metadata" (stock_code text, market_cap bigint, company_name text);
CREATE TEMP TABLE substantial_holder_notice_attempts (announcement_url text PRIMARY KEY, stock_code text,
    outcome text, detail text, read_by text NOT NULL DEFAULT 'parser', attempted_at timestamptz);
CREATE TEMP TABLE substantial_holder_notices (announcement_url text PRIMARY KEY, stock_code text, form text,
    holder_name text, holder_key text, institution_slug text, event_date date, announced_on date,
    previous_pct double precision, present_pct double precision, previous_votes bigint, present_votes bigint,
    ceased boolean, parser_version int, parsed_at timestamptz, read_by text NOT NULL DEFAULT 'parser');
CREATE TEMP TABLE shorts ("DATE" date, "PRODUCT_CODE" text, "TOTAL_PRODUCT_IN_ISSUE" double precision);
"""


@pytest.mark.skipif(not PG_URL, reason="set REPORT_EXTRACTOR_TEST_POSTGRES_URL to run the SQL against Postgres")
def test_the_selection_and_writes_run_against_postgres(monkeypatch):
    # The SQL runs on a real server, in one transaction of temporary tables that is rolled back.
    # The default run (no --since: None reaches the query) must select, as PostgreSQL folds a
    # ''::date cast in the old SQL and failed every run without --since.
    import psycopg2

    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: make_pdf([TEXT]))
    url = "https://www.asx.com.au/asxpdf/pg-1.pdf"
    conn = psycopg2.connect(PG_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(PG_SCHEMA)
            cur.execute("INSERT INTO asx_announcements VALUES (%s, %s, %s, %s)", (url, ANNOUNCED, HEADLINE_604, "ZIP"))
            cur.execute('INSERT INTO "company-metadata" VALUES (%s, %s, %s)', ("ZIP", 10**9, "Zip Co Limited"))
            cur.execute("INSERT INTO substantial_holder_notice_attempts (announcement_url, stock_code, outcome, detail)"
                        " VALUES (%s, %s, 'no_voting_power', '')", (url, "ZIP"))
            cur.execute('INSERT INTO shorts ("DATE", "PRODUCT_CODE", "TOTAL_PRODUCT_IN_ISSUE") VALUES (%s, %s, %s)',
                        (ANNOUNCED, "ZIP", 664_000_000.0))
            cur.execute(nd.SELECT_SQL, {"since": None, "limit": 10})
            assert [r[0] for r in cur.fetchall()] == [url]
            cur.execute(nd.SELECT_SQL, {"since": "2020-01-01", "limit": 10})
            assert [r[0] for r in cur.fetchall()] == [url]
            cur.execute(nd.SELECT_SQL, {"since": "2030-01-01", "limit": 10})
            assert cur.fetchall() == []
        counts = nd.run(conn, extractor({"P": answer_604(), "C": answer_604()}), limit=0, workers=1,
                        budget_min=10, since="", dry_run=True)
        assert counts["selected"] == 1 and counts["recovered:agree"] == 1
        with conn.cursor() as cur:
            assert nd.write_recovered(cur, url, "ZIP", ANNOUNCED,
                                      nd.validate_notice(answer_604(), TEXT, headline=HEADLINE_604,
                                                         announced_on=ANNOUNCED, shares_on_issue=SHARES,
                                                         scan=False, model="P")[0]) is True
            cur.execute("SELECT read_by FROM substantial_holder_notices WHERE announcement_url = %s", (url,))
            assert cur.fetchone()[0] == "model"
            cur.execute("SELECT outcome, read_by FROM substantial_holder_notice_attempts WHERE announcement_url = %s", (url,))
            assert cur.fetchone() == ("parsed", "model")
    finally:
        conn.rollback()
        conn.close()


def test_the_parser_version_is_the_go_constant():
    src = (HERE.parent / "jobs" / "internal" / "jobs" / "ownership" / "notice.go").read_text()
    m = re.search(r"const noticeParserVersion = (\d+)", src)
    assert m and int(m.group(1)) == nd.NOTICE_PARSER_VERSION


def test_the_name_tails_are_the_go_registry_list():
    src = (HERE.parent / "jobs" / "internal" / "jobs" / "ownership" / "registry.go").read_text()
    block = re.search(r"var nameTails = \[\]string\{(.*?)\n\}", src, re.S).group(1)
    go_tails = tuple(re.findall(r'"((?:[^"\\]|\\.)*)"', block))
    assert go_tails == nd.NAME_TAILS


@pytest.mark.parametrize("name,want", [
    ("JPMorgan Chase & Co. and its affiliates", "JPMorgan Chase & Co"),  # the Go TrimRight drops the dot
    ("Acme Capital Pty Ltd as trustee for the Acme Trust", "Acme Capital Pty Ltd"),
    ("Vanguard Group Pty Ltd", "Vanguard Group Pty Ltd"),
])
def test_a_holder_key_is_cut_at_the_registry_tail(name, want):
    assert nd.tidy_holder_name(name) == want
    assert nd.holder_key(name) == nd.holder_key(want)


def test_a_document_that_fails_to_read_is_withheld_and_the_run_goes_on(monkeypatch):
    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: b"%PDF-1.4 corrupt")

    def boom(pdf):
        raise ValueError("cannot open")
    monkeypatch.setattr(nd, "document_text", boom)
    cand = nd.Candidate("https://x/1.pdf", "ZIP", "no_text", "", ANNOUNCED, HEADLINE_604, None, shares=SHARES)
    res = nd.read_one(extractor({"P": answer_604(), "C": answer_604()}), cand, {})
    assert res == {"kind": "withheld", "reason": "unreadable_pdf", "detail": "ValueError", "scan": False}


def test_a_rasterise_failure_is_a_fetch_failure_never_an_attempt(monkeypatch):
    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: b"%PDF-1.4 scan")
    monkeypatch.setattr(nd, "document_text", lambda pdf: ("", True, 1))

    def no_raster(pdf, pages):
        raise OSError("no rasteriser")
    monkeypatch.setattr(nd, "document_images", no_raster)
    cand = nd.Candidate("https://x/1.pdf", "ZIP", "no_text", "", ANNOUNCED, HEADLINE_604, None, shares=SHARES)
    res = nd.read_one(extractor({"P": answer_604(), "C": answer_604()}), cand, {})
    assert res["kind"] == "fetch_failed"


# --- review fixes: a leap day, a missing share count, the gold gate -------------------------

def test_a_29_february_announcement_takes_go_year_before_bound():
    # Go's AddDate(-1, 0, 0) on 29 Feb 2024 is 1 March 2023: an event on that day is kept, one day
    # earlier is not. The old replace() raised ValueError and the read was counted as crashed.
    assert nd.plausible_event_date("2023-03-01", "2024-02-29") == "2023-03-01"
    assert nd.plausible_event_date("2023-02-28", "2024-02-29") == ""
    assert nd.plausible_event_date("2024-02-20", "2024-02-29") == "2024-02-20"


def test_a_missing_share_count_is_pending_not_recorded(monkeypatch):
    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: make_pdf([TEXT]))
    conn = FakeConn([row("https://www.asx.com.au/asxpdf/7.pdf")], shares=0)
    ex = extractor({"P": answer_604(), "C": answer_604()})
    counts = nd.run(conn, ex, limit=0, workers=1, budget_min=10, since="", dry_run=False)
    assert counts["no_share_count"] == 1
    assert conn.commits == 0
    assert not any("read_by = 'model'" in s for s in conn.statements), "a gap in our data is not an attempt"


def test_the_gold_gate_refuses_a_write_while_a_notice_is_unread(monkeypatch):
    assert nd.gold_unread() == [], "the committed gold set has a notice nobody has read"
    # With one notice unread the gate refuses. It runs before any environment or database check,
    # so the refusal needs no model key.
    monkeypatch.setattr(nd, "gold_unread", lambda path=None: ["UNREAD-1"])
    monkeypatch.setattr(nd, "from_env", lambda: None)
    assert nd.main(["--no-dry-run"]) == 2
    # The explicit override passes the gate; the stub then stops the run before any model or database.
    assert nd.main(["--no-dry-run", "--skip-gold-check"]) == 1
    # A dry run is never gated.
    assert nd.main([]) == 1


def test_gold_unread_counts_a_withheld_reading_as_read_and_a_pending_one_as_unread(tmp_path):
    import json as _j
    entries = [
        {"id": "a", "reading": None, "withheld_expected": True},
        {"id": "b", "reading": {"form": "604"}, "withheld_expected": None},
        {"id": "c", "reading": None, "withheld_expected": None, "reading_status": "awaiting hand reading"},
        {"id": "d", "reading": None, "withheld_expected": None},
    ]
    path = tmp_path / "gold.json"
    path.write_text(_j.dumps({"notices": entries}))
    assert nd.gold_unread(path) == ["c", "d"]


# --- no share count on record: not fetched, not read, nothing written ---------------------------

def test_a_notice_with_no_share_count_is_neither_fetched_nor_read(monkeypatch):
    def no_fetch(url, session=None):
        raise AssertionError("a notice with no count on record must not be fetched")

    monkeypatch.setattr(nd, "fetch_pdf", no_fetch)
    ex = extractor({})
    cand = nd.Candidate("https://www.asx.com.au/asxpdf/9.pdf", "ZIP", "no_voting_power", "", ANNOUNCED,
                        HEADLINE_604, None, shares=0.0)
    assert nd.read_one(ex, cand, {}) == {"kind": "no_share_count"}
    assert ex.client.calls == [], "no model is called for a notice whose votes cannot be checked"


def test_a_605_with_no_share_count_is_still_read_because_it_states_no_votes(monkeypatch):
    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: make_pdf([CEASE_TEXT]))
    ex = extractor({"P": answer_605(), "C": answer_605()})
    cand = nd.Candidate("https://www.asx.com.au/asxpdf/10.pdf", "VGI", "no_voting_power", "", ANNOUNCED,
                        CEASE_HEADLINE, None, shares=0.0)
    res = nd.read_one(ex, cand, {})
    assert res["kind"] == "recovered" and res["notice"].ceased is True


def test_a_run_counts_a_notice_with_no_count_as_no_share_count_with_no_fetch_call_or_write(monkeypatch):
    def no_fetch(url, session=None):
        raise AssertionError("fetched a notice with no count on record")

    monkeypatch.setattr(nd, "fetch_pdf", no_fetch)
    conn = FakeConn([row("https://www.asx.com.au/asxpdf/11.pdf")], shares=0)
    counts = nd.run(conn, extractor({}), limit=0, workers=1, budget_min=10, since="", dry_run=False)
    assert counts["no_share_count"] == 1 and counts.get("crashed") is None
    assert counts["model_calls"] == 0 and counts["systemic"] == 0
    assert conn.commits == 0
    assert not any("read_by = 'model'" in s for s in conn.statements), "not an attempt, not written"


# --- the gold set: every notice is read by hand -------------------------------------------------


def test_every_gold_entry_is_read_by_hand_and_each_reading_validates():
    entries = gold_entries()
    pending = {e["id"] for e in entries if e.get("reading_status") == "awaiting hand reading"}
    assert pending == set(), "no gold entry may await a hand reading"
    for e in entries:
        reading = e["reading"]
        if reading is None:
            assert e["withheld_expected"] is True and e.get("withheld_reason"), e["id"]
            continue
        text = "" if e["scan"] else (HERE / e["text_file"]).read_text()
        n, why = nd.validate_notice(reading, text, headline=e["headline"], announced_on=e["announced_on"],
                                    shares_on_issue=e.get("shares_on_issue") or 0, scan=e["scan"], model="gold")
        assert why == "", (e["id"], why)
        if e["scan"]:
            # a scan has no text to quote, so the hand reading must still say where each figure came from
            for field in ("previous_pct", "present_pct", "previous_votes", "present_votes"):
                if reading.get(field) is not None:
                    assert reading["quotes"].get(field), (e["id"], field)


def test_a_gold_notice_with_no_count_on_record_is_withheld_for_that_reason_and_not_read():
    # read_one's rule applied to the gold set: a 603 or 604 with no ASIC count is never read, so its
    # entry is withheld with the no_share_count reason. A 605 needs no count and is read or withheld on its text.
    for e in gold_entries():
        if (e.get("shares_on_issue") or 0) > 0 or nd.form_from_headline(e["headline"]) == "605":
            continue
        assert e["reading"] is None, e["id"]
        assert (e.get("withheld_reason") or "").startswith("no_share_count"), e["id"]


# --- the bench: a wrong-withheld reading counts against its fields; one set of model names ---

def test_a_reading_where_the_hand_result_is_withheld_is_wrong_on_every_field_it_states():
    import bench_notices as bn

    n, why = validate(answer_604())
    assert why == ""
    verdict, marks = bn.score_one({"reading": None}, n)
    assert verdict == "wrong"
    assert set(marks) == set(bn.FIELDS) and not any(marks.values())


def test_the_bench_flags_override_the_environment_and_an_empty_flag_is_no_model():
    import argparse

    import bench_notices as bn

    args = argparse.Namespace(primary="flag/primary", checker="", arbiter=None, scan_primary=None, scan_checker=None)
    names = bn.names_from_args(args, environ={"EXTRACTOR_PRIMARY_MODEL": "env/primary"})
    assert names["primary"] == "flag/primary"
    assert names["checker"] is None
    assert names["arbiter"] == dx.ARBITER_MODEL
    assert names["scan_primary"] == nd.SCAN_PRIMARY_MODEL


def test_from_env_and_the_bench_name_the_same_models(monkeypatch):
    import argparse

    import bench_notices as bn

    env = {"EXTRACTOR_PRIMARY_MODEL": "bench/primary", "EXTRACTOR_CHECKER_MODEL": "bench/checker",
           "NOTICE_SCAN_CHECKER_MODEL": "bench/scan-b"}
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    names = bn.names_from_args(argparse.Namespace(primary=None, checker=None, arbiter=None,
                                                  scan_primary=None, scan_checker=None))
    ex = nd.from_env()
    assert (ex.primary, ex.checker, ex.arbiter, ex.scan_primary, ex.scan_checker) == tuple(
        names[k] for k in nd.MODEL_KEYS)
    assert ex.primary == "bench/primary" and ex.scan_checker == "bench/scan-b"


def test_the_bench_scores_a_cache_under_the_names_it_is_given(monkeypatch):
    import bench_notices as bn

    entry = next(e for e in gold_entries() if e["id"] == "FPR-2026-10-21-ebd0c367")
    monkeypatch.setattr(bn, "load_gold", lambda path=None: [entry])
    names = nd.model_names_from_env({"EXTRACTOR_PRIMARY_MODEL": "bench/primary",
                                     "EXTRACTOR_CHECKER_MODEL": "bench/checker"})
    cache = {f"bench/primary|{entry['id']}": entry["reading"], f"bench/checker|{entry['id']}": entry["reading"]}
    got = bn.score(cache, False, names)
    assert got["correct"] == 1 and got["uncached"] == 0 and got["models"] == names
    # the default names were never asked for these answers, so the same cache misses under them
    miss = bn.score(cache, False, nd.model_names_from_env({}))
    assert miss["uncached"] == 1 and miss["correct"] == 0


def test_fill_refuses_to_call_a_model_without_the_live_switch(monkeypatch):
    import bench_notices as bn

    monkeypatch.delenv("NOTICE_BENCH_LIVE", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "not-used")
    with pytest.raises(SystemExit):
        bn.fill({}, nd.model_names_from_env({}))


def test_fill_without_a_cache_file_refuses_before_any_model_call(monkeypatch):
    import sys

    import bench_notices as bn

    called = []
    monkeypatch.setattr(bn, "fill", lambda *a, **k: called.append(a))
    monkeypatch.setattr(sys, "argv", ["bench_notices.py", "--fill"])
    with pytest.raises(SystemExit) as stop:
        bn.main()
    assert "cache" in str(stop.value).lower() and called == []


def test_the_bench_skips_a_notice_with_no_stored_file_and_scores_the_rest_without_a_model():
    # Five scans over 300 KB keep no PDF. An empty path names this folder, which always exists, so the
    # bench must check for a file, not a path, or it crashes on the first such notice.
    import bench_notices as bn

    gold = gold_entries()
    unstored = [e["id"] for e in gold if not bn.has_document(e)]
    assert len(unstored) == 5 and all(e["scan"] for e in gold if e["id"] in unstored)
    got = bn.score({}, False, nd.model_names_from_env({}))
    assert got["skipped"] == len(unstored)
    assert got["uncached"] + got["correct"] + got["wrong"] + got["withheld_correct"] + got["withheld_missed"] \
        == len(gold) - len(unstored)


# --- the first live bench: holders by grouping key, the subject company, class rows, the date ----


def test_a_holder_key_drops_an_acn_tail_so_the_registry_name_keys_the_same():
    assert nd.tidy_holder_name("EC Pohl & Co Pty Ltd ACN 154 399 916") == "EC Pohl & Co Pty Ltd"
    assert nd.holder_key("EC Pohl & Co Pty Ltd ACN 154 399 916") == nd.holder_key("EC Pohl & Co Pty Ltd")
    assert nd.holder_key("Acme Holdings Ltd (ACN 000 000 019)") == nd.holder_key("Acme Holdings Ltd")
    assert nd.tidy_holder_name("Acnova Ltd") == "Acnova Ltd", "an ACN tail needs its own word and a space"


def test_holders_are_one_when_their_grouping_keys_agree_not_their_text():
    assert nd.holder_same("Perennial Value Management Limited (PVM", "Perennial Value Management Limited")
    assert nd.holder_same("Regal Funds Management Pty Ltd and its associates (see Annexure 1",
                          "Regal Funds Management Pty Ltd")
    assert not nd.holder_same("Perennial Value Management Limited", "Perennial Investments Limited")
    assert not nd.holder_same("", "")


def test_two_readers_that_name_one_holder_with_different_tails_still_agree():
    ex = extractor({"P": answer_604(holder_name="Vanguard Group Pty Ltd ACN 000 000 019"), "C": answer_604()})
    n, outcome = ex.extract(ctx())
    assert outcome == "agree" and n.holder_key == "name:vanguard group"


def test_a_company_is_no_holder_of_itself():
    assert validate(answer_604())[0] is not None
    n, why = nd.validate_notice(answer_604(), TEXT, headline=HEADLINE_604, announced_on=ANNOUNCED,
                                shares_on_issue=SHARES, scan=False, model="m",
                                company_name="Vanguard Group Pty Ltd ACN 000 000 019")
    assert n is None and why == "holder_is_subject_company"


def test_a_recovered_notice_stores_the_tidied_holder_name_as_notice_go_does():
    n, why = validate(answer_604(holder_name="Vanguard Group Pty Ltd ACN 000 000 019"))
    assert why == ""
    cur = FakeCursor(rowcount=1)
    assert nd.write_recovered(cur, "https://x/1.pdf", "ZIP", ANNOUNCED, n) is True
    assert cur.sql[0][1][3] == "Vanguard Group Pty Ltd" and cur.sql[0][1][4] == "name:vanguard group"


def test_a_legal_name_the_ocr_misreads_as_ply_is_withheld_and_pty_is_not():
    n, why = validate(answer_604(holder_name="FMR Investments Ply Limited (FMR)"))
    assert n is None and why == "ocr_misspelled_legal_name"
    assert nd.OCR_PLY_LEGAL_NAME.search("FMR Investments Pty Limited") is None


CLASS_TEXT = TEXT + " Class of securities: ORD 42,500,000 6.40%. Class ADR 148 0.00%. Total 42,500,000 6.40%."


def answer_603_two_classes(**over):
    q = {k: v for k, v in answer_604()["quotes"].items() if not k.startswith("previous")}
    a = answer_604(form="603", previous_pct=None, previous_votes=None, voting_class_rows=2, quotes=q)
    a.update(over)
    return a


def test_several_class_rows_with_no_quoted_total_are_withheld():
    headline = "Becoming a substantial holder from VGI"
    no_total = nd.validate_notice(answer_603_two_classes(), CLASS_TEXT, headline=headline,
                                  announced_on=ANNOUNCED, shares_on_issue=SHARES, scan=False, model="m")
    assert no_total[0] is None and no_total[1] == "several_classes_without_total"
    with_total = answer_603_two_classes()
    with_total["quotes"]["total_row"] = "Total 42,500,000 6.40%"
    assert nd.validate_notice(with_total, CLASS_TEXT, headline=headline, announced_on=ANNOUNCED,
                              shares_on_issue=SHARES, scan=False, model="m")[1] == ""
    one_class = answer_603_two_classes(voting_class_rows=1)
    assert nd.validate_notice(one_class, CLASS_TEXT, headline=headline, announced_on=ANNOUNCED,
                              shares_on_issue=SHARES, scan=False, model="m")[1] == ""
    # A class row quoted as the total: located in the text, but the figures are not in it.
    class_as_total = answer_603_two_classes()
    class_as_total["quotes"]["total_row"] = "Class ADR 148 0.00%"
    assert nd.validate_notice(class_as_total, CLASS_TEXT, headline=headline, announced_on=ANNOUNCED,
                              shares_on_issue=SHARES, scan=False, model="m")[1] == "figures_not_from_total_row"
    fake_total = answer_603_two_classes()
    fake_total["quotes"]["total_row"] = "Total 99,999,999 9.99%"
    assert nd.validate_notice(fake_total, CLASS_TEXT, headline=headline, announced_on=ANNOUNCED,
                              shares_on_issue=SHARES, scan=False, model="m")[1] == "several_classes_without_total"


def test_the_prompt_asks_for_the_class_rows_the_total_row_and_the_section_one_date():
    assert '"voting_class_rows"' in nd.SYSTEM_PROMPT and '"total_row"' in nd.SYSTEM_PROMPT
    assert "section 1" in nd.SYSTEM_PROMPT and "changes table" in nd.SYSTEM_PROMPT


EGG_TEXT = (HERE / "testdata" / "notices" / "text" / "EGG-2026-08-24-f087c682.txt").read_text()
NOL_TEXT = (HERE / "testdata" / "notices" / "text" / "NOL-2025-06-16-1691d56f.txt").read_text()


def egg_604(event, quote):
    return {"is_substantial_holder_notice": True, "holder_name": "Perennial Value Management Limited (PVM)",
            "form": "604", "previous_pct": 12.0, "previous_votes": 10887187, "present_pct": 15.0,
            "present_votes": 13609629, "event_date": event, "ceased": False,
            "quotes": {"holder_name": "Perennial Value Management Limited (PVM)", "previous_pct": "12.00",
                       "previous_votes": "10,887,187", "present_pct": "15.00", "present_votes": "13,609,629",
                       "event_date": quote}}


def test_an_event_date_from_a_changes_row_or_the_signature_block_is_dropped_and_section_one_is_kept():
    def check(answer, text, headline, announced, shares):
        return nd.validate_notice(answer, text, headline=headline, announced_on=announced,
                                  shares_on_issue=shares, scan=False, model="m")
    egg = ("Change in substantial holding from ENE", "2026-08-24", 90735121)
    n, why = check(egg_604("2026-08-21", "21 August 2026"), EGG_TEXT, *egg)
    assert why == "" and n.event_date == "2026-08-21", "section 1's date is kept"
    n, why = check(egg_604("2026-08-10", "10/08/2026"), EGG_TEXT, *egg)
    assert why == "" and n.event_date is None, "a changes row: the date has a broker's name after it"
    n, why = check(egg_604("2026-08-24", "24/08/2026"), EGG_TEXT, *egg)
    assert why == "" and n.event_date is None, "the signature date: under 'Date' and beside 'Sign Here'"
    assert n.present_pct == 15.0, "the notice itself is kept when only its date is dropped"


def test_the_nol_section_one_date_is_kept_and_its_subject_company_is_refused():
    nol_headline = "Becoming a substantial holder"
    holder = {"is_substantial_holder_notice": True, "holder_name": "EC Pohl & Co Pty Ltd", "form": "603",
              "previous_pct": None, "previous_votes": None, "present_pct": 9.9, "present_votes": 9200000,
              "event_date": "2025-06-12", "ceased": False,
              "quotes": {"holder_name": "EC Pohl & Co Pty Ltd", "present_pct": "9.9%",
                         "present_votes": "9,200,000", "event_date": "12 / 06 / 2025"}}
    n, why = nd.validate_notice(holder, NOL_TEXT, headline=nol_headline, announced_on="2025-06-16",
                                shares_on_issue=92799434, scan=False, model="m")
    assert why == "" and n.event_date == "2025-06-12"
    subject = {**holder, "holder_name": "NOBLEOAK LIFE LIMITED",
               "quotes": {**holder["quotes"], "holder_name": "NOBLEOAK LIFE LIMITED"}}
    n, why = nd.validate_notice(subject, NOL_TEXT, headline=nol_headline, announced_on="2025-06-16",
                                shares_on_issue=92799434, scan=False, model="m",
                                company_name="NOBLEOAK LIFE LIMITED")
    assert n is None and why == "holder_is_subject_company"


def test_the_scorer_compares_holders_by_their_grouping_key():
    import bench_notices as bn

    assert bn.same_field("holder", "Perennial Value Management Limited (PVM", "Perennial Value Management Limited")
    assert bn.same_field("holder", "Regal Funds Management Pty Ltd and its associates (see Annexure 1",
                         "Regal Funds Management Pty Ltd")
    assert not bn.same_field("holder", "Perennial Investments Limited", "Perennial Value Management Limited")


@pytest.mark.parametrize("name,want", [
    ("EC Pohl & Co Pty Ltd ACN 154 399 916", "EC Pohl & Co Pty Ltd"),
    ("Acme Holdings Ltd (ACN 000 000 019)", "Acme Holdings Ltd"),
    ("Acme Pty Ltd ACN:154399916", "Acme Pty Ltd"),
    ("Acme Pty Ltd ABN 12 004 085 616", "Acme Pty Ltd"),
    ("The ABN AMRO Group", "The ABN AMRO Group"),
    ("ABN AMRO Clearing Sydney Pty Ltd", "ABN AMRO Clearing Sydney Pty Ltd"),
    ("Citigroup and ABN AMRO Bank", "Citigroup and ABN AMRO Bank"),
    ("Smith ACN Holdings", "Smith ACN Holdings"),
    ("Acnova Ltd", "Acnova Ltd"),
])
def test_an_acn_tail_is_cut_only_with_its_digits_as_the_go_pattern_cuts_it(name, want):
    assert nd.tidy_holder_name(name) == want


def test_the_acn_tail_pattern_is_the_go_pattern():
    src = (HERE.parent / "jobs" / "internal" / "jobs" / "ownership" / "registry.go").read_text()
    m = re.search(r"var nameTailID = regexp\.MustCompile\(`(.*?)`\)", src, re.S)
    assert m and m.group(1) == nd.NAME_TAIL_ID.pattern


def test_the_section_one_date_is_kept_when_a_watermark_or_a_run_on_line_sits_beside_it():
    holder = "Vanguard Group Pty Ltd"
    watermark = ("1. Details of substantial holder\nThe holder became a substantial holder on\n"
                 "12/06/2025 For personal use only\nName: Vanguard Group Pty Ltd\n")
    s = watermark.index("12/06/2025")
    assert nd.date_beside_table_or_signature(watermark, s, s + 10, holder) is False
    run_on = ("There was a change in the interests of the substantial holder on 21 August 2026 "
              "The previous notice was given on 29 July 2026")
    s = run_on.index("21 August 2026")
    assert nd.date_beside_table_or_signature(run_on, s, s + 14, holder) is False
    bare = "Signature\n12/06/2025 For personal use only\n6. Associates The reasons the persons"
    s = bare.index("12/06/2025")
    assert nd.date_beside_table_or_signature(bare, s, s + 10, holder) is False


def test_a_changes_row_and_the_signature_date_are_still_dropped():
    holder = "Perennial Value Management Limited"
    row = "Date of change\n10/08/2026 Northern Trust\nBuy on the Market\n122,488"
    s = row.index("10/08/2026")
    assert nd.date_beside_table_or_signature(row, s, s + 10, holder) is True
    broker_below = "Date of change\n10/08/2026\nNorthern Trust\nBuy on the Market"
    s = broker_below.index("10/08/2026")
    assert nd.date_beside_table_or_signature(broker_below, s, s + 10, holder) is True
    nature_below = "Date of change\n10/08/2026\nBuy on the Market\n122,488"
    s = nature_below.index("10/08/2026")
    assert nd.date_beside_table_or_signature(nature_below, s, s + 10, holder) is True
    holder_on_line = f"Some words\n12/06/2025 {holder} bought"
    s = holder_on_line.index("12/06/2025")
    assert nd.date_beside_table_or_signature(holder_on_line, s, s + 10, holder) is True
    signature = "Date\n24/08/2026\nSign Here\nFor personal use only"
    s = signature.index("24/08/2026")
    assert nd.date_beside_table_or_signature(signature, s, s + 10, holder) is True


def test_the_egg_section_one_date_is_kept_and_its_changes_row_is_dropped():
    s = EGG_TEXT.index("21 August 2026")
    assert nd.date_beside_table_or_signature(EGG_TEXT, s, s + 14, "Perennial Value Management Limited (PVM)") is False


def test_a_self_filed_notice_about_escrowed_shares_is_not_refused_as_the_subject_company():
    answer = answer_604(holder_name="Vanguard Group Pty Ltd ACN 000 000 019")
    text = TEXT + " The shares are escrowed under the listing rules."
    n, why = nd.validate_notice(answer, text, headline=HEADLINE_604, announced_on=ANNOUNCED,
                                shares_on_issue=SHARES, scan=False, model="m",
                                company_name="Vanguard Group Pty Ltd ACN 000 000 019")
    assert why == "" and n is not None


RHC_TEXT = (HERE / "testdata" / "notices" / "text" / "RHC-2024-07-16-e2e1da90.txt").read_text()


def rhc_603(classes, total=None):
    quotes = {"holder_name": "BlackRock Group", "present_pct": "5.08", "present_votes": "11,683,101"}
    if total is not None:
        quotes["total_row"] = total
    return {"is_substantial_holder_notice": True, "holder_name": "BlackRock Group", "form": "603",
            "previous_pct": None, "previous_votes": None, "present_pct": 5.08, "present_votes": 11683101,
            "voting_class_rows": classes, "event_date": None, "ceased": False, "quotes": quotes}


@pytest.mark.parametrize("classes", [2, 2.0, "2"])
def test_the_ramsay_two_class_table_with_no_total_row_is_withheld_whatever_form_the_count_takes(classes):
    n, why = nd.validate_notice(rhc_603(classes), RHC_TEXT, headline="Becoming a substantial holder",
                                announced_on="2024-07-16", shares_on_issue=229754474, scan=False, model="m")
    assert n is None and why == "several_classes_without_total"


def test_the_ramsay_table_with_a_total_row_the_text_states_is_not_withheld_for_its_classes():
    _, why = nd.validate_notice(rhc_603(2, total="ORD 11,683,101 11,683,101 5.08"), RHC_TEXT,
                                headline="Becoming a substantial holder", announced_on="2024-07-16",
                                shares_on_issue=229754474, scan=False, model="m")
    assert why != "several_classes_without_total"


def test_a_holder_resolves_to_its_institution_by_the_tidied_name_as_go_does():
    ctx_inst = nd.ReadContext(text=TEXT, images=None, headline=HEADLINE_604, announced_on=ANNOUNCED,
                              shares_on_issue=SHARES, scan=False,
                              institutions={"vanguard group pty ltd": "vanguard"})
    answer = answer_604(holder_name="Vanguard Group Pty Ltd ACN 000 000 019",
                        quotes={**answer_604()["quotes"], "holder_name": "Name: Vanguard Group Pty Ltd"})
    n, outcome = extractor({"P": answer, "C": answer}).extract(ctx_inst)
    assert outcome == "agree" and n.institution_slug == "vanguard" and n.holder_key == "vanguard"


# --- the subject company: the Go rules, ported (notices.go resolveTarget, foldCompanyName) -------------

GO_SAME_COMPANY = [
    ("ZIP CO LIMITED", "Zip Co Ltd"),
    ("ARB Corporation Ltd", "ARB Corporation Limited"),
    ("Macquarie Group Limited", "MACQUARIE GROUP LTD"),
    ("Wildcat Resources Limited ( WC8 )", "Wildcat Resources Limited"),
    ("Domino's Pizza Enterprises Limited", "Dominos Pizza Enterprises Ltd"),
    ("Acme Holdings Pty Ltd", "ACME PTY LTD"),
    ("Mineral Resources Limited.", "mineral resources limited"),
    ("SITEMINDER LIMITED", "SiteMinder Limited"),  # the notice that named SiteMinder under CBA (2026-11-05)
]
GO_DIFFERENT_COMPANY = [
    ("Zip Co Limited", "Zip Pay Limited"),
    ("ARB Corporation", "ARP Corporation"),
    ("Zip Co Limited", "Zip Creditcard Limited"),
]


@pytest.mark.parametrize("a,b", GO_SAME_COMPANY)
def test_the_fold_of_a_company_name_is_the_go_fold(a, b):
    assert nd.fold_company_name(a) != "" and nd.fold_company_name(a) == nd.fold_company_name(b)


@pytest.mark.parametrize("a,b", GO_DIFFERENT_COMPANY)
def test_the_fold_tells_different_companies_apart(a, b):
    assert nd.fold_company_name(a) != nd.fold_company_name(b)


def test_the_fold_of_suffixes_only_is_empty():
    assert nd.fold_company_name("Co Ltd") == ""


def test_the_company_suffixes_are_the_go_map():
    src = (HERE.parent / "jobs" / "internal" / "jobs" / "ownership" / "notices.go").read_text()
    block = re.search(r"var companySuffixes = map\[string\]bool\{(.*?)\n\}", src, re.S).group(1)
    assert set(re.findall(r'"([a-z]+)": true', block)) == set(nd.COMPANY_SUFFIXES)


# The companies on record for the resolver cases (company-metadata names).
RESOLVE_COMPANIES = {
    "CBA": "Commonwealth Bank of Australia", "CAR": "CAR Group Limited", "WTC": "WiseTech Global Limited",
    "MQG": "Macquarie Group Limited", "MIN": "Mineral Resources Limited", "WC8": "Wildcat Resources Limited",
    "ZIP": "Zip Co Limited", "Z1P": "Zip Co Limited", "ARB": "ARB Corporation Limited", "ARP": "ARB Corporation Limited",
    "SDR": "SiteMinder Limited", "SMX": "SiteMinder Limited",
}
CHANGE = "Change in substantial holding"

# (name, listed codes, headline, subject name, live codes, the code the Go pass files it under)
RESOLVE_CASES = [
    ("a holder's notice for CAR", ["CBA", "CAR"], "Becoming a substantial holder for CAR", "", {"CAR"}, "CAR"),
    ("a notice from the company's holder", ["MQG", "WTC"], "Ceasing to be a substantial holder from MQG", "", set(), "WTC"),
    ("one code, no subject", ["ZIP"], CHANGE, "", set(), "ZIP"),
    ("the to line decides between two codes", ["MIN", "WC8"], CHANGE, "Wildcat Resources Limited ( WC8 )", set(), "WC8"),
    ("ambiguous without a subject", ["MIN", "WC8"], CHANGE, "", set(), ""),
    ("in CAR", ["CBA"], "Becoming a substantial holder in CAR", "", set(), "CAR"),
    ("a delisted target is withheld", ["CBA"], "Change in substantial holding for IRE", "", set(), ""),
    ("retargets a holder's notice to the company it names", ["CBA"], CHANGE, "SITEMINDER LIMITED", {"SDR", "CBA"}, "SDR"),
    ("names the listed company itself", ["CBA"], CHANGE, "Commonwealth Bank of Australia", {"CBA"}, "CBA"),
    ("names a company not on record: withheld, never the listed code", ["CBA"], CHANGE, "Acme Widgets Limited", {"SDR"}, ""),
    ("two live companies carry the name: withheld", ["CBA"], CHANGE, "SiteMinder Limited", {"SDR", "SMX"}, ""),
    ("the matching company is not live: withheld", ["CBA"], CHANGE, "SiteMinder Limited", {"CBA"}, ""),
    ("a listed code with no name on record stands", ["NOP"], CHANGE, "SiteMinder Limited", {"SDR"}, "NOP"),
    ("the one live code of the name", ["Z1P", "ZIP"], CHANGE, "ZIP CO LIMITED", {"ZIP"}, "ZIP"),
    ("two live codes of the name are ambiguous", ["Z1P", "ZIP"], CHANGE, "ZIP CO LIMITED", {"ZIP", "Z1P"}, ""),
    ("no live code is ambiguous", ["Z1P", "ZIP"], CHANGE, "ZIP CO LIMITED", set(), ""),
    ("a live code whose name does not fold to the subject's", ["Z1P", "ZIP"], CHANGE, "Zip Pay Limited", {"ZIP"}, ""),
    ("the same rule for ARB", ["ARB", "ARP"], CHANGE, "ARB Corporation Ltd", {"ARB"}, "ARB"),
]


@pytest.mark.parametrize("name,listed,headline,subject,live,want", RESOLVE_CASES, ids=[c[0] for c in RESOLVE_CASES])
def test_resolve_target_follows_the_go_rules(name, listed, headline, subject, live, want):
    assert nd.resolve_target(listed, headline, subject, RESOLVE_COMPANIES, frozenset(live)) == want


# --- the subject company: what a reading names, and where it is filed ---------------------------------

SUBJECT_TEXT = TEXT.replace("Zip Co Limited", "SiteMinder Limited")
REF_LIVE = frozenset({"CBA", "SDR"})


def subject_answer(subject, **over):
    """A 604 that names the subject company on its To line, with the quote that states it."""
    a = answer_604(subject_company=subject, **over)
    a["quotes"] = dict(a["quotes"], subject_company=f"To Company Name/Scheme: {subject}")
    return a


def subject_ctx(text=SUBJECT_TEXT, scan=False, shares=None, listed=("CBA",), live=REF_LIVE, shares_on=None):
    companies = {"CBA": RESOLVE_COMPANIES["CBA"], "SDR": "SiteMinder Limited"}
    return nd.ReadContext(text=text, images=[b"png"] if scan else None, headline=CHANGE,
                          announced_on=ANNOUNCED, shares_on_issue=SHARES, scan=scan, candidate_code="CBA",
                          listed_codes=tuple(listed), shares_by_code=shares if shares is not None else {"CBA": 1.6e9},
                          reference=nd.Reference(companies=companies, live=live), shares_on=shares_on)


def test_a_notice_names_its_subject_and_is_checked_against_that_companys_count():
    ctx = subject_ctx(shares={"CBA": 1.6e9, "SDR": SHARES})
    n, outcome = extractor({"P": subject_answer("SiteMinder Limited"), "C": subject_answer("SiteMinder Limited")}).extract(ctx)
    assert outcome == "agree" and n.stock_code == "SDR"
    # The holder's count (1.6bn) would refuse the same votes; the subject's count is the one checked.
    assert validate(subject_answer("SiteMinder Limited"), text=SUBJECT_TEXT, shares=1.6e9)[1] == "inconsistent_votes"


def test_the_subject_count_is_looked_up_when_the_run_provides_one():
    looked = []

    def shares_on(code, on):
        looked.append((code, on))
        return SHARES if code == "SDR" else 0.0

    ctx = subject_ctx(shares={"CBA": 1.6e9}, shares_on=shares_on)
    n, outcome = extractor({"P": subject_answer("SiteMinder Limited"), "C": subject_answer("SiteMinder Limited")}).extract(ctx)
    assert outcome == "agree" and n.stock_code == "SDR" and ("SDR", ANNOUNCED) in looked


def test_a_subject_with_no_count_on_record_is_not_checked_against_the_listed_codes_count():
    ctx = subject_ctx(shares={"CBA": 1.6e9})
    assert extractor({"P": subject_answer("SiteMinder Limited"), "C": subject_answer("SiteMinder Limited")}).extract(ctx) == (
        None, "invalid_no_share_count")


def test_a_reply_that_names_no_subject_is_withheld_when_the_run_has_a_reference():
    no_subject = answer_604()  # no subject_company key at all
    assert extractor({"P": no_subject, "C": no_subject}).extract(subject_ctx()) == (None, "invalid_subject_unresolved")


@pytest.mark.parametrize("why,answer,text", [
    ("the quote is not in the text", subject_answer("SiteMinder Limited", quotes={}), TEXT.replace("Zip Co Limited", "Acme")),
    ("the quote does not name it", dict(subject_answer("SiteMinder Limited"), quotes={
        **answer_604()["quotes"], "subject_company": "To Company Name/Scheme: Commonwealth Bank"}), SUBJECT_TEXT),
    ("the name is not on record", subject_answer("Acme Widgets Limited"), SUBJECT_TEXT),
])
def test_a_subject_the_run_cannot_settle_is_withheld(why, answer, text):
    n, reason = nd.resolve_subject(answer, subject_ctx(text=text))
    assert n is None and reason == nd.SUBJECT_UNRESOLVED, why


def test_two_live_companies_of_the_subjects_name_withhold_it():
    ctx = subject_ctx(live=frozenset({"CBA", "SDR", "SMX"}), shares={"CBA": 1.6e9, "SDR": SHARES})
    ctx.reference.companies["SMX"] = "SiteMinder Limited"
    assert nd.resolve_subject(subject_answer("SiteMinder Limited"), ctx) == (None, nd.SUBJECT_UNRESOLVED)


def test_a_scan_resolves_its_subject_by_name_since_it_has_no_text_to_quote():
    subject, why = nd.resolve_subject(subject_answer("SiteMinder Limited"), subject_ctx(text="", scan=True,
                                                                                         shares={"SDR": SHARES}))
    assert why == "" and subject.code == "SDR" and subject.shares == SHARES


def test_a_replayed_answer_keeps_the_candidates_own_subject():
    ctx = nd.ReadContext(text=TEXT, images=None, headline=HEADLINE_604, announced_on=ANNOUNCED,
                         shares_on_issue=SHARES, scan=False, candidate_code="ZIP", company_name="Zip Co Limited")
    subject, why = nd.resolve_subject(answer_604(), ctx)
    assert why == "" and (subject.code, subject.name, subject.shares) == ("ZIP", "Zip Co Limited", SHARES)


def test_a_notice_is_filed_under_the_company_its_document_names_through_the_run(monkeypatch):
    # Listed under CBA alone, the notice names SiteMinder: it is written under SDR, the attempt follows
    # it, and the votes were checked against SDR's count (CBA's 1.6bn would refuse them).
    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: make_pdf([SUBJECT_TEXT]))
    url = "https://www.asx.com.au/asxpdf/sdr.pdf"
    conn = FakeConn([row(url, code="CBA", listed=["CBA"], headline=CHANGE, company="Commonwealth Bank of Australia")],
                    shares={"CBA": 1.6e9, "SDR": SHARES},
                    companies={"CBA": "Commonwealth Bank of Australia", "SDR": "SiteMinder Limited"}, live=("CBA", "SDR"))
    counts = nd.run(conn, extractor({"P": subject_answer("SiteMinder Limited"), "C": subject_answer("SiteMinder Limited")}),
                    limit=0, workers=1, budget_min=10, since="", dry_run=False)
    assert counts["written"] == 1, counts
    upsert = next(p for s_, p in zip(conn.statements, conn.params) if s_.startswith("INSERT INTO substantial_holder_notices"))
    assert upsert[1] == "SDR"
    attempt = next(p for s_, p in zip(conn.statements, conn.params) if s_.startswith("UPDATE substantial_holder_notice_attempts"))
    assert "SDR" in attempt and url in attempt


def test_a_replayed_answer_without_a_subject_is_the_candidates_own():
    # The bench's cache predates subject_company: with no reference the reply's subject is the
    # candidate's own code and name, so the cache still scores (7 readings, 0 wrong). The run, which
    # always has a reference, withholds the same reply (test_a_reply_that_names_no_subject...).
    no_subject = answer_604()
    del no_subject["subject_company"]
    ctx = nd.ReadContext(text=TEXT, images=None, headline=HEADLINE_604, announced_on=ANNOUNCED,
                         shares_on_issue=SHARES, scan=False, candidate_code="ZIP", company_name="Zip Co Limited")
    assert nd.resolve_subject(no_subject, ctx) == (nd.Subject("ZIP", "Zip Co Limited", SHARES), "")
    n, outcome = extractor({"P": no_subject, "C": no_subject}).extract(ctx)
    assert outcome == "agree" and n.stock_code == "ZIP"


def test_a_run_withholds_a_reply_with_no_subject_and_writes_nothing(monkeypatch):
    monkeypatch.setattr(nd, "fetch_pdf", lambda url, session=None: make_pdf([TEXT]))
    conn = FakeConn([row("https://www.asx.com.au/asxpdf/nosubject.pdf")], shares=664_000_000)
    no_subject = answer_604()
    del no_subject["subject_company"]
    counts = nd.run(conn, extractor({"P": no_subject, "C": no_subject}), limit=0, workers=1, budget_min=10,
                    since="", dry_run=False)
    assert counts.get("withheld:invalid_subject_unresolved") == 1 and counts.get("written") is None
    assert not any(s_.startswith("INSERT INTO substantial_holder_notices") for s_ in conn.statements)
