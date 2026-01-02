#!/usr/bin/env python3
"""
Integration test for FIXED annual report fetcher.
"""

import httpx
from typing import Dict, List
from urllib.parse import urljoin
from bs4 import BeautifulSoup

def fetch_annual_reports_fixed(stock_code: str, website: str = None) -> List[Dict[str, str]]:
    """
    FIXED version: Fetch annual reports from ASX announcements and company website.
    
    BUG FIX:
    - ASX API structure is data.items (not data as a list)
    - Field is 'headline' not 'header'
    - Field is 'date' not 'documentDate'
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
            
            # ASX API structure: data -> items array
            if isinstance(data, dict) and 'data' in data:
                api_data = data.get('data', {})
                if isinstance(api_data, dict):
                    announcements = api_data.get('items', [])
                    
                    # Filter for annual and quarterly reports
                    if isinstance(announcements, list):
                        for announcement in announcements[:20]:  # Check last 20 announcements
                            if not isinstance(announcement, dict):
                                continue
                                
                            # API uses 'headline' not 'header'
                            title = announcement.get('headline', '').lower()
                            if any(keyword in title for keyword in ['annual report', 'full year', 'quarterly', 'half year']):
                                report_type = 'annual_report' if 'annual' in title or 'full year' in title else 'quarterly_report'
                                if 'half year' in title:
                                    report_type = 'half_year_report'
                                
                                reports.append({
                                    'type': report_type,
                                    'date': announcement.get('date', ''),
                                    'url': announcement.get('url', ''),
                                    'title': announcement.get('headline', '')
                                })
    except Exception as e:
        print(f"  ⚠ Could not fetch ASX announcements for {stock_code}: {type(e).__name__}: {e}")
    
    # Try company website investor relations page
    if website and website != 'N/A':
        try:
            # Common investor relations paths
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
                        
                        # Find PDF links that look like reports
                        for link in soup.find_all('a', href=True):
                            href = link['href']
                            text = link.get_text().lower()
                            
                            if href.endswith('.pdf') and any(keyword in text for keyword in ['annual', 'report', 'financial']):
                                full_url = urljoin(ir_url, href)
                                
                                # Avoid duplicates
                                if not any(r['url'] == full_url for r in reports):
                                    reports.append({
                                        'type': 'annual_report',
                                        'url': full_url,
                                        'title': link.get_text().strip()
                                    })
                        
                        break  # Found a working IR page
                        
                except:
                    continue
                    
        except Exception as e:
            print(f"  ⚠ Could not scrape website for {stock_code}: {e}")
    
    return reports[:5]  # Return max 5 most recent reports


print("🧪 Testing FIXED Annual Report Fetcher")
print("=" * 70)

# Test with multiple stocks including the one that failed
test_stocks = [
    ('PLS', 'http://www.pilbaraminerals.com.au'),
    ('BHP', 'https://www.bhp.com'),
    ('MML', None),  # The one that failed
    ('14D', 'http://www.1414degrees.com.au'),
]

for stock_code, website in test_stocks:
    print(f"\n📊 Testing {stock_code}:")
    try:
        reports = fetch_annual_reports_fixed(stock_code, website)
        print(f"   ✅ Found {len(reports)} reports")
        
        for i, report in enumerate(reports, 1):
            print(f"      {i}. [{report['type']}] {report['title'][:60]}")
            if report['date']:
                print(f"         Date: {report['date']}")
                
    except Exception as e:
        print(f"   ❌ Error: {type(e).__name__}: {e}")

print("\n" + "=" * 70)
print("✅ Fixed Implementation Test Complete!")
print("\nChanges Made:")
print("1. Changed data.get('data', []) to data['data']['items']")
print("2. Changed 'header' to 'headline'")
print("3. Changed 'documentDate' to 'date'")
print("4. Added proper type checking for nested structures")
print("5. Added defensive checks for non-dict announcements")
print("=" * 70)

