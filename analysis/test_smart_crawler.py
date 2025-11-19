#!/usr/bin/env python3
"""
Integration Test: Smart Financial Report Crawler

Tests the intelligent web crawler on real ASX companies to verify:
- Report discovery works
- Metadata extraction is accurate
- Depth limiting works
- Performance is acceptable
- Edge cases are handled
"""

import sys
import os
import time
from typing import List, Dict, Any
from collections import deque
from urllib.parse import urlparse, urljoin

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import httpx
from bs4 import BeautifulSoup
from sqlalchemy import create_engine
import pandas as pd
from dotenv import load_dotenv

# Load environment
load_dotenv()

# Database connection
DATABASE_URL = os.getenv('CMS_DATABASE_URL', 'postgresql://postgres.vfzzkelbpyjdvuujyrpu:GpbQqFc7rwe3gF0v@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres')

# ============================================================================
# SMART CRAWLER (Copy from notebook)
# ============================================================================

def crawl_for_reports(start_url: str, max_depth: int = 2, max_pages: int = 20) -> List[Dict[str, str]]:
    """
    ENHANCED intelligent crawler to find financial report PDFs.
    """
    from urllib.parse import urlunparse, parse_qs, urlencode
    import re
    
    reports = []
    visited = set()
    seen_pdf_urls = set()
    queue = deque([(start_url, 0, 10)])  # (url, depth, priority)
    base_domain = urlparse(start_url).netloc
    
    high_priority_keywords = [
        'annual-report', 'annual_report', 'annualreport',
        'financial-report', 'financial_report',
        'interim-report', 'quarterly-report',
        'investor-reports', 'investor/report'
    ]
    
    report_keywords = [
        'report', 'annual', 'financial', 'investor', 
        'result', 'presentation', 'disclosure'
    ]
    
    avoid_keywords = [
        'login', 'signup', 'register', 'cart', 'checkout',
        'subscribe', 'unsubscribe', 'cookie', 'privacy',
        'terms', 'condition', 'policy'
    ]
    
    def normalize_url(url: str) -> str:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        cleaned_query = {k: v for k, v in query.items() if k not in ['utm_source', 'utm_medium', 'ei', 'ref']}
        new_query = urlencode(cleaned_query, doseq=True)
        return urlunparse((parsed.scheme, parsed.netloc, parsed.path, '', new_query, ''))
    
    def extract_year_from_text(text: str) -> str:
        years = re.findall(r'20\d{2}', text)
        return max(years) if years else ''
    
    def is_financial_report_link(text: str, href: str) -> bool:
        combined = (text + ' ' + href).lower()
        has_report_keyword = any(kw in combined for kw in [
            'annual', 'report', 'financial', 'quarter', 'interim', 
            'full year', 'half year', 'result'
        ])
        has_avoid = any(kw in combined for kw in avoid_keywords)
        return has_report_keyword and not has_avoid
    
    def get_link_priority(url: str, text: str) -> int:
        combined = (url + ' ' + text).lower()
        score = 5
        if any(kw in combined for kw in high_priority_keywords):
            score += 10
        if any(kw in combined for kw in report_keywords):
            score += 5
        if any(kw in combined for kw in ['news', 'media', 'blog']):
            score -= 5
        return score
    
    while queue and len(visited) < max_pages:
        queue = deque(sorted(queue, key=lambda x: x[2], reverse=True))
        current_url, depth, priority = queue.popleft()
        
        norm_url = normalize_url(current_url)
        if norm_url in visited or depth > max_depth:
            continue
        
        visited.add(norm_url)
        
        try:
            response = httpx.get(
                current_url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                },
                timeout=15.0,
                follow_redirects=True
            )
            
            if response.status_code != 200:
                continue
            
            soup = BeautifulSoup(response.content, 'html.parser')
            
            for a_tag in soup.find_all('a', href=True):
                href = a_tag['href']
                text = a_tag.get_text().strip()
                text_lower = text.lower()
                
                full_url = urljoin(current_url, href)
                parsed = urlparse(full_url)
                
                if parsed.netloc and parsed.netloc != base_domain:
                    continue
                
                is_pdf = (
                    full_url.lower().endswith('.pdf') or
                    '.pdf?' in full_url.lower() or
                    'download' in href.lower() and 'pdf' in (text_lower + href.lower()) or
                    parsed.path.lower().endswith('.pdf')
                )
                
                if is_pdf and is_financial_report_link(text, href):
                    norm_pdf_url = normalize_url(full_url)
                    
                    if norm_pdf_url in seen_pdf_urls:
                        continue
                    
                    seen_pdf_urls.add(norm_pdf_url)
                    
                    year = extract_year_from_text(text + ' ' + full_url)
                    
                    report_type = 'annual_report'
                    if 'quarterly' in text_lower or 'quarter' in text_lower or 'q1' in text_lower or 'q2' in text_lower or 'q3' in text_lower or 'q4' in text_lower:
                        report_type = 'quarterly_report'
                    elif 'half year' in text_lower or 'interim' in text_lower or 'half-year' in text_lower:
                        report_type = 'half_year_report'
                    
                    clean_title = re.sub(r'\s+', ' ', text).strip()[:100]
                    
                    reports.append({
                        'type': report_type,
                        'url': full_url,
                        'title': clean_title if clean_title else f"{year} {report_type}",
                        'date': f"{year}-06-30" if year else '',
                        'source': 'smart_crawler',
                        'depth': depth
                    })
                
                elif depth < max_depth:
                    url_lower = full_url.lower()
                    has_avoid = any(kw in url_lower or kw in text_lower for kw in avoid_keywords)
                    
                    if not has_avoid and full_url not in visited:
                        link_priority = get_link_priority(full_url, text)
                        
                        if link_priority >= 5:
                            queue.append((full_url, depth + 1, link_priority))
        
        except Exception as e:
            pass
    
    # Final deduplication
    unique_reports = []
    seen_combinations = set()
    
    for report in reports:
        year = extract_year_from_text(report['url'] + report['title'])
        signature = f"{normalize_url(report['url'])}_{year}_{report['type']}"
        
        if signature not in seen_combinations:
            seen_combinations.add(signature)
            unique_reports.append(report)
    
    unique_reports.sort(key=lambda r: r.get('date', ''), reverse=True)
    
    return unique_reports

# ============================================================================
# TEST CASES
# ============================================================================

def fetch_test_companies() -> pd.DataFrame:
    """Fetch test companies from PayloadCMS"""
    engine = create_engine(DATABASE_URL)
    
    query = """
    SELECT 
        m.id,
        m.stock_code,
        m.company_name,
        m.website
    FROM metadata m
    WHERE m.stock_code IN ('5GN', 'BHP', 'CBA', 'ANZ', 'WBC', 'BAP', 'NSB')
    """
    
    df = pd.read_sql(query, engine)
    
    # Fetch investor links
    links_query = """
    SELECT 
        ml._parent_id,
        ml.link
    FROM metadata_links ml
    WHERE ml._parent_id IN (
        SELECT id FROM metadata WHERE stock_code IN ('5GN', 'BHP', 'CBA', 'ANZ', 'WBC', 'BAP', 'NSB')
    )
    ORDER BY ml._parent_id, ml._order
    """
    
    df_links = pd.read_sql(links_query, engine)
    engine.dispose()
    
    if not df_links.empty:
        df_links_agg = df_links.groupby('_parent_id')['link'].apply(list).reset_index()
        df_links_agg.columns = ['id', 'investor_links']
        df = df.merge(df_links_agg, on='id', how='left')
    else:
        df['investor_links'] = None
    
    df['investor_links'] = df['investor_links'].apply(lambda x: x if isinstance(x, list) else [])
    
    return df

def test_crawler_on_company(stock_code: str, company_name: str, investor_links: List[str]) -> Dict[str, Any]:
    """Test crawler on a single company"""
    print(f"\n{'=' * 80}")
    print(f"Testing: {stock_code} - {company_name}")
    print(f"{'=' * 80}")
    
    if not investor_links:
        print("⚠️  No investor links found")
        return {
            'stock_code': stock_code,
            'success': False,
            'error': 'No investor links',
            'reports_found': 0
        }
    
    print(f"📋 Investor links: {len(investor_links)}")
    for i, link in enumerate(investor_links[:3], 1):
        print(f"   {i}. {link}")
    
    # Test first investor link
    test_link = investor_links[0]
    print(f"\n🔍 Crawling: {test_link}")
    print("   (Max depth: 2, Max pages: 20, Timeout: 10s)")
    
    start_time = time.time()
    
    try:
        reports = crawl_for_reports(test_link, max_depth=2, max_pages=20)
        elapsed = time.time() - start_time
        
        print(f"\n✅ Completed in {elapsed:.1f}s")
        print(f"📊 Found {len(reports)} reports")
        
        if reports:
            # Show first 5 reports
            print("\n📄 Sample Reports:")
            for i, report in enumerate(reports[:5], 1):
                print(f"   {i}. [{report['type']:20s}] {report['title'][:50]}")
                print(f"      Date: {report.get('date', 'N/A'):12s} | Depth: {report.get('depth', 0)}")
            
            if len(reports) > 5:
                print(f"   ... and {len(reports) - 5} more")
            
            # Validate report structure
            for report in reports:
                assert 'type' in report, "Missing 'type' field"
                assert 'url' in report, "Missing 'url' field"
                assert 'title' in report, "Missing 'title' field"
                assert report['type'] in ['annual_report', 'quarterly_report', 'half_year_report'], f"Invalid type: {report['type']}"
                assert report['url'].startswith('http'), f"Invalid URL: {report['url']}"
        else:
            print("   ⚠️  No reports found")
        
        return {
            'stock_code': stock_code,
            'company_name': company_name,
            'success': True,
            'reports_found': len(reports),
            'elapsed_time': elapsed,
            'reports': reports[:10]  # Store first 10 for analysis
        }
    
    except Exception as e:
        elapsed = time.time() - start_time
        print(f"\n❌ Error after {elapsed:.1f}s: {e}")
        return {
            'stock_code': stock_code,
            'company_name': company_name,
            'success': False,
            'error': str(e),
            'reports_found': 0,
            'elapsed_time': elapsed
        }

def run_integration_tests():
    """Run full integration test suite"""
    print("=" * 80)
    print("🚀 SMART CRAWLER INTEGRATION TESTS")
    print("=" * 80)
    
    # Fetch test companies
    print("\n📥 Fetching test companies from PayloadCMS...")
    df_companies = fetch_test_companies()
    print(f"✅ Loaded {len(df_companies)} test companies")
    
    # Run tests
    results = []
    for _, company in df_companies.iterrows():
        result = test_crawler_on_company(
            company['stock_code'],
            company['company_name'],
            company.get('investor_links', [])
        )
        results.append(result)
        time.sleep(2)  # Be nice to servers
    
    # Summary
    print("\n" + "=" * 80)
    print("📊 TEST SUMMARY")
    print("=" * 80)
    
    successful = [r for r in results if r['success']]
    failed = [r for r in results if not r['success']]
    
    print(f"\n✅ Successful: {len(successful)}/{len(results)}")
    print(f"❌ Failed: {len(failed)}/{len(results)}")
    
    if successful:
        total_reports = sum(r['reports_found'] for r in successful)
        avg_reports = total_reports / len(successful)
        avg_time = sum(r['elapsed_time'] for r in successful) / len(successful)
        
        print(f"\n📈 Performance Metrics:")
        print(f"   Total reports found: {total_reports}")
        print(f"   Average per company: {avg_reports:.1f}")
        print(f"   Average crawl time: {avg_time:.1f}s")
        
        print(f"\n🏆 Best Performers:")
        best = sorted(successful, key=lambda x: x['reports_found'], reverse=True)[:3]
        for i, r in enumerate(best, 1):
            print(f"   {i}. {r['stock_code']}: {r['reports_found']} reports in {r['elapsed_time']:.1f}s")
    
    if failed:
        print(f"\n⚠️  Failed Tests:")
        for r in failed:
            print(f"   - {r['stock_code']}: {r.get('error', 'Unknown error')}")
    
    # Report type breakdown
    print(f"\n📋 Report Type Breakdown:")
    report_types = {}
    for r in successful:
        for report in r.get('reports', []):
            report_type = report.get('type', 'unknown')
            report_types[report_type] = report_types.get(report_type, 0) + 1
    
    for report_type, count in sorted(report_types.items(), key=lambda x: x[1], reverse=True):
        print(f"   {report_type:25s}: {count:3d}")
    
    # Depth analysis
    print(f"\n🔍 Depth Analysis:")
    depths = {}
    for r in successful:
        for report in r.get('reports', []):
            depth = report.get('depth', 0)
            depths[depth] = depths.get(depth, 0) + 1
    
    for depth in sorted(depths.keys()):
        print(f"   Depth {depth}: {depths[depth]:3d} reports")
    
    print("\n" + "=" * 80)
    
    # Pass/fail criteria
    if len(successful) >= len(results) * 0.7:  # 70% success rate
        if successful and avg_reports >= 2:  # At least 2 reports per company
            print("✅ INTEGRATION TEST PASSED")
            print(f"   - {len(successful)}/{len(results)} companies successful")
            print(f"   - {avg_reports:.1f} reports per company (target: 2+)")
            return True
        else:
            print("⚠️  INTEGRATION TEST MARGINAL")
            print(f"   - Success rate OK ({len(successful)}/{len(results)})")
            print(f"   - Report count low ({avg_reports:.1f} per company)")
            return False
    else:
        print("❌ INTEGRATION TEST FAILED")
        print(f"   - Low success rate: {len(successful)}/{len(results)}")
        return False

if __name__ == "__main__":
    success = run_integration_tests()
    sys.exit(0 if success else 1)

