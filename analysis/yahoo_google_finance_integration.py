#!/usr/bin/env python3
"""
Yahoo Finance & Google Finance Integration

Syncs financial data and metrics into company profiles:
- Market data (price, volume, market cap)
- Financial statements (revenue, profit, EPS)
- Key ratios (P/E, dividend yield, ROE)
- Company description and metadata
- Historical performance

This supplements the GPT-enriched profiles with quantitative data.
"""

import os
import re
import json
import time
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta

import httpx
from bs4 import BeautifulSoup
import pandas as pd
from dotenv import load_dotenv

load_dotenv()


# ============================================================================
# YAHOO FINANCE - Comprehensive Financial Data
# ============================================================================


def fetch_yahoo_finance_comprehensive(stock_code: str) -> Dict[str, Any]:
    """
    Fetch comprehensive financial data from Yahoo Finance.

    Data includes:
    - Market data (price, market cap, volume)
    - Key statistics (P/E ratio, EPS, dividend yield)
    - Financial statements preview
    - Company profile
    """

    yahoo_symbol = f"{stock_code}.AX"
    data = {
        "stock_code": stock_code,
        "yahoo_symbol": yahoo_symbol,
        "market_data": {},
        "key_statistics": {},
        "financials": {},
        "profile": {},
        "last_updated": datetime.now().isoformat(),
    }

    try:
        # 1. Main quote page - Market data
        print(f"  📊 Fetching Yahoo Finance data for {stock_code}...")

        quote_url = f"https://finance.yahoo.com/quote/{yahoo_symbol}"
        response = httpx.get(
            quote_url,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            },
            timeout=15.0,
            follow_redirects=True,
        )

        if response.status_code == 200:
            soup = BeautifulSoup(response.content, "html.parser")

            # Extract market data from quote page
            # Yahoo Finance embeds data in <fin-streamer> tags
            price_elem = soup.find("fin-streamer", {"data-field": "regularMarketPrice"})
            if price_elem:
                data["market_data"]["current_price"] = float(price_elem.get("value", 0))

            change_elem = soup.find(
                "fin-streamer", {"data-field": "regularMarketChange"}
            )
            if change_elem:
                data["market_data"]["change"] = float(change_elem.get("value", 0))

            change_pct_elem = soup.find(
                "fin-streamer", {"data-field": "regularMarketChangePercent"}
            )
            if change_pct_elem:
                change_pct_str = change_pct_elem.get("value", "0")
                # Remove % and convert
                data["market_data"]["change_percent"] = float(
                    change_pct_str.replace("%", "")
                )

            # Market cap
            market_cap_elem = soup.find("fin-streamer", {"data-field": "marketCap"})
            if market_cap_elem:
                market_cap_str = market_cap_elem.get("value", "0")
                data["market_data"]["market_cap"] = int(float(market_cap_str))

            # Volume
            volume_elem = soup.find(
                "fin-streamer", {"data-field": "regularMarketVolume"}
            )
            if volume_elem:
                data["market_data"]["volume"] = int(float(volume_elem.get("value", 0)))

            # Extract company profile from about section
            profile_section = soup.find("section", {"data-test": "qsp-profile"})
            if profile_section:
                description = profile_section.find("p")
                if description:
                    data["profile"]["description"] = description.get_text().strip()

                # Employee count
                employees_elem = profile_section.find(
                    string=re.compile(r"Full Time Employees", re.I)
                )
                if employees_elem and employees_elem.parent:
                    employees_text = employees_elem.parent.get_text()
                    employees_match = re.search(r"([\d,]+)", employees_text)
                    if employees_match:
                        data["profile"]["employees"] = int(
                            employees_match.group(1).replace(",", "")
                        )

                # Sector and industry
                sector_elem = profile_section.find(string=re.compile(r"Sector", re.I))
                if sector_elem and sector_elem.parent and sector_elem.parent.parent:
                    sector_text = sector_elem.parent.parent.get_text()
                    parts = sector_text.split("Sector")
                    if len(parts) > 1:
                        data["profile"]["sector"] = (
                            parts[1].split("Industry")[0].strip()
                        )

                industry_elem = profile_section.find(
                    string=re.compile(r"Industry", re.I)
                )
                if (
                    industry_elem
                    and industry_elem.parent
                    and industry_elem.parent.parent
                ):
                    industry_text = industry_elem.parent.parent.get_text()
                    parts = industry_text.split("Industry")
                    if len(parts) > 1:
                        data["profile"]["industry"] = parts[1].strip()

        # 2. Statistics page - Key ratios
        stats_url = f"https://finance.yahoo.com/quote/{yahoo_symbol}/key-statistics"
        response = httpx.get(
            stats_url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15.0
        )

        if response.status_code == 200:
            soup = BeautifulSoup(response.content, "html.parser")

            # Yahoo displays stats in tables
            tables = soup.find_all("table")
            for table in tables:
                rows = table.find_all("tr")
                for row in rows:
                    cells = row.find_all("td")
                    if len(cells) >= 2:
                        label = cells[0].get_text().strip().lower()
                        value_text = cells[1].get_text().strip()

                        # Parse key statistics
                        if "trailing p/e" in label:
                            try:
                                data["key_statistics"]["pe_ratio"] = float(value_text)
                            except:
                                pass
                        elif "forward p/e" in label:
                            try:
                                data["key_statistics"]["forward_pe"] = float(value_text)
                            except:
                                pass
                        elif "eps" in label and "trailing" in label:
                            try:
                                data["key_statistics"]["eps"] = float(value_text)
                            except:
                                pass
                        elif "dividend yield" in label:
                            try:
                                # Remove % and convert
                                data["key_statistics"]["dividend_yield"] = float(
                                    value_text.replace("%", "")
                                )
                            except:
                                pass
                        elif "beta" in label:
                            try:
                                data["key_statistics"]["beta"] = float(value_text)
                            except:
                                pass
                        elif "52 week high" in label:
                            try:
                                data["key_statistics"]["week_52_high"] = float(
                                    value_text
                                )
                            except:
                                pass
                        elif "52 week low" in label:
                            try:
                                data["key_statistics"]["week_52_low"] = float(
                                    value_text
                                )
                            except:
                                pass

        # 3. Financials page - Revenue, profit summary
        financials_url = f"https://finance.yahoo.com/quote/{yahoo_symbol}/financials"
        response = httpx.get(
            financials_url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15.0
        )

        if response.status_code == 200:
            soup = BeautifulSoup(response.content, "html.parser")

            # Find revenue and net income from financial tables
            tables = soup.find_all("table")
            for table in tables:
                rows = table.find_all("tr")
                for row in rows:
                    cells = row.find_all("td")
                    if cells:
                        label = cells[0].get_text().strip().lower()

                        if "total revenue" in label and len(cells) > 1:
                            # Get most recent value
                            value_text = cells[1].get_text().strip()
                            try:
                                # Convert thousands (e.g., "1,234" → 1234)
                                data["financials"]["revenue"] = int(
                                    value_text.replace(",", "")
                                )
                            except:
                                pass

                        elif "net income" in label and len(cells) > 1:
                            value_text = cells[1].get_text().strip()
                            try:
                                data["financials"]["net_income"] = int(
                                    value_text.replace(",", "")
                                )
                            except:
                                pass

        print(f"  ✅ Yahoo Finance: Found {len(data['market_data'])} market metrics")

    except Exception as e:
        print(f"  ⚠️  Yahoo Finance error for {stock_code}: {e}")

    return data


# ============================================================================
# GOOGLE FINANCE - Market Data and Description
# ============================================================================


def fetch_google_finance_comprehensive(stock_code: str) -> Dict[str, Any]:
    """
    Fetch data from Google Finance.

    Data includes:
    - Current price and change
    - Company description
    - Key stats overview
    """

    data = {
        "stock_code": stock_code,
        "google_symbol": f"ASX:{stock_code}",
        "market_data": {},
        "profile": {},
        "last_updated": datetime.now().isoformat(),
    }

    try:
        print(f"  📈 Fetching Google Finance data for {stock_code}...")

        url = f"https://www.google.com/finance/quote/{stock_code}:ASX"
        response = httpx.get(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            },
            timeout=15.0,
            follow_redirects=True,
        )

        if response.status_code == 200:
            soup = BeautifulSoup(response.content, "html.parser")

            # Extract price (Google Finance uses specific div classes)
            price_div = soup.find("div", {"class": re.compile(r"YMlKec", re.I)})
            if price_div:
                price_text = price_div.get_text().strip()
                # Remove currency symbol and convert
                price_clean = re.sub(r"[^\d.]", "", price_text)
                try:
                    data["market_data"]["current_price"] = float(price_clean)
                except:
                    pass

            # Extract price change
            change_div = soup.find("div", {"class": re.compile(r"JwB6zf", re.I)})
            if change_div:
                change_text = change_div.get_text().strip()
                # Parse change and percent
                parts = change_text.split("(")
                if len(parts) == 2:
                    try:
                        change = float(
                            parts[0].strip().replace("+", "").replace("$", "")
                        )
                        data["market_data"]["change"] = change

                        percent_str = parts[1].replace(")", "").replace("%", "").strip()
                        data["market_data"]["change_percent"] = float(percent_str)
                    except:
                        pass

            # Extract company description
            about_section = soup.find("div", {"class": re.compile(r"bLLb2d", re.I)})
            if about_section:
                description = about_section.get_text().strip()
                data["profile"]["description"] = description

            # Extract key stats (CEO, founded, HQ, etc.)
            stat_divs = soup.find_all("div", {"class": re.compile(r"P6K39c", re.I)})
            for stat_div in stat_divs:
                label_elem = stat_div.find(
                    "div", {"class": re.compile(r"mfs7Fc", re.I)}
                )
                value_elem = stat_div.find("div", {"class": re.compile(r"QXDnM", re.I)})

                if label_elem and value_elem:
                    label = label_elem.get_text().strip().lower()
                    value = value_elem.get_text().strip()

                    if "ceo" in label:
                        data["profile"]["ceo"] = value
                    elif "founded" in label or "established" in label:
                        data["profile"]["founded"] = value
                    elif "headquarters" in label or "hq" in label:
                        data["profile"]["headquarters"] = value
                    elif "employees" in label:
                        try:
                            # Remove commas and convert
                            data["profile"]["employees"] = int(value.replace(",", ""))
                        except:
                            pass

            print(
                f"  ✅ Google Finance: Found {len(data['market_data'])} market metrics"
            )

    except Exception as e:
        print(f"  ⚠️  Google Finance error for {stock_code}: {e}")

    return data


# ============================================================================
# MERGE AND SYNC TO DATABASE
# ============================================================================


def merge_financial_data(
    yahoo_data: Dict[str, Any],
    google_data: Dict[str, Any],
    existing_company_data: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Intelligently merge financial data from multiple sources.

    Priority:
    1. Yahoo Finance (most comprehensive)
    2. Google Finance (backup/supplement)
    3. Existing data (preserve if no updates)
    """

    merged = existing_company_data.copy()

    # Merge market data (prefer Yahoo, fallback to Google)
    if yahoo_data.get("market_data"):
        merged["market_data"] = yahoo_data["market_data"]
    elif google_data.get("market_data"):
        merged["market_data"] = google_data["market_data"]

    # Merge key statistics (Yahoo only)
    if yahoo_data.get("key_statistics"):
        merged["key_statistics"] = yahoo_data["key_statistics"]

    # Merge financials (Yahoo only for now)
    if yahoo_data.get("financials"):
        merged["financials"] = yahoo_data["financials"]

    # Merge profile data (prefer Yahoo, supplement with Google)
    merged["profile"] = {}

    # Description - prefer Yahoo (more detailed), fallback to Google
    if yahoo_data.get("profile", {}).get("description"):
        merged["profile"]["description"] = yahoo_data["profile"]["description"]
    elif google_data.get("profile", {}).get("description"):
        merged["profile"]["description"] = google_data["profile"]["description"]
    elif existing_company_data.get("description"):
        merged["profile"]["description"] = existing_company_data["description"]

    # Sector/Industry - Yahoo is more standardized
    if yahoo_data.get("profile", {}).get("sector"):
        merged["profile"]["sector"] = yahoo_data["profile"]["sector"]
    if yahoo_data.get("profile", {}).get("industry"):
        merged["profile"]["industry"] = yahoo_data["profile"]["industry"]

    # Employees - use whichever source has it
    if yahoo_data.get("profile", {}).get("employees"):
        merged["profile"]["employees"] = yahoo_data["profile"]["employees"]
    elif google_data.get("profile", {}).get("employees"):
        merged["profile"]["employees"] = google_data["profile"]["employees"]

    # CEO - Google Finance sometimes has this
    if google_data.get("profile", {}).get("ceo"):
        merged["profile"]["ceo"] = google_data["profile"]["ceo"]

    # Founded/HQ - Google Finance
    if google_data.get("profile", {}).get("founded"):
        merged["profile"]["founded"] = google_data["profile"]["founded"]
    if google_data.get("profile", {}).get("headquarters"):
        merged["profile"]["headquarters"] = google_data["profile"]["headquarters"]

    # Add metadata
    merged["financial_data_sources"] = []
    if yahoo_data.get("market_data") or yahoo_data.get("key_statistics"):
        merged["financial_data_sources"].append("yahoo_finance")
    if google_data.get("market_data") or google_data.get("profile"):
        merged["financial_data_sources"].append("google_finance")

    merged["financial_data_last_updated"] = datetime.now().isoformat()

    return merged


# ============================================================================
# TEST/DEMO
# ============================================================================

if __name__ == "__main__":
    # Test on a few companies
    test_stocks = ["BHP", "CBA", "WBC", "5GN"]

    results = []

    for stock_code in test_stocks:
        print(f"\n{'=' * 80}")
        print(f"Fetching financial data: {stock_code}")
        print(f"{'=' * 80}")

        # Fetch from both sources
        yahoo_data = fetch_yahoo_finance_comprehensive(stock_code)
        time.sleep(1)  # Be nice to servers

        google_data = fetch_google_finance_comprehensive(stock_code)
        time.sleep(1)

        # Merge
        merged = merge_financial_data(yahoo_data, google_data, {})

        # Display results
        print(f"\n📊 Merged Financial Data for {stock_code}:")
        print(f"\n  Market Data:")
        for key, value in merged.get("market_data", {}).items():
            print(f"    {key:20s}: {value}")

        print(f"\n  Key Statistics:")
        for key, value in merged.get("key_statistics", {}).items():
            print(f"    {key:20s}: {value}")

        print(f"\n  Profile:")
        profile = merged.get("profile", {})
        if profile.get("description"):
            print(f"    Description: {profile['description'][:100]}...")
        if profile.get("sector"):
            print(f"    Sector: {profile['sector']}")
        if profile.get("industry"):
            print(f"    Industry: {profile['industry']}")
        if profile.get("employees"):
            print(f"    Employees: {profile['employees']:,}")
        if profile.get("ceo"):
            print(f"    CEO: {profile['ceo']}")

        print(
            f"\n  Data Sources: {', '.join(merged.get('financial_data_sources', []))}"
        )

        results.append(merged)

    # Save to JSON for inspection
    output_file = "financial_data_samples.json"
    with open(output_file, "w") as f:
        json.dump(results, f, indent=2)

    print(f"\n\n✅ Saved {len(results)} company profiles to {output_file}")
