#!/usr/bin/env python3
"""
Logo Extraction Test Suite

Tests the HTML intelligence extraction against known hard cases.
Evaluates logo quality, extraction accuracy, and identifies issues.

Test companies:
- DMP (Domino's Pizza) - Iconic red/blue domino logo
- 4DS (4DS Memory) - Text-integrated mark
- CBA (Commonwealth Bank) - Yellow diamond/star logo  
- NAB (National Australia Bank) - Red star logo
- BHP (BHP Group) - Orange/black industrial logo
- WOW (Woolworths) - Green "fresh" apple logo
"""
import os
import sys
import json
import time
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Optional, Any
from datetime import datetime
import hashlib

# Add paths
sys.path.insert(0, str(Path(__file__).parent.parent / 'services' / 'pkg' / 'enrichment'))

from html_intelligence import HTMLIntelligenceExtractor, LogoCandidate, generate_llm_context
import httpx
from PIL import Image
from io import BytesIO

# ============================================================
# Test Configuration
# ============================================================

@dataclass
class TestCase:
    """A test case for logo extraction."""
    stock_code: str
    company_name: str
    website: str
    
    # Expected characteristics (for validation)
    expected_format: Optional[str] = None  # svg, png, jpeg
    expected_min_size: int = 64  # Minimum dimension
    logo_keywords: List[str] = field(default_factory=list)  # Expected in URL/alt
    should_have_icon: bool = False  # Should extract separate icon
    
    # Notes about this test case
    notes: str = ""


TEST_CASES = [
    TestCase(
        stock_code="DMP",
        company_name="Domino's Pizza Enterprises",
        website="https://www.dominos.com.au",
        expected_format="svg",
        logo_keywords=["domino", "logo"],
        notes="Iconic red/blue domino tile logo"
    ),
    TestCase(
        stock_code="4DS",
        company_name="4DS Memory Limited",
        website="https://www.4dsmemory.com",
        expected_format=None,  # Can be SVG or PNG
        logo_keywords=["4ds", "logo", "memory"],
        should_have_icon=False,  # Text-integrated logo
        notes="Text-integrated '4DS' blocks + 'Memory' tagline"
    ),
    TestCase(
        stock_code="CBA",
        company_name="Commonwealth Bank of Australia",
        website="https://www.commbank.com.au",
        expected_format="svg",
        logo_keywords=["commbank", "cba", "logo"],
        should_have_icon=True,  # Yellow diamond can be extracted
        notes="Yellow diamond logo - iconic Australian bank"
    ),
    TestCase(
        stock_code="NAB",
        company_name="National Australia Bank",
        website="https://www.nab.com.au",
        expected_format="svg",
        logo_keywords=["nab", "logo"],
        should_have_icon=True,  # Red star icon
        notes="Red star logo"
    ),
    TestCase(
        stock_code="BHP",
        company_name="BHP Group Limited",
        website="https://www.bhp.com",
        expected_format="svg",
        logo_keywords=["bhp", "logo"],
        notes="Orange/red industrial logo"
    ),
    TestCase(
        stock_code="WOW",
        company_name="Woolworths Group Limited",
        website="https://www.woolworthsgroup.com.au",
        expected_format="svg",
        logo_keywords=["woolworths", "logo"],
        notes="Green apple 'fresh' logo"
    ),
    TestCase(
        stock_code="GAL",
        company_name="Galileo Mining Ltd",
        website="https://www.galileomining.com.au",
        expected_format="svg",
        logo_keywords=["galileo", "logo"],
        should_have_icon=True,  # Spiral icon
        notes="Spiral/target icon + 'GALILEO Mining' text"
    ),
    TestCase(
        stock_code="ASX",
        company_name="ASX Limited",
        website="https://www.asx.com.au",
        expected_format="svg",
        logo_keywords=["asx", "logo"],
        notes="ASX exchange logo"
    ),
]


@dataclass
class ExtractionResult:
    """Result of a single extraction test."""
    stock_code: str
    company_name: str
    website: str
    
    # Extraction metrics
    success: bool = False
    num_candidates: int = 0
    top_candidate_score: float = 0.0
    top_candidate_source: str = ""
    top_candidate_format: str = ""
    top_candidate_url: str = ""
    
    # Logo validation
    logo_downloaded: bool = False
    logo_size_bytes: int = 0
    logo_dimensions: str = ""  # "WxH"
    logo_is_valid_image: bool = False
    
    # LLM context
    llm_context_available: bool = False
    llm_context_preview: str = ""
    
    # Score breakdown
    score_breakdown: Dict[str, float] = field(default_factory=dict)
    
    # Timing
    extraction_time_ms: int = 0
    download_time_ms: int = 0
    
    # Issues found
    issues: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    
    # Test case notes
    notes: str = ""


# ============================================================
# Extraction Tester
# ============================================================

class LogoExtractionTester:
    """Tests logo extraction against known cases."""
    
    def __init__(self, output_dir: str = "data/test_extraction"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.extractor = HTMLIntelligenceExtractor()
        self.http_client = httpx.Client(
            timeout=30.0,
            follow_redirects=True,
            headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'image/*,*/*;q=0.8',
            }
        )
    
    def run_test(self, test_case: TestCase) -> ExtractionResult:
        """Run extraction test for a single case."""
        result = ExtractionResult(
            stock_code=test_case.stock_code,
            company_name=test_case.company_name,
            website=test_case.website,
            notes=test_case.notes,
        )
        
        print(f"\n{'='*60}")
        print(f"Testing: {test_case.stock_code} - {test_case.company_name}")
        print(f"Website: {test_case.website}")
        print(f"Notes: {test_case.notes}")
        print('='*60)
        
        # Phase 1: Extract candidates
        start_time = time.time()
        try:
            intel = self.extractor.extract(
                test_case.website,
                test_case.company_name,
                crawl_brand_pages=True,
                fetch_manifests=True
            )
            result.extraction_time_ms = int((time.time() - start_time) * 1000)
            result.num_candidates = len(intel.logo_candidates)
            
            # Get LLM context
            llm_context = generate_llm_context(intel)
            result.llm_context_available = bool(llm_context)
            result.llm_context_preview = llm_context[:200] if llm_context else ""
            
            print(f"\n📊 Extraction Stats:")
            print(f"   Time: {result.extraction_time_ms}ms")
            print(f"   Candidates: {result.num_candidates}")
            print(f"   LLM Context: {'Yes' if result.llm_context_available else 'No'}")
            
            if intel.logo_candidates:
                result.success = True
                top = intel.logo_candidates[0]
                result.top_candidate_score = top.score
                result.top_candidate_source = top.source
                result.top_candidate_format = top.format
                result.top_candidate_url = top.url[:100]
                result.score_breakdown = top.score_breakdown
                
                print(f"\n🏆 Top Candidate:")
                print(f"   Score: {top.score:.1f}")
                print(f"   Source: {top.source}")
                print(f"   Format: {top.format}")
                print(f"   URL: {top.url[:80]}...")
                print(f"   Breakdown: {top.score_breakdown}")
                
                # Show top 5
                print(f"\n📋 Top 5 Candidates:")
                for i, c in enumerate(intel.logo_candidates[:5]):
                    inline = " (INLINE)" if c.inline_content else ""
                    print(f"   {i+1}. [{c.score:.0f}] {c.source}: {c.format}{inline}")
                
                # Phase 2: Try to download/validate top candidate
                result = self._validate_logo(result, top, test_case)
                
            else:
                result.issues.append("No logo candidates found")
                print(f"\n❌ No candidates found!")
        
        except Exception as e:
            result.issues.append(f"Extraction error: {str(e)}")
            print(f"\n❌ Error: {e}")
        
        # Phase 3: Check against expected characteristics
        result = self._check_expectations(result, test_case)
        
        return result
    
    def _validate_logo(self, result: ExtractionResult, candidate: LogoCandidate, 
                       test_case: TestCase) -> ExtractionResult:
        """Download and validate the logo."""
        print(f"\n🔍 Validating logo...")
        
        # Handle inline content
        if candidate.inline_content:
            if candidate.source == 'inline_svg':
                data = candidate.inline_content.encode('utf-8')
                result.logo_downloaded = True
                result.logo_size_bytes = len(data)
                result.logo_is_valid_image = True
                
                # Save to file
                svg_path = self.output_dir / f"{test_case.stock_code}.svg"
                svg_path.write_bytes(data)
                print(f"   ✓ Saved inline SVG: {svg_path}")
                
                # Try to render for dimensions
                try:
                    import cairosvg
                    png_data = cairosvg.svg2png(bytestring=data, output_width=256)
                    img = Image.open(BytesIO(png_data))
                    result.logo_dimensions = f"{img.width}x{img.height}"
                    
                    png_path = self.output_dir / f"{test_case.stock_code}.png"
                    img.save(png_path)
                    print(f"   ✓ Rendered to PNG: {result.logo_dimensions}")
                except Exception as e:
                    result.warnings.append(f"SVG render failed: {e}")
                
                return result
        
        # Download external logo
        if candidate.url.startswith(('http://', 'https://')):
            start_time = time.time()
            try:
                response = self.http_client.get(candidate.url)
                result.download_time_ms = int((time.time() - start_time) * 1000)
                
                if response.status_code == 200:
                    data = response.content
                    result.logo_downloaded = True
                    result.logo_size_bytes = len(data)
                    
                    # Determine format from content-type
                    content_type = response.headers.get('content-type', '').lower()
                    
                    # Save raw file
                    ext = candidate.format if candidate.format != 'unknown' else 'bin'
                    if 'svg' in content_type:
                        ext = 'svg'
                    elif 'png' in content_type:
                        ext = 'png'
                    elif 'jpeg' in content_type or 'jpg' in content_type:
                        ext = 'jpg'
                    
                    raw_path = self.output_dir / f"{test_case.stock_code}.{ext}"
                    raw_path.write_bytes(data)
                    print(f"   ✓ Downloaded: {result.logo_size_bytes} bytes -> {raw_path}")
                    
                    # Validate as image
                    try:
                        if ext == 'svg':
                            result.logo_is_valid_image = b'<svg' in data.lower() or b'<?xml' in data
                            # Render
                            try:
                                import cairosvg
                                png_data = cairosvg.svg2png(bytestring=data, output_width=256)
                                img = Image.open(BytesIO(png_data))
                                result.logo_dimensions = f"{img.width}x{img.height}"
                                
                                png_path = self.output_dir / f"{test_case.stock_code}.png"
                                img.save(png_path)
                            except:
                                pass
                        else:
                            img = Image.open(BytesIO(data))
                            result.logo_is_valid_image = True
                            result.logo_dimensions = f"{img.width}x{img.height}"
                            print(f"   ✓ Valid image: {result.logo_dimensions}")
                    except Exception as e:
                        result.warnings.append(f"Image validation failed: {e}")
                else:
                    result.issues.append(f"Download failed: HTTP {response.status_code}")
                    
            except Exception as e:
                result.issues.append(f"Download error: {e}")
        
        return result
    
    def _check_expectations(self, result: ExtractionResult, 
                           test_case: TestCase) -> ExtractionResult:
        """Check result against expected characteristics."""
        print(f"\n📋 Checking expectations...")
        
        # Check format
        if test_case.expected_format:
            if result.top_candidate_format != test_case.expected_format:
                result.warnings.append(
                    f"Expected format '{test_case.expected_format}', got '{result.top_candidate_format}'"
                )
                print(f"   ⚠️ Format mismatch: expected {test_case.expected_format}")
        
        # Check keywords in URL
        if test_case.logo_keywords:
            url_lower = result.top_candidate_url.lower()
            found_keywords = [kw for kw in test_case.logo_keywords if kw in url_lower]
            if not found_keywords:
                result.warnings.append(
                    f"Expected keywords {test_case.logo_keywords} not found in URL"
                )
                print(f"   ⚠️ Keywords not found: {test_case.logo_keywords}")
            else:
                print(f"   ✓ Found keywords: {found_keywords}")
        
        # Check minimum size
        if result.logo_dimensions:
            try:
                w, h = map(int, result.logo_dimensions.split('x'))
                if min(w, h) < test_case.expected_min_size:
                    result.warnings.append(
                        f"Logo too small: {result.logo_dimensions} (min: {test_case.expected_min_size})"
                    )
                    print(f"   ⚠️ Logo small: {result.logo_dimensions}")
            except:
                pass
        
        # Summary
        if not result.issues:
            print(f"\n✅ Test PASSED")
        else:
            print(f"\n❌ Test FAILED: {result.issues}")
        
        if result.warnings:
            print(f"⚠️ Warnings: {result.warnings}")
        
        return result
    
    def run_all_tests(self) -> Dict[str, Any]:
        """Run all test cases and generate report."""
        results = []
        
        print("\n" + "="*70)
        print("🧪 LOGO EXTRACTION TEST SUITE")
        print("="*70)
        print(f"Running {len(TEST_CASES)} test cases...")
        
        for test_case in TEST_CASES:
            result = self.run_test(test_case)
            results.append(result)
        
        # Generate summary
        summary = self._generate_summary(results)
        
        # Save results
        report_path = self.output_dir / "test_report.json"
        report = {
            "timestamp": datetime.now().isoformat(),
            "summary": summary,
            "results": [asdict(r) for r in results],
        }
        report_path.write_text(json.dumps(report, indent=2))
        print(f"\n📄 Report saved to: {report_path}")
        
        return report
    
    def _generate_summary(self, results: List[ExtractionResult]) -> Dict[str, Any]:
        """Generate test summary."""
        total = len(results)
        passed = sum(1 for r in results if r.success and not r.issues)
        failed = sum(1 for r in results if r.issues)
        warnings = sum(1 for r in results if r.warnings)
        
        avg_extraction_time = sum(r.extraction_time_ms for r in results) / total if total else 0
        avg_candidates = sum(r.num_candidates for r in results) / total if total else 0
        
        print("\n" + "="*70)
        print("📊 TEST SUMMARY")
        print("="*70)
        print(f"Total:    {total}")
        print(f"Passed:   {passed} ✅")
        print(f"Failed:   {failed} ❌")
        print(f"Warnings: {warnings} ⚠️")
        print(f"Avg Time: {avg_extraction_time:.0f}ms")
        print(f"Avg Candidates: {avg_candidates:.1f}")
        
        print("\n📋 Results by Stock:")
        for r in results:
            status = "✅" if r.success and not r.issues else "❌"
            warn = f" ⚠️({len(r.warnings)})" if r.warnings else ""
            print(f"   {status} {r.stock_code}: {r.num_candidates} candidates, "
                  f"top={r.top_candidate_score:.0f}, {r.top_candidate_format}{warn}")
        
        return {
            "total": total,
            "passed": passed,
            "failed": failed,
            "with_warnings": warnings,
            "avg_extraction_time_ms": avg_extraction_time,
            "avg_candidates": avg_candidates,
        }
    
    def close(self):
        """Clean up resources."""
        self.extractor.close()
        self.http_client.close()


# ============================================================
# Main
# ============================================================

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Test logo extraction")
    parser.add_argument("--stock", help="Test single stock code")
    parser.add_argument("--output", default="data/test_extraction", help="Output directory")
    args = parser.parse_args()
    
    tester = LogoExtractionTester(output_dir=args.output)
    
    try:
        if args.stock:
            # Run single test
            test_case = next(
                (tc for tc in TEST_CASES if tc.stock_code == args.stock.upper()),
                None
            )
            if test_case:
                result = tester.run_test(test_case)
            else:
                # Create ad-hoc test case
                print(f"Stock {args.stock} not in predefined tests, creating ad-hoc test...")
                # Would need to look up website from database
                print(f"Please add {args.stock} to TEST_CASES or provide website")
        else:
            # Run all tests
            report = tester.run_all_tests()
    finally:
        tester.close()
