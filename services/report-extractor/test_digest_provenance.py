"""Offline persistence regressions: record the selected digest model, not a default."""
import json
import sys
from types import SimpleNamespace

import pytest
from google import genai
from extractor_test_support import stub_missing_deps

stub_missing_deps()
import extract
import extract_reports_concurrent as runner
import direct_extract
from test_extract import _Conn
from test_model_errors import DOC_TEXT, GOOD_DIGEST, GROUNDED, REPORT


def stored_row(conn):
    sql, params = conn.statements[-1]
    assert sql.startswith('INSERT INTO financial_report_extractions (')
    columns = sql.split('(', 1)[1].split(')', 1)[0].split(', ')
    return dict(zip(columns, params))


def wire(monkeypatch, model_id, openrouter_model=None, response=None):
    conn = _Conn()
    calls = []
    payload = json.dumps(GOOD_DIGEST) if response is None else response
    monkeypatch.setattr(runner, '_conn', lambda: conn)
    monkeypatch.setattr(runner, '_session', lambda: object())
    monkeypatch.setattr(extract, 'read_first_available', lambda *a, **k: (dict(REPORT), DOC_TEXT, extract.FETCH_OK))
    monkeypatch.setattr(extract, 'download_text_from_gcs', lambda *a: DOC_TEXT)
    monkeypatch.setattr(extract, 'upload_raw_text_to_gcs', lambda *a: None)
    monkeypatch.setattr(extract, 'extract_financial_data', lambda *a, **k: GROUNDED)

    def google_call(*, model, **kwargs):
        calls.append(('google', model))
        return SimpleNamespace(text=payload, usage_metadata=None)

    monkeypatch.setenv('GEMINI_API_KEY', 'offline-test-key')
    monkeypatch.setattr(genai, 'Client', lambda **k: SimpleNamespace(models=SimpleNamespace(generate_content=google_call)))
    direct = None
    if openrouter_model:
        def openrouter_call(client, model, *args, **kwargs):
            calls.append(('openrouter', model))
            return payload
        monkeypatch.setattr(direct_extract, 'summarize', openrouter_call)
        direct = SimpleNamespace(primary=openrouter_model, client=object(), extract=lambda *a, **k: GROUNDED)
    return conn, calls, direct


@pytest.mark.parametrize('route', ['normal', 'backfill'])
@pytest.mark.parametrize('model,openrouter_model', [
    ('gemini-2.5-flash', None),
    ('gemini-3.5-flash-lite', None),
    ('models/gemini-3.5-flash-lite', None),
    ('gemini-3.5-flash-lite', 'deepseek/deepseek-v4-flash'),
    ('gemini-3.5-flash-lite', 'google/gemini-2.5-flash'),
])
def test_route_persists_exact_requested_digest_model(monkeypatch, route, model, openrouter_model):
    conn, calls, direct = wire(monkeypatch, model, openrouter_model)
    if route == 'normal':
        result = runner.process(dict(REPORT), model, 8, False, direct=direct)
        assert result == 'ok'
    else:
        report = {**REPORT, 'metrics': '{}', 'raw_text_gcs_url': 'gs://offline/report.txt'}
        result = runner.process_digestless(report, model, 8, False, direct=direct)
        assert result == 'ok_gcs'
    expected = openrouter_model or model
    assert calls == [('openrouter' if direct else 'google', expected)]
    row = stored_row(conn)
    assert row['digest_model'] == expected
    assert row['digest'] == GOOD_DIGEST['digest']
    assert row['digest_confidence'] == GOOD_DIGEST['confidence']


@pytest.mark.parametrize('model', ['gemini-2.5-flash', 'gemini-3.5-flash-lite'])
def test_sequential_cli_persists_selected_model(monkeypatch, model):
    conn, calls, _ = wire(monkeypatch, model)
    conn.close = lambda: None
    monkeypatch.setattr(sys, 'argv', ['extract.py', '--codes', 'WBT', '--limit', '1', '--model', model])
    monkeypatch.setattr(extract, 'get_db_connection', lambda **k: conn)
    monkeypatch.setattr(extract, 'document_meta_column_exists', lambda c: False)
    monkeypatch.setattr(extract, 'extraction_attempts_column_exists', lambda c: False)
    monkeypatch.setattr(extract, 'get_reports_to_process', lambda *a, **k: [dict(REPORT)])
    extract.main()
    assert calls == [('google', model)]
    assert stored_row(conn)['digest_model'] == model


@pytest.mark.parametrize('digest', [None, {}, {'digest': '', 'confidence': 0.0}])
def test_no_digest_has_no_model_or_confidence(digest):
    conn = _Conn()
    extract.store_extraction(conn, REPORT, {}, 100, digest_result=digest,
                             digest_model='gemini-3.5-flash-lite')
    row = stored_row(conn)
    assert row['digest'] is row['digest_model'] is row['digest_confidence'] is None


def test_unspecified_provenance_is_not_guessed():
    conn = _Conn()
    extract.store_extraction(conn, REPORT, {}, 100, digest_result=GOOD_DIGEST)
    assert stored_row(conn)['digest_model'] is None


@pytest.mark.parametrize('openrouter_model', [None, 'deepseek/deepseek-v4-flash'])
def test_echo_clear_removes_digest_provenance(monkeypatch, openrouter_model):
    model = 'gemini-3.5-flash-lite'
    conn, calls, direct = wire(monkeypatch, model, openrouter_model, response='not json')
    report = {**REPORT, 'metrics': '{}', 'raw_text_gcs_url': 'gs://offline/report.txt', 'repair_echo': True}
    assert runner.process_digestless(report, model, 8, False, direct=direct) == 'echo_cleared'
    row = stored_row(conn)
    assert row['digest'] is row['digest_model'] is row['digest_confidence'] is None


@pytest.mark.parametrize('route', ['normal', 'backfill'])
def test_model_error_does_not_create_false_provenance(monkeypatch, route):
    conn, calls, direct = wire(monkeypatch, 'gemini-3.5-flash-lite')
    def failed(*a, **k):
        raise extract.ModelError('offline synthetic failure')
    monkeypatch.setattr(extract, 'summarize_report', failed)
    if route == 'normal':
        assert runner.process(dict(REPORT), 'gemini-3.5-flash-lite', 8, False) == 'digest_error'
        row = stored_row(conn)
        assert row['digest'] is row['digest_model'] is None
    else:
        report = {**REPORT, 'metrics': '{}', 'raw_text_gcs_url': 'gs://offline/report.txt'}
        assert runner.process_digestless(report, 'gemini-3.5-flash-lite', 8, False) == 'model_error'
        assert conn.statements == []


def test_storage_dry_run_writes_nothing_with_provenance():
    conn = _Conn()
    extract.store_extraction(conn, REPORT, {}, 100, dry_run=True,
                             digest_result=GOOD_DIGEST, digest_model='gemini-3.5-flash-lite')
    assert conn.statements == []
