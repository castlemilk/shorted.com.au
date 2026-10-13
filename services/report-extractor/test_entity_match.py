"""Parity tests: entity_match.py against extractiontrust.EntityMatches (Go).

The shared fixture testdata/entity_matches_cases.json is asserted here AND by
the Go package's entity_cases_test.go, so what --repair-document-meta reports
about the entity gates is what the gates themselves decide.
"""
import codecs
import json
import re

import pytest

import entity_match as em
import extraction_trust
from extractor_test_support import fixture_path


def _cases():
    path = fixture_path("entity_matches_cases.json")
    if not path.exists():
        pytest.skip("services/pkg/extractiontrust is not in this checkout")
    return json.loads(path.read_text(encoding="utf-8"))


def test_entity_matches_shared_fixture():
    cases = _cases()
    assert len(cases) >= 30
    pairs = [(c["entity"], c["company"]) for c in cases]
    assert len(set(pairs)) == len(pairs), "a duplicate fixture row"
    assert sum(c["want"] for c in cases) >= 10 and sum(not c["want"] for c in cases) >= 10
    wrong = [c for c in cases if em.entity_matches(c["entity"], c["company"]) is not c["want"]]
    assert wrong == []


def test_fixture_carries_the_names_the_repair_turned_on():
    # Copied from TestEntityFixtureCarriesTheRepairsNames: the prod dry run's
    # (2026-10-13) VIT, AXR, BP8, CQR, JHG and JHL.
    got = {(c["entity"], c["company"]): c["want"] for c in _cases()}
    for pair, want in {
        ("Vitura Health Limited", "Vitura Health"): True,
        ("Cortexa Pty Ltd", "Vitura Health"): False,
        ("Sturt Exploration Pty Ltd", "Axiant Resources"): False,
        ("Ocean Sciences Ltd (formerly BPH Global Ltd)", "Bph Global"): True,
        ("Ocean Sciences Ltd (formerly BPH Global Ltd)", "Ocean Sciences"): True,
        ("Ocean Sciences Ltd", "Bph Global"): False,
        ("Charter Hall Retail REIT", "Charter Hall Retail Reit"): True,
        ("JPMorgan Global Equity Premium Income Fund", "Janus Henderson Cdi 1:1 For. Exempt"): False,
        ("JPMorgan Global Select Equity Fund", "Jayex Healthcare"): False,
    }.items():
        assert got.get(pair) is want, pair


# Copied from TestEntityTokens.
def test_entity_tokens():
    got = em.entity_tokens("The Domino’s Pizza Enterprises Ltd (ABN 12 345)")
    assert {"dominos", "pizza", "enterprises", "12", "345"} <= got
    assert not got & {"the", "ltd", "abn"}
    assert em.entity_key("Echo IQ Limited") == em.entity_key("Echoiq") == "echoiq"


def test_an_absent_company_name_reads_as_none():
    # select_document_meta_rows' LEFT JOIN gives None for a code with no
    # "company-metadata" row; every gate reads that as "" and withholds.
    assert em.entity_matches("Vitura Health Limited", None) is False
    assert em.entity_matches(None, "Vitura Health") is False


def _go_string(literal):
    """A Go string literal's value: "interpreted" (\\uXXXX escapes) or `raw`."""
    if literal.startswith("`"):
        return literal[1:-1]
    return codecs.decode(literal[1:-1], "unicode_escape")


def test_the_fold_table_matches_the_go_source():
    # Normalise's fold is half of an entity's tokens: a curly apostrophe left in
    # splits "Domino's" in two, an invisible character left in splits a word.
    # entity_match reads names through extraction_trust.normalise, so its table
    # is pinned to normalise.go's foldReplacer, pair for pair.
    path = fixture_path("entity_matches_cases.json").parent.parent / "normalise.go"
    if not path.exists():
        pytest.skip("services/pkg/extractiontrust is not in this checkout")
    body = re.search(r"foldReplacer = strings\.NewReplacer\((.*?)\n\)", path.read_text(encoding="utf-8"), re.S)
    assert body
    code = "\n".join(line.split("//", 1)[0] for line in body.group(1).splitlines())
    literals = [_go_string(s) for s in re.findall(r'"(?:[^"\\]|\\.)*"|`[^`]*`', code)]
    assert literals and len(literals) % 2 == 0
    assert dict(zip(literals[::2], literals[1::2])) == extraction_trust._FOLD
