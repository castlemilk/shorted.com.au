#!/usr/bin/env python3
"""Compare gemini-2.5-flash vs gpt-5.2 extraction quality on the same report."""

import json
import logging
import os
import time

import fitz
import langextract as lx
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# Import shared config from extract.py
from extract import (
    EXTRACTION_EXAMPLES,
    EXTRACTION_PROMPT,
    ASX_HEADERS,
    download_pdf_text,
    extractions_to_metrics,
)

MODELS = ["gemini-2.5-flash", "gpt-5.2"]

# Test reports: two different stocks for a broader comparison
TEST_REPORTS = [
    {
        "url": "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=02986017",
        "stock": "DMP",
        "title": "FY25 Appendix 4E / Annual Report",
    },
    {
        "url": "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=02918155",
        "stock": "DMP",
        "title": "Half Year 2025 Market Presentation",
    },
]


def extract_with_model(text: str, model_id: str) -> dict:
    """Run langextract with a specific model and return metrics + timing."""
    start = time.time()
    try:
        result = lx.extract(
            text_or_documents=text,
            prompt_description=EXTRACTION_PROMPT,
            examples=EXTRACTION_EXAMPLES,
            model_id=model_id,
            extraction_passes=1,
            max_workers=1,
            max_char_buffer=2000,
        )

        extractions = []
        if result and hasattr(result, "extractions"):
            for ext in result.extractions:
                extractions.append({
                    "class": ext.extraction_class,
                    "text": ext.extraction_text,
                    "attributes": ext.attributes if hasattr(ext, "attributes") else {},
                })

        elapsed = time.time() - start
        metrics = extractions_to_metrics(extractions) if extractions else {}
        return {"metrics": metrics, "elapsed": elapsed, "error": None, "raw_count": len(extractions)}

    except Exception as e:
        elapsed = time.time() - start
        return {"metrics": {}, "elapsed": elapsed, "error": str(e), "raw_count": 0}


def print_model_result(model: str, r: dict):
    """Pretty-print a single model's extraction results."""
    if r["error"]:
        print(f"  ERROR: {r['error'][:200]}")
        return
    print(f"  Time: {r['elapsed']:.1f}s")
    print(f"  Raw extractions: {r['raw_count']}")
    print(f"  Metric types: {len(r['metrics'])}")
    for metric_name, data in sorted(r["metrics"].items()):
        if isinstance(data, list):
            for d in data:
                source = d.get("source_text", "")[:100]
                attrs = {k: v for k, v in d.items() if k != "source_text"}
                print(f"    {metric_name}: {source}")
                if attrs:
                    print(f"      attrs: {attrs}")
        else:
            source = data.get("source_text", "")[:100]
            attrs = {k: v for k, v in data.items() if k != "source_text"}
            print(f"    {metric_name}: {source}")
            if attrs:
                print(f"      attrs: {attrs}")


def main():
    gemini_key = os.environ.get("LANGEXTRACT_API_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY")

    if not gemini_key:
        log.error("Set LANGEXTRACT_API_KEY for Gemini models")
    if not openai_key:
        log.error("Set OPENAI_API_KEY for GPT models")
    if not gemini_key and not openai_key:
        return

    session = requests.Session()
    session.headers.update(ASX_HEADERS)

    for report in TEST_REPORTS:
        log.info("=" * 70)
        log.info("Downloading: %s - %s", report["stock"], report["title"])
        text = download_pdf_text(session, report["url"], max_pages=10)
        if not text:
            log.error("Failed to download/extract PDF text, skipping")
            continue
        log.info("Extracted %d chars of text", len(text))

        results = {}
        for model in MODELS:
            # Skip if we don't have the right key
            if model.startswith("gpt") and not openai_key:
                results[model] = {"metrics": {}, "elapsed": 0, "error": "OPENAI_API_KEY not set", "raw_count": 0}
                continue
            if not model.startswith("gpt") and not gemini_key:
                results[model] = {"metrics": {}, "elapsed": 0, "error": "LANGEXTRACT_API_KEY not set", "raw_count": 0}
                continue

            log.info("Running: %s", model)
            results[model] = extract_with_model(text, model)

            if results[model]["error"]:
                log.error("  ERROR: %s", results[model]["error"][:100])
            else:
                log.info("  Extracted %d metric types in %.1fs",
                         len(results[model]["metrics"]), results[model]["elapsed"])

            # Pause between models to avoid rate limits
            log.info("  Pausing 10s between models...")
            time.sleep(10)

        # Print comparison for this report
        print("\n" + "=" * 80)
        print(f"REPORT: {report['stock']} - {report['title']}")
        print(f"Text length: {len(text)} chars")
        print("=" * 80)

        for model in MODELS:
            print(f"\n--- {model} ---")
            print_model_result(model, results[model])

        # Pause between reports
        if report != TEST_REPORTS[-1]:
            log.info("Pausing 15s between reports...")
            time.sleep(15)

    # Final summary
    print("\n" + "=" * 80)
    print("OVERALL SUMMARY")
    print("=" * 80)


if __name__ == "__main__":
    main()
