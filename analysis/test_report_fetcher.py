#!/usr/bin/env python3
"""
Integration test for annual report fetcher.
Tests the ASX announcements API and web scraping functionality.
"""

import httpx
import pandas as pd
from bs4 import BeautifulSoup
from urllib.parse import urljoin
from typing import Dict, List

print("🧪 Annual Report Fetcher Integration Test")
print("=" * 60)

# Test 1: ASX Announcements API
print("\n1️⃣  Testing ASX Announcements API...")
test_stocks = ['PLS', 'BHP', 'MML', '14D']

for stock_code in test_stocks:
    print(f"\n   Testing {stock_code}:")
    try:
        asx_url = f"https://cdn-api.markitdigital.com/apiman-gateway/ASX/asx-research/1.0/companies/{stock_code}/announcements"
        response = httpx.get(
            asx_url,
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10.0,
            follow_redirects=True
        )
        
        if response.status_code == 200:
            data = response.json()
            print(f"      ✅ API Response: {response.status_code}")
            print(f"      Data type: {type(data)}")
            
            # Check structure
            if isinstance(data, dict):
                if 'data' in data:
                    announcements = data.get('data', [])
                    print(f"      Announcements: {len(announcements) if isinstance(announcements, list) else 'Not a list'}")
                    
                    # Check first announcement structure
                    if isinstance(announcements, list) and len(announcements) > 0:
                        first = announcements[0]
                        print(f"      First announcement type: {type(first)}")
                        print(f"      Keys: {list(first.keys()) if isinstance(first, dict) else 'Not a dict'}")
                        
                        # Try to iterate safely
                        reports_found = 0
                        for announcement in announcements[:20]:
                            if not isinstance(announcement, dict):
                                print(f"      ⚠️  Announcement is not a dict: {type(announcement)}")
                                continue
                                
                            title = announcement.get('header', '').lower()
                            if any(keyword in title for keyword in ['annual report', 'full year', 'quarterly', 'half year']):
                                reports_found += 1
                                print(f"      📄 Found report: {announcement.get('header', 'N/A')[:60]}")
                                
                        print(f"      Total reports found: {reports_found}")
                    else:
                        print(f"      ⚠️  'data' is not a list or is empty")
                else:
                    print(f"      ⚠️  No 'data' key in response")
                    print(f"      Available keys: {list(data.keys())}")
            else:
                print(f"      ⚠️  Response is not a dict: {type(data)}")
                
        else:
            print(f"      ⚠️  HTTP {response.status_code}")
            
    except Exception as e:
        print(f"      ❌ Error: {type(e).__name__}: {e}")

# Test 2: Fixed Implementation
print("\n\n2️⃣  Testing Fixed Implementation...")

def fetch_annual_reports_fixed(stock_code: str, website: str = None) -> List[Dict[str, str]]:
    """
    Fixed version of fetch_annual_reports with proper error handling.
    """
    reports = []
    
    # Try ASX announcements API
    try:
        asx_url = f"https://cdn-api.markitdigital.com/apiman-gateway/ASX/asx-research/1.0/companies/{stock_code}/announcements"
        response = httpx.get(
            asx_url,
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10.0,
            follow_redirects=True
        )
        
        if response.status_code == 200:
            data = response.json()
            
            # Safely extract announcements list
            if isinstance(data, dict) and 'data' in data:
                announcements = data.get('data', [])
                
                # Ensure it's a list before iterating
                if isinstance(announcements, list):
                    # Filter for annual and quarterly reports
                    for announcement in announcements[:20]:  # Check last 20 announcements
                        # Validate announcement is a dict
                        if not isinstance(announcement, dict):
                            continue
                            
                        title = announcement.get('header', '').lower()
                        if any(keyword in title for keyword in ['annual report', 'full year', 'quarterly', 'half year']):
                            report_type = 'annual_report' if 'annual' in title or 'full year' in title else 'quarterly_report'
                            if 'half year' in title:
                                report_type = 'half_year_report'
                            
                            reports.append({
                                'type': report_type,
                                'date': announcement.get('documentDate', ''),
                                'url': announcement.get('url', ''),
                                'title': announcement.get('header', '')
                            })
                else:
                    print(f"  ⚠️  Announcements is not a list for {stock_code}: {type(announcements)}")
            else:
                print(f"  ⚠️  Unexpected API response structure for {stock_code}")
                
    except Exception as e:
        print(f"  ⚠️  Could not fetch ASX announcements for {stock_code}: {type(e).__name__}: {e}")
    
    return reports[:5]  # Return max 5 most recent reports

# Test with the fixed version
print("\n   Testing fixed function with multiple stocks:")
for stock_code in ['PLS', 'BHP', 'MML', '14D']:
    reports = fetch_annual_reports_fixed(stock_code)
    print(f"\n   {stock_code}: Found {len(reports)} reports")
    for i, report in enumerate(reports[:2], 1):
        print(f"      {i}. {report['type']}: {report['title'][:50]}")

# Test 3: Web Scraping (optional, if we have a website)
print("\n\n3️⃣  Testing Website Scraping...")
test_company = {
    'stock_code': 'PLS',
    'website': 'http://www.pilbaraminerals.com.au'
}

try:
    website = test_company['website']
    ir_paths = ['/investors', '/investor-relations', '/investor-centre', '/about/investors']
    
    for path in ir_paths:
        try:
            ir_url = urljoin(website, path)
            response = httpx.get(
                ir_url,
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=10.0,
                follow_redirects=True
            )
            
            if response.status_code == 200:
                soup = BeautifulSoup(response.content, 'html.parser')
                
                # Find PDF links
                pdf_count = 0
                for link in soup.find_all('a', href=True):
                    href = link['href']
                    text = link.get_text().lower()
                    
                    if href.endswith('.pdf') and any(keyword in text for keyword in ['annual', 'report', 'financial']):
                        pdf_count += 1
                        if pdf_count <= 2:
                            print(f"   📄 Found: {link.get_text().strip()[:60]}")
                
                if pdf_count > 0:
                    print(f"   ✅ Found {pdf_count} potential reports at {path}")
                    break
        except:
            continue
            
except Exception as e:
    print(f"   ⚠️  Website scraping test skipped: {e}")

print("\n" + "=" * 60)
print("✅ Integration Test Complete")
print("\nRecommendations:")
print("1. The ASX API structure needs defensive checks")
print("2. Always validate data types before iteration")
print("3. Handle non-dict announcement objects gracefully")
print("=" * 60)

