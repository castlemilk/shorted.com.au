#!/usr/bin/env python3
"""
Company Metadata Enrichment Pipeline

Enriches company metadata using GPT-5.1 (reasoning model), smart web crawlers, and Yahoo Finance data.
Stores results in the main Postgres database.

Usage:
    # Process subset (testing)
    python enrich_database.py --limit 10

    # Process all companies
    python enrich_database.py --all

    # Process specific companies
    python enrich_database.py --stocks CBA BHP WBC

    # Resume from checkpoint
    python enrich_database.py --resume
"""

import os
import json
import time
import hashlib
from typing import Dict, Any, List, Optional
from datetime import datetime, date
from urllib.parse import urlparse, urljoin
import re

import httpx
from bs4 import BeautifulSoup
import pandas as pd
from sqlalchemy import create_engine, text
from tqdm import tqdm
from openai import OpenAI
import yfinance as yf

# Load environment variables from .env file
from dotenv import load_dotenv

load_dotenv()

# Configuration (must be set in .env file)
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
CMS_DATABASE_URL = os.getenv("CMS_DATABASE_URL")
DATABASE_URL = os.getenv("DATABASE_URL")
GCS_LOGO_BASE_URL = os.getenv(
    "GCS_LOGO_BASE_URL", "https://storage.googleapis.com/shorted-company-logos/logos"
)
GCS_FINANCIAL_REPORTS_BUCKET = os.getenv(
    "GCS_FINANCIAL_REPORTS_BUCKET", "shorted-financial-reports"
)
CHECKPOINT_FILE = "enrichment_checkpoint.json"

# Validate required environment variables
if not OPENAI_API_KEY:
    raise ValueError(
        "OPENAI_API_KEY environment variable is required. Please set it in .env file"
    )
if not CMS_DATABASE_URL:
    raise ValueError(
        "CMS_DATABASE_URL environment variable is required. Please set it in .env file"
    )
if not DATABASE_URL:
    raise ValueError(
        "DATABASE_URL environment variable is required. Please set it in .env file"
    )

# Initialize OpenAI client
client = OpenAI(api_key=OPENAI_API_KEY)

# Create database engines with connection pooling (reuse connections)
# This prevents "max clients reached" errors
_cms_engine = None
_target_engine = None


def get_cms_engine():
    """Get or create CMS database engine with connection pooling"""
    global _cms_engine
    if _cms_engine is None:
        _cms_engine = create_engine(
            CMS_DATABASE_URL,
            pool_size=2,  # Small pool for read-only operations
            max_overflow=0,
            pool_pre_ping=True,  # Verify connections before using
            pool_recycle=3600,  # Recycle connections after 1 hour
        )
    return _cms_engine


def get_target_engine():
    """Get or create target database engine with connection pooling"""
    global _target_engine
    if _target_engine is None:
        _target_engine = create_engine(
            DATABASE_URL,
            pool_size=5,  # Small pool to avoid max clients
            max_overflow=0,  # No overflow to stay within limits
            pool_pre_ping=True,  # Verify connections before using
            pool_recycle=3600,  # Recycle connections after 1 hour
        )
    return _target_engine


def fetch_existing_metadata() -> pd.DataFrame:
    """Fetch company metadata from Payload CMS with investor links"""
    engine = get_cms_engine()

    # Fetch base metadata
    query = """
    SELECT
        m.id,
        m.stock_code,
        m.company_name,
        m.industry,
        m.market_cap,
        m.listing_date,
        m.address,
        m.summary,
        m.details,
        m.website,
        m.company_logo_link
    FROM metadata m
    WHERE m.stock_code IS NOT NULL
    ORDER BY m.company_name
    """
    df = pd.read_sql(query, engine)

    # Fetch investor links
    links_query = """
    SELECT
        ml._parent_id,
        ml.link,
        ml._order
    FROM metadata_links ml
    ORDER BY ml._parent_id, ml._order
    """
    df_links = pd.read_sql(links_query, engine)
    # Don't dispose - we're reusing the engine

    # Merge links
    if not df_links.empty:
        df_links_agg = df_links.groupby("_parent_id")["link"].apply(list).reset_index()
        df_links_agg.columns = ["id", "investor_links"]
        df = df.merge(df_links_agg, on="id", how="left")
    else:
        df["investor_links"] = None

    df["investor_links"] = df["investor_links"].apply(
        lambda x: x if isinstance(x, list) else []
    )

    # Add GCS logo URL
    df["logo_gcs_url"] = df["stock_code"].apply(
        lambda code: f"{GCS_LOGO_BASE_URL}/{code.upper()}.svg"
    )

    companies_with_links = (df["investor_links"].str.len() > 0).sum()
    print(f"✓ Fetched {len(df)} companies from Payload CMS")
    print(
        f"✓ {companies_with_links} companies have investor links (avg {df['investor_links'].str.len().mean():.1f} links each)"
    )

    return df


def crawl_for_reports(
    start_url: str, max_depth: int = 2, max_pages: int = 20
) -> List[Dict[str, str]]:
    """
    Smart crawler to find financial report PDFs on investor pages.

    Features:
    - Priority-based link following (investor-relations keywords)
    - PDF detection from links and embedded in pages
    - Year extraction from URLs and text
    - Deduplication by URL normalization
    """
    visited = set()
    to_visit = [(start_url, 0)]  # (url, depth)
    reports = []
    pages_crawled = 0

    # Priority keywords for links to follow
    high_priority_keywords = [
        "annual",
        "report",
        "investor",
        "financial",
        "presentation",
        "result",
    ]
    medium_priority_keywords = [
        "download",
        "documents",
        "corporate",
        "governance",
        "announcements",
    ]
    avoid_keywords = [
        "facebook",
        "twitter",
        "linkedin",
        "youtube",
        "instagram",
        "news",
        "media",
    ]

    def normalize_url(url: str) -> str:
        """Normalize URL for deduplication"""
        url = url.split("#")[0].split("?")[0]  # Remove fragments and query params
        url = url.rstrip("/")
        return url.lower()

    def extract_year(text: str) -> Optional[str]:
        """Extract year from text (2020-2025)"""
        match = re.search(r"20(2[0-5]|1[0-9])", text)
        return match.group(0) if match else None

    def is_pdf_link(href: str, link_text: str) -> bool:
        """Check if link is a PDF"""
        href_lower = href.lower()
        text_lower = link_text.lower()
        return (
            href_lower.endswith(".pdf")
            or ".pdf?" in href_lower
            or "download" in text_lower
            and "pdf" in text_lower
            or "report" in text_lower
            and href_lower.endswith((".pdf", ".PDF"))
        )

    def get_link_priority(href: str, text: str) -> int:
        """Calculate link priority (higher = more likely to contain reports)"""
        text_lower = text.lower()
        href_lower = href.lower()
        combined = text_lower + " " + href_lower

        if any(kw in combined for kw in avoid_keywords):
            return 0

        score = 0
        for kw in high_priority_keywords:
            if kw in combined:
                score += 10
        for kw in medium_priority_keywords:
            if kw in combined:
                score += 5

        return score

    client = httpx.Client(timeout=30.0, follow_redirects=True)

    try:
        while to_visit and pages_crawled < max_pages:
            url, depth = to_visit.pop(0)

            normalized = normalize_url(url)
            if normalized in visited:
                continue

            visited.add(normalized)
            pages_crawled += 1

            try:
                response = client.get(
                    url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
                    },
                )

                if response.status_code != 200:
                    continue

                soup = BeautifulSoup(response.content, "html.parser")

                # Find all links
                for link in soup.find_all("a", href=True):
                    href = urljoin(url, link["href"])
                    link_text = link.get_text(strip=True)

                    # Check if it's a PDF
                    if is_pdf_link(href, link_text):
                        year = extract_year(href + " " + link_text)
                        report_type = (
                            "annual_report"
                            if "annual" in link_text.lower()
                            else "financial_report"
                        )

                        reports.append(
                            {
                                "url": href,
                                "title": link_text or "Financial Report",
                                "type": report_type,
                                "date": f"{year}-12-31" if year else None,
                                "source": "smart_crawler",
                                "depth": depth,
                            }
                        )

                    # Follow relevant links
                    elif depth < max_depth:
                        priority = get_link_priority(href, link_text)
                        if priority > 0:
                            to_visit.append((href, depth + 1))

                time.sleep(0.5)  # Be nice to servers

            except Exception as e:
                continue

    finally:
        client.close()

    # Deduplicate by normalized URL
    seen_urls = set()
    unique_reports = []
    for report in reports:
        normalized = normalize_url(report["url"])
        if normalized not in seen_urls:
            seen_urls.add(normalized)
            unique_reports.append(report)

    # Sort by year (newest first)
    unique_reports.sort(key=lambda x: x.get("date", ""), reverse=True)

    return unique_reports[:10]  # Limit to 10 most recent


def fetch_annual_reports(company: pd.Series) -> List[Dict[str, str]]:
    """Fetch annual reports from multiple sources"""
    stock_code = company["stock_code"]
    reports = []
    seen_urls = set()

    def add_report(report_dict):
        url = report_dict.get("url", "")
        if url and url not in seen_urls:
            seen_urls.add(url)
            reports.append(report_dict)
            return True
        return False

    # Use PayloadCMS investor links with SMART CRAWLER
    investor_links = company.get("investor_links", [])
    if isinstance(investor_links, list) and investor_links:
        for link in investor_links[:3]:  # Try first 3 links
            try:
                if not link or any(
                    x in link.lower()
                    for x in ["facebook", "twitter", "linkedin", "youtube"]
                ):
                    continue

                crawled_reports = crawl_for_reports(link, max_depth=2, max_pages=15)
                for report in crawled_reports:
                    add_report(report)

                if len(reports) >= 10:
                    break
            except Exception:
                pass

    return reports[:10]


def fetch_yahoo_finance_data(stock_code: str) -> Dict[str, Any]:
    """Fetch comprehensive financial data from Yahoo Finance"""
    yahoo_symbol = f"{stock_code}.AX"

    result = {
        "stock_code": stock_code,
        "success": False,
        "annual": {},
        "quarterly": {},
        "info": {},
        "error": None,
    }

    try:
        ticker = yf.Ticker(yahoo_symbol)

        # Income Statement (Annual)
        income_stmt = ticker.financials
        if not income_stmt.empty:
            income_dict = {}
            for col in income_stmt.columns:
                date_str = (
                    col.strftime("%Y-%m-%d") if hasattr(col, "strftime") else str(col)
                )
                income_dict[date_str] = {
                    k: float(v) if pd.notna(v) else None
                    for k, v in income_stmt[col].items()
                }
            result["annual"]["income_statement"] = income_dict

        # Balance Sheet (Annual)
        balance_sheet = ticker.balance_sheet
        if not balance_sheet.empty:
            balance_dict = {}
            for col in balance_sheet.columns:
                date_str = (
                    col.strftime("%Y-%m-%d") if hasattr(col, "strftime") else str(col)
                )
                balance_dict[date_str] = {
                    k: float(v) if pd.notna(v) else None
                    for k, v in balance_sheet[col].items()
                }
            result["annual"]["balance_sheet"] = balance_dict

        # Cash Flow (Annual)
        cashflow = ticker.cashflow
        if not cashflow.empty:
            cashflow_dict = {}
            for col in cashflow.columns:
                date_str = (
                    col.strftime("%Y-%m-%d") if hasattr(col, "strftime") else str(col)
                )
                cashflow_dict[date_str] = {
                    k: float(v) if pd.notna(v) else None
                    for k, v in cashflow[col].items()
                }
            result["annual"]["cash_flow"] = cashflow_dict

        # Company info
        info = ticker.info
        result["info"] = {
            "market_cap": info.get("marketCap"),
            "current_price": info.get("currentPrice"),
            "pe_ratio": info.get("trailingPE"),
            "eps": info.get("trailingEps"),
            "dividend_yield": (
                info.get("dividendYield", 0) * 100
                if info.get("dividendYield")
                else None
            ),
            "beta": info.get("beta"),
            "week_52_high": info.get("fiftyTwoWeekHigh"),
            "week_52_low": info.get("fiftyTwoWeekLow"),
            "volume": info.get("volume"),
            "employee_count": info.get("fullTimeEmployees"),
            "sector": info.get("sector"),
            "industry": info.get("industry"),
        }

        # Mark success if we got at least one statement
        result["success"] = bool(result["annual"])

    except Exception as e:
        result["error"] = str(e)

    return result


def enrich_with_gpt(company: pd.Series, reports: List[Dict]) -> Dict[str, Any]:
    """Use GPT-5.1 to enrich company metadata with optimized prompting"""

    # System prompt optimized for GPT-5.1 reasoning model
    system_prompt = """You are a financial analyst specializing in Australian Stock Exchange (ASX) companies. Your task is to research and compile comprehensive, accurate company intelligence.

<core_behavior>
- PERSISTENCE: You must be thorough and complete. Do not sacrifice completeness for brevity.
- ACCURACY: Use web search capabilities to verify all facts. Cite sources when available.
- STRUCTURED OUTPUT: Return ONLY valid JSON matching the exact schema provided.
- DEPTH: Provide meaningful detail for every field. Avoid placeholders like "N/A" unless information truly doesn't exist after research.
</core_behavior>

<output_requirements>
1. Tags: Must provide exactly 5 relevant, specific tags (lowercase). Examples: "lithium mining", "fintech", "saas", "renewable energy", "healthcare technology"
2. Enhanced summary: 2-4 sentences covering business model, market position, and unique value proposition
3. Company history: 3-5 sentences on founding, evolution, and major milestones (IPO date, acquisitions, pivots)
4. Key people: Minimum 2 executives (CEO, CFO, or equivalent). Include name, role, and 1-2 sentence bio
5. Competitive advantages: 2-3 specific points (proprietary technology, market share, regulatory moats, partnerships)
6. Risk factors: 3-5 realistic business risks specific to this company and sector
7. Recent developments: Last 6 months only - product launches, earnings results, strategic announcements
8. Social media: LinkedIn and Twitter/X URLs if publicly available
</output_requirements>

<quality_standards>
- DO research each company thoroughly using web search
- DO provide specific, factual information
- DO include numerical details where relevant (market cap, employee count, founding year)
- DO NOT use generic or template language
- DO NOT skip fields because information "seems" unavailable - search for it
- DO NOT hallucinate - if truly unavailable after research, use null or empty array
</quality_standards>"""

    # User prompt with company context
    user_prompt = f"""Research and enrich metadata for this ASX company:

<company_context>
Company Name: {company['company_name']}
Stock Code: {company['stock_code']}
Industry: {company.get('industry', 'Unknown')}
Website: {company.get('website', 'N/A')}
Current Summary: {company.get('summary', 'No summary available')}
Investor Relations: {len(company.get('investor_links', []))} link(s) available
</company_context>

<annual_reports_found>
{len(reports)} financial report(s) discovered
</annual_reports_found>

Return a JSON object with this EXACT structure (valid JSON only, no markdown):

{{
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "enhanced_summary": "2-4 sentence summary covering business model, market position, unique value",
  "company_history": "3-5 sentences on founding, evolution, major milestones",
  "key_people": [
    {{"name": "Full Name", "role": "CEO", "bio": "1-2 sentence bio"}},
    {{"name": "Full Name", "role": "CFO", "bio": "1-2 sentence bio"}}
  ],
  "competitive_advantages": "2-3 specific competitive advantages with detail",
  "risk_factors": ["Specific risk 1", "Specific risk 2", "Specific risk 3"],
  "recent_developments": "Recent news and developments from last 6 months",
  "social_media_links": {{
    "linkedin": "https://linkedin.com/company/...",
    "twitter": "https://twitter.com/..."
  }}
}}

CRITICAL: 
- Research this company thoroughly using web search before responding
- Provide complete information for ALL fields
- Use null only if information truly doesn't exist after research
- Return ONLY the JSON object, no additional text"""

    try:
        response = client.chat.completions.create(
            model="gpt-5.1",  # GPT-5.1 with enhanced reasoning capabilities
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )

        content = response.choices[0].message.content.strip()

        # Remove markdown code blocks if present
        if content.startswith("```"):
            content = "\n".join(content.split("\n")[1:-1])
        if content.startswith("json"):
            content = content[4:].strip()

        enriched_data = json.loads(content)
        return enriched_data

    except Exception as e:
        print(f"    ⚠ GPT enrichment failed: {e}")
        return {
            "tags": [],
            "enhanced_summary": None,
            "company_history": None,
            "key_people": [],
            "competitive_advantages": None,
            "risk_factors": [],
            "recent_developments": None,
            "social_media_links": {},
        }


def save_reports_to_database(stock_code: str, reports: List[Dict]) -> int:
    """Save discovered reports to financial_report_files table"""
    if not reports:
        return 0

    engine = get_target_engine()
    saved_count = 0

    with engine.connect() as conn:
        for report in reports:
            # Check if already exists
            check_query = text(
                """
                SELECT id FROM financial_report_files 
                WHERE stock_code = :stock_code AND source_url = :source_url
            """
            )

            existing = conn.execute(
                check_query, {"stock_code": stock_code, "source_url": report["url"]}
            ).fetchone()

            if not existing:
                # Insert new report
                insert_query = text(
                    """
                    INSERT INTO financial_report_files (
                        stock_code, report_type, report_date, report_title,
                        source_url, source_domain, crawler_source, sync_status
                    ) VALUES (
                        :stock_code, :report_type, :report_date, :report_title,
                        :source_url, :source_domain, :crawler_source, 'pending'
                    )
                """
                )

                domain = urlparse(report["url"]).netloc

                conn.execute(
                    insert_query,
                    {
                        "stock_code": stock_code,
                        "report_type": report.get("type", "annual_report"),
                        "report_date": report.get("date"),
                        "report_title": report.get("title"),
                        "source_url": report["url"],
                        "source_domain": domain,
                        "crawler_source": report.get("source", "smart_crawler"),
                    },
                )

                conn.commit()
                saved_count += 1

    # Don't dispose - we're reusing the engine
    return saved_count


def process_company(company: pd.Series) -> Dict[str, Any]:
    """Process a single company: crawl, enrich with GPT, fetch Yahoo Finance data"""
    stock_code = company["stock_code"]

    print(f"\n🔍 Processing {stock_code} - {company['company_name']}")

    result = {
        "stock_code": stock_code,
        "enrichment_status": "failed",
        "enrichment_error": None,
        "enrichment_date": datetime.now().isoformat(),
    }

    try:
        # Step 1: Fetch annual reports
        print(f"  📄 Crawling for financial reports...")
        reports = fetch_annual_reports(company)
        print(f"    ✅ Found {len(reports)} reports")

        # Save reports to database
        if reports:
            saved = save_reports_to_database(stock_code, reports)
            print(f"    💾 Saved {saved} new reports to database")

        # Step 2: Enrich with GPT
        print(f"  🤖 Enriching with GPT-5.1...")
        enriched_data = enrich_with_gpt(company, reports)
        result.update(enriched_data)

        # Step 3: Fetch Yahoo Finance data
        print(f"  📊 Fetching Yahoo Finance data...")
        yahoo_data = fetch_yahoo_finance_data(stock_code)

        if yahoo_data["success"]:
            print(f"    ✅ Got {len(yahoo_data['annual'])} financial statements")
            result["financial_statements"] = yahoo_data
        else:
            print(f"    ⚠ No Yahoo Finance data available")
            result["financial_statements"] = None

        # Add metadata
        result["financial_reports"] = reports
        result["logo_gcs_url"] = company["logo_gcs_url"]
        result["enrichment_status"] = "completed"

        print(f"  ✅ Completed successfully")

    except Exception as e:
        result["enrichment_status"] = "failed"
        result["enrichment_error"] = str(e)
        print(f"  ❌ Error: {e}")

    return result


def update_database(result: Dict[str, Any]):
    """Update company-metadata table with enrichment results"""
    engine = get_target_engine()

    # Prepare update data
    update_data = {
        "stock_code": result["stock_code"],
        "tags": result.get("tags", []),
        "enhanced_summary": result.get("enhanced_summary"),
        "company_history": result.get("company_history"),
        "key_people": json.dumps(result.get("key_people", [])),
        "financial_reports": json.dumps(result.get("financial_reports", [])),
        "competitive_advantages": result.get("competitive_advantages"),
        "risk_factors": (
            json.dumps(result.get("risk_factors", []))
            if isinstance(result.get("risk_factors"), list)
            else result.get("risk_factors")
        ),
        "recent_developments": result.get("recent_developments"),
        "social_media_links": json.dumps(result.get("social_media_links", {})),
        "logo_gcs_url": result.get("logo_gcs_url"),
        "enrichment_status": result.get("enrichment_status"),
        "enrichment_date": result.get("enrichment_date"),
        "enrichment_error": result.get("enrichment_error"),
        "financial_statements": (
            json.dumps(result.get("financial_statements"))
            if result.get("financial_statements")
            else None
        ),
    }

    query = text(
        """
        UPDATE "company-metadata"
        SET
            tags = :tags,
            enhanced_summary = :enhanced_summary,
            company_history = :company_history,
            key_people = cast(:key_people AS jsonb),
            financial_reports = cast(:financial_reports AS jsonb),
            competitive_advantages = :competitive_advantages,
            risk_factors = :risk_factors,
            recent_developments = :recent_developments,
            social_media_links = cast(:social_media_links AS jsonb),
            logo_gcs_url = :logo_gcs_url,
            enrichment_status = :enrichment_status,
            enrichment_date = cast(:enrichment_date AS timestamp),
            enrichment_error = :enrichment_error,
            financial_statements = cast(:financial_statements AS jsonb)
        WHERE stock_code = :stock_code
    """
    )

    with engine.connect() as conn:
        conn.execute(query, update_data)
        conn.commit()

    # Don't dispose - we're reusing the engine


def load_checkpoint() -> set:
    """Load processed stock codes from checkpoint"""
    if os.path.exists(CHECKPOINT_FILE):
        with open(CHECKPOINT_FILE, "r") as f:
            data = json.load(f)
            return set(data.get("processed", []))
    return set()


def save_checkpoint(processed: set):
    """Save checkpoint"""
    with open(CHECKPOINT_FILE, "w") as f:
        json.dump(
            {"processed": list(processed), "last_updated": datetime.now().isoformat()},
            f,
            indent=2,
        )


def enrich_database(
    limit: Optional[int] = None,
    stock_codes: Optional[List[str]] = None,
    resume: bool = False,
):
    """Main enrichment pipeline"""

    print("\n" + "=" * 80)
    print("🚀 COMPANY METADATA ENRICHMENT PIPELINE")
    print("=" * 80)

    # Fetch companies
    print("\n📥 Fetching companies from Payload CMS...")
    df = fetch_existing_metadata()

    # Filter by stock codes if provided
    if stock_codes:
        df = df[df["stock_code"].isin(stock_codes)]
        print(f"📋 Processing {len(df)} specified companies")
    elif limit:
        df = df.head(limit)
        print(f"📋 Processing {len(df)} companies (limit={limit})")
    else:
        print(f"📋 Processing ALL {len(df)} companies")

    # Resume from checkpoint
    processed = load_checkpoint() if resume else set()
    if processed:
        df = df[~df["stock_code"].isin(processed)]
        print(f"🔄 Resuming: {len(processed)} already processed, {len(df)} remaining")

    # Process companies
    stats = {"total": len(df), "success": 0, "failed": 0}

    for _, company in tqdm(df.iterrows(), total=len(df), desc="Enriching"):
        result = process_company(company)
        update_database(result)

        if result["enrichment_status"] == "completed":
            stats["success"] += 1
        else:
            stats["failed"] += 1

        # Update checkpoint
        processed.add(company["stock_code"])
        if len(processed) % 10 == 0:
            save_checkpoint(processed)

        # Rate limiting
        time.sleep(2)  # Be nice to OpenAI API

    # Final checkpoint
    save_checkpoint(processed)

    # Summary
    print("\n" + "=" * 80)
    print("📊 ENRICHMENT SUMMARY")
    print("=" * 80)
    print(f"  Total:      {stats['total']}")
    print(f"  ✅ Success:  {stats['success']}")
    print(f"  ❌ Failed:   {stats['failed']}")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Enrich company metadata")
    parser.add_argument(
        "--limit", type=int, help="Limit number of companies to process"
    )
    parser.add_argument("--stocks", nargs="+", help="Process specific stock codes")
    parser.add_argument("--all", action="store_true", help="Process all companies")
    parser.add_argument("--resume", action="store_true", help="Resume from checkpoint")

    args = parser.parse_args()

    if args.all:
        enrich_database(resume=args.resume)
    else:
        enrich_database(limit=args.limit, stock_codes=args.stocks, resume=args.resume)
