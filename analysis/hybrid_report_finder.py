#!/usr/bin/env python3
"""
Hybrid Financial Report Finder

Combines multiple intelligent sources:
1. GPT-4 guided web crawling (analyzes pages, suggests links)
2. Yahoo Finance API (financial data and report links)
3. Google Finance scraping (backup data source)
4. PayloadCMS investor links (existing gold mine)
5. ASX API (fallback)

This hybrid approach should achieve 90%+ coverage with high quality results.
"""

import os
import re
import json
import time
from typing import List, Dict, Any, Optional
from datetime import datetime
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

# Initialize OpenAI client
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# ============================================================================
# 1. GPT-GUIDED INTELLIGENT CRAWLER
# ============================================================================


def gpt_analyze_page_for_reports(
    url: str, html_snippet: str, stock_code: str
) -> Dict[str, Any]:
    """
    Use GPT-4 to intelligently analyze a page and suggest:
    - Which links likely lead to financial reports
    - Direct PDF links on the page
    - Best navigation strategy
    """

    # Create a simplified version of the HTML for GPT
    soup = BeautifulSoup(html_snippet, "html.parser")

    # Extract just the links and their context
    links_context = []
    for a_tag in soup.find_all("a", href=True)[:50]:  # Limit to first 50 links
        href = a_tag["href"]
        text = a_tag.get_text().strip()

        # Get surrounding context (parent element text)
        parent_text = a_tag.parent.get_text().strip()[:100] if a_tag.parent else ""

        links_context.append({"href": href, "text": text, "context": parent_text})

    prompt = f"""You are analyzing a webpage for {stock_code} to find financial reports (annual reports, quarterly reports, etc.).

URL: {url}

Links on the page:
{json.dumps(links_context[:20], indent=2)}

Task: Analyze these links and identify:
1. Direct PDF links to financial reports (if any)
2. Links that likely lead to a reports page/section
3. Priority ranking (1-10) for each promising link

Return JSON:
{{
  "direct_pdfs": [
    {{"url": "...", "title": "...", "type": "annual_report|quarterly_report|half_year_report", "year": "2024"}}
  ],
  "promising_links": [
    {{"url": "...", "reason": "...", "priority": 8}}
  ],
  "strategy": "Brief explanation of best approach"
}}
"""

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",  # Faster and cheaper for this task
            messages=[
                {
                    "role": "system",
                    "content": "You are an expert at analyzing web pages to find financial reports. Return only valid JSON.",
                },
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.3,
            max_tokens=1000,
        )

        return json.loads(response.choices[0].message.content)

    except Exception as e:
        print(f"  GPT analysis failed: {e}")
        return {
            "direct_pdfs": [],
            "promising_links": [],
            "strategy": "fallback to traditional crawl",
        }


def gpt_guided_crawl(
    start_url: str, stock_code: str, max_depth: int = 2
) -> List[Dict[str, str]]:
    """
    Use GPT-4 to intelligently guide the crawling process.
    """
    reports = []
    visited = set()

    def crawl_page(url: str, depth: int):
        if depth > max_depth or url in visited:
            return

        visited.add(url)

        try:
            print(f"  🤖 GPT analyzing: {url} (depth {depth})")

            response = httpx.get(
                url,
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=15.0,
                follow_redirects=True,
            )

            if response.status_code != 200:
                return

            # Use GPT to analyze the page
            analysis = gpt_analyze_page_for_reports(
                url, response.text[:50000], stock_code
            )

            print(f"    Strategy: {analysis.get('strategy', 'N/A')}")

            # Add direct PDFs found
            for pdf in analysis.get("direct_pdfs", []):
                full_url = urljoin(url, pdf["url"])
                reports.append(
                    {
                        "type": pdf.get("type", "annual_report"),
                        "url": full_url,
                        "title": pdf.get("title", ""),
                        "date": (
                            f"{pdf.get('year', '')}-06-30" if pdf.get("year") else ""
                        ),
                        "source": "gpt_guided_crawler",
                    }
                )
                print(f"    ✅ Found PDF: {pdf.get('title', 'Unknown')}")

            # Follow promising links (sorted by priority)
            promising = sorted(
                analysis.get("promising_links", []),
                key=lambda x: x.get("priority", 0),
                reverse=True,
            )

            for link in promising[:3]:  # Follow top 3 promising links
                next_url = urljoin(url, link["url"])
                if next_url not in visited:
                    print(
                        f"    🔗 Following: {link.get('reason', 'Unknown')} (priority: {link.get('priority', 0)})"
                    )
                    crawl_page(next_url, depth + 1)

        except Exception as e:
            print(f"    ⚠️  Error: {e}")

    crawl_page(start_url, 0)
    return reports


# ============================================================================
# 2. YAHOO FINANCE INTEGRATION
# ============================================================================


def fetch_yahoo_finance_data(stock_code: str) -> Dict[str, Any]:
    """
    Fetch financial data and report links from Yahoo Finance.

    Yahoo Finance structure:
    - Company profile
    - Financial statements
    - SEC filings (for US companies)
    - Key statistics
    """

    # Yahoo Finance uses .AX suffix for ASX stocks
    yahoo_symbol = f"{stock_code}.AX"

    reports = []
    financials = {}

    try:
        # 1. Try to get company profile page
        profile_url = f"https://finance.yahoo.com/quote/{yahoo_symbol}"

        response = httpx.get(
            profile_url,
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=15.0,
            follow_redirects=True,
        )

        if response.status_code == 200:
            soup = BeautifulSoup(response.content, "html.parser")

            # Extract company description
            description_elem = soup.find("section", {"data-test": "qsp-profile"})
            if description_elem:
                financials["description"] = description_elem.get_text().strip()

            # Look for SEC filings link (some ASX companies file with SEC)
            filings_link = soup.find("a", href=re.compile(r"sec.gov"))
            if filings_link:
                reports.append(
                    {
                        "type": "sec_filings",
                        "url": filings_link["href"],
                        "title": "SEC Filings",
                        "source": "yahoo_finance",
                    }
                )

        # 2. Try to get financials page (sometimes has report links)
        financials_url = f"https://finance.yahoo.com/quote/{yahoo_symbol}/financials"

        response = httpx.get(
            financials_url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15.0
        )

        if response.status_code == 200:
            soup = BeautifulSoup(response.content, "html.parser")

            # Yahoo sometimes embeds report links in financials page
            for a_tag in soup.find_all("a", href=True):
                href = a_tag["href"]
                text = a_tag.get_text().lower()

                if "annual" in text or "report" in text or "pdf" in href:
                    reports.append(
                        {
                            "type": "annual_report",
                            "url": urljoin(financials_url, href),
                            "title": a_tag.get_text().strip(),
                            "source": "yahoo_finance",
                        }
                    )

    except Exception as e:
        print(f"  ⚠️  Yahoo Finance error for {stock_code}: {e}")

    return {"reports": reports, "financials": financials}


# ============================================================================
# 3. GOOGLE FINANCE SCRAPING
# ============================================================================


def fetch_google_finance_data(stock_code: str) -> Dict[str, Any]:
    """
    Fetch data from Google Finance.

    Google Finance structure:
    - Company overview
    - Financial data
    - News (may include annual report announcements)
    """

    # Google Finance uses ASX:CODE format
    google_symbol = f"ASX:{stock_code}"

    reports = []
    financials = {}

    try:
        # Google Finance main page
        url = f"https://www.google.com/finance/quote/{stock_code}:ASX"

        response = httpx.get(
            url,
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=15.0,
            follow_redirects=True,
        )

        if response.status_code == 200:
            soup = BeautifulSoup(response.content, "html.parser")

            # Extract company description
            about_section = soup.find("div", {"class": re.compile(r"about", re.I)})
            if about_section:
                financials["description"] = about_section.get_text().strip()

            # Look for news about annual reports
            news_links = soup.find_all("a", {"class": re.compile(r"news", re.I)})
            for link in news_links:
                text = link.get_text().lower()
                if "annual report" in text or "financial report" in text:
                    reports.append(
                        {
                            "type": "news_about_report",
                            "url": link.get("href", ""),
                            "title": link.get_text().strip(),
                            "source": "google_finance",
                        }
                    )

    except Exception as e:
        print(f"  ⚠️  Google Finance error for {stock_code}: {e}")

    return {"reports": reports, "financials": financials}


# ============================================================================
# 4. HYBRID REPORT FINDER (Combines all sources)
# ============================================================================


def find_reports_hybrid(
    stock_code: str,
    company_name: str,
    investor_links: List[str],
    use_gpt_crawler: bool = True,
    use_yahoo: bool = True,
    use_google: bool = True,
) -> Dict[str, Any]:
    """
    Hybrid approach: Combine all sources intelligently.

    Strategy:
    1. Start with PayloadCMS investor links (highest quality)
    2. Use GPT-guided crawler if enabled
    3. Supplement with Yahoo Finance
    4. Supplement with Google Finance
    5. Deduplicate and rank results
    """

    all_reports = []
    all_financials = {}

    print(f"\n{'=' * 80}")
    print(f"🔍 Hybrid search: {stock_code} - {company_name}")
    print(f"{'=' * 80}")

    # Source 1: GPT-guided crawl of investor links
    if use_gpt_crawler and investor_links:
        print(f"\n1️⃣  GPT-Guided Crawl ({len(investor_links)} investor links)")
        for link in investor_links[:2]:  # Try first 2 links
            try:
                reports = gpt_guided_crawl(link, stock_code, max_depth=2)
                all_reports.extend(reports)
                print(f"  ✅ Found {len(reports)} reports from {link}")
            except Exception as e:
                print(f"  ⚠️  Error: {e}")

    # Source 2: Yahoo Finance
    if use_yahoo:
        print(f"\n2️⃣  Yahoo Finance")
        yahoo_data = fetch_yahoo_finance_data(stock_code)
        all_reports.extend(yahoo_data["reports"])
        all_financials.update(yahoo_data["financials"])
        print(f"  ✅ Found {len(yahoo_data['reports'])} reports")

    # Source 3: Google Finance
    if use_google:
        print(f"\n3️⃣  Google Finance")
        google_data = fetch_google_finance_data(stock_code)
        all_reports.extend(google_data["reports"])
        if google_data["financials"]:
            all_financials["google_description"] = google_data["financials"].get(
                "description", ""
            )
        print(f"  ✅ Found {len(google_data['reports'])} reports")

    # Deduplicate reports
    unique_reports = deduplicate_reports(all_reports)

    print(
        f"\n📊 Total: {len(unique_reports)} unique reports (from {len(all_reports)} raw)"
    )

    return {
        "stock_code": stock_code,
        "company_name": company_name,
        "reports": unique_reports,
        "financials": all_financials,
        "sources_used": {
            "gpt_crawler": use_gpt_crawler,
            "yahoo_finance": use_yahoo,
            "google_finance": use_google,
        },
    }


def deduplicate_reports(reports: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """
    Smart deduplication based on URL similarity and content.
    """
    from urllib.parse import urlparse, urlunparse, parse_qs, urlencode

    def normalize_url(url: str) -> str:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        # Remove tracking parameters
        cleaned_query = {
            k: v
            for k, v in query.items()
            if k not in ["utm_source", "utm_medium", "utm_campaign", "ei", "ref"]
        }
        new_query = urlencode(cleaned_query, doseq=True)
        return urlunparse(
            (parsed.scheme, parsed.netloc, parsed.path, "", new_query, "")
        )

    seen_urls = set()
    unique_reports = []

    for report in reports:
        url = report.get("url", "")
        if not url:
            continue

        norm_url = normalize_url(url)

        if norm_url not in seen_urls:
            seen_urls.add(norm_url)
            unique_reports.append(report)

    # Sort by date (most recent first)
    unique_reports.sort(key=lambda r: r.get("date", ""), reverse=True)

    return unique_reports


# ============================================================================
# TEST
# ============================================================================

if __name__ == "__main__":
    # Test on a few companies
    test_cases = [
        {
            "stock_code": "5GN",
            "company_name": "5G NETWORKS LIMITED",
            "investor_links": ["https://5gnetworks.au/investors"],
        },
        {
            "stock_code": "BHP",
            "company_name": "BHP GROUP LIMITED",
            "investor_links": ["https://www.bhp.com/investors/annual-reporting"],
        },
    ]

    for test in test_cases:
        result = find_reports_hybrid(
            test["stock_code"],
            test["company_name"],
            test["investor_links"],
            use_gpt_crawler=True,
            use_yahoo=True,
            use_google=True,
        )

        print(f"\n✅ Final Results:")
        print(f"   Reports found: {len(result['reports'])}")
        print(f"   Sources: {result['sources_used']}")

        if result["reports"]:
            print(f"\n   Sample reports:")
            for i, report in enumerate(result["reports"][:5], 1):
                print(
                    f"   {i}. [{report.get('type', 'unknown'):20s}] {report.get('title', 'N/A')[:50]}"
                )
                print(
                    f"      Source: {report.get('source', 'N/A'):20s} URL: {report.get('url', 'N/A')[:60]}"
                )

        time.sleep(2)  # Be nice to APIs
