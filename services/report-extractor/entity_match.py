"""Python port of extractiontrust.EntityMatches (services/pkg/extractiontrust/entity.go).

Whether a document's stated entity can be the company a code belongs to: the
ONE rule every entity gate applies (latest_filing.go, picks filings_ingest.go,
the dividend estimate's ConfirmEstimate), each to document_meta's entity as
extractiontrust.ParseDocumentMeta reads it, against "company-metadata".
company_name, and only when an entity is stated. --repair-document-meta asks it
whether a rewritten entity changes what those gates decide.

The shared fixture services/pkg/extractiontrust/testdata/entity_matches_cases.json
pins this port and the Go rule to the same answers (test_entity_match.py here,
entity_cases_test.go there). The token sets are document_meta's copies of
entity.go's, which test_document_meta.py diffs against the Go source.

This module has no third-party dependencies.
"""
from __future__ import annotations

import re
from typing import Optional

from document_meta import ENTITY_GENERIC_TOKENS, ENTITY_STOP_TOKENS
from extraction_trust import normalise

_ENTITY_TOKEN_SPLIT_RE = re.compile(r"[^a-z0-9]+")  # entity.go's entityTokenSplit


def _identifying_tokens(name: Optional[str]) -> list[str]:
    """A name's identifying tokens, in order: Normalise (typographic quotes
    folded, invisible characters removed, lower case), apostrophes removed
    ("Domino's" -> "dominos"), split on anything not alphanumeric, legal forms
    and connectives dropped. Go's strings.ToLower turns U+0130 (capital I with
    a dot) into a plain "i"; Python's str.lower() adds a combining dot, which
    would split the token, so it is replaced first."""
    folded = normalise((name or "").replace("\u0130", "i")).replace("'", "")
    return [t for t in _ENTITY_TOKEN_SPLIT_RE.split(folded) if t and t not in ENTITY_STOP_TOKENS]


def entity_tokens(name: Optional[str]) -> frozenset[str]:
    """extractiontrust.entityTokens: a name's identifying token set."""
    return frozenset(_identifying_tokens(name))


def entity_key(name: Optional[str]) -> str:
    """extractiontrust.entityKey: a name's identifying tokens, in order, run
    together: the same for "Echo IQ Limited" and "Echoiq"."""
    return "".join(_identifying_tokens(name))


def entity_matches(entity: Optional[str], company_name: Optional[str]) -> bool:
    """extractiontrust.EntityMatches: the two names share a token that is not
    merely an industry word AND the shared tokens are a strict majority of the
    smaller name's tokens; or they are the same name, however generic its words
    or however it is spaced. A name with no identifying token never matches,
    and neither does an empty company name (None reads as one): withhold rather
    than guess."""
    a, b = entity_tokens(entity), entity_tokens(company_name)
    if not a or not b:
        return False
    if entity_key(entity) == entity_key(company_name) or a == b:
        return True
    shared = a & b
    distinctive = any(t not in ENTITY_GENERIC_TOKENS for t in shared)
    return distinctive and len(shared) * 2 > min(len(a), len(b))
