#!/usr/bin/env python3
"""
Test script to run batch enrichment on a single company.
"""
import os
import sys
import json
from datetime import datetime
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

# Load environment
from dotenv import load_dotenv
load_dotenv()

import httpx
import pandas as pd
from openai import OpenAI
from sqlalchemy import create_engine, text
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple
import time
import subprocess
import tempfile
from io import BytesIO

# Configuration
DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://admin:password@localhost:5438/shorts')
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')
GCS_BUCKET = os.getenv('GCS_LOGO_BUCKET', 'shorted-company-logos')

# Logo processor paths
ENRICHMENT_PROCESSOR_DIR = Path(__file__).parent.parent / 'services' / 'enrichment-processor'
# Use v2 processor with smarter icon extraction (SAM + structure analysis)
LOGO_PROCESSOR_PATH = ENRICHMENT_PROCESSOR_DIR / 'logo_processor_v2.py'
SVG_TEXT_REMOVER_PATH = ENRICHMENT_PROCESSOR_DIR / 'svg_text_remover.py'

print("=" * 60)
print("BATCH ENRICHMENT TEST (N=1)")
print("=" * 60)
print(f"Database: {DATABASE_URL.split('@')[1] if '@' in DATABASE_URL else DATABASE_URL}")
print(f"OpenAI API Key: {'Set' if OPENAI_API_KEY else 'NOT SET'}")
print(f"Logo Processor: {LOGO_PROCESSOR_PATH.exists()}")
print()

# ============================================================
# Logo Discovery Classes (Using HTML Intelligence Layer)
# ============================================================

# Import the intelligent HTML parser
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / 'services' / 'pkg' / 'enrichment'))
try:
    from html_intelligence import HTMLIntelligenceExtractor, LogoCandidate as IntelLogoCandidate, generate_llm_context
    HTML_INTELLIGENCE_AVAILABLE = True
except ImportError:
    HTML_INTELLIGENCE_AVAILABLE = False
    print("⚠️  HTML Intelligence module not available, using fallback")

@dataclass
class LogoCandidate:
    url: str
    format: str = 'unknown'
    source: str = 'unknown'
    score: float = 0.0
    width: int = 0
    height: int = 0
    alt: str = ''
    found_on_page: str = ''
    # New fields for inline content
    inline_content: Optional[str] = None
    css_classes: List[str] = field(default_factory=list)

@dataclass
class DiscoveredLogo:
    source_url: str
    image_data: bytes
    format: str
    width: int = 0
    height: int = 0
    quality_score: float = 0.0
    is_svg: bool = False
    svg_data: bytes = field(default_factory=bytes)
    # New: inline SVG content
    inline_svg: Optional[str] = None
    # LLM context from HTML
    llm_context: Optional[str] = None

class LogoScraper:
    """
    Enhanced logo scraper using HTML Intelligence Layer.
    
    Improvements over v1:
    1. Extracts inline SVGs (no HTTP request needed)
    2. Parses JSON-LD for schema.org logo
    3. Extracts CSS background images
    4. Provides LLM context for better enrichment
    """
    LOGO_KEYWORDS = ['logo', 'brand', 'emblem', 'mark', 'icon']
    BRAND_KEYWORDS = ['brand', 'media', 'press', 'logo', 'asset', 'download', 'kit']
    COMMON_BRAND_PATHS = [
        '/brand', '/brand-assets', '/media', '/media-kit',
        '/press', '/press-kit', '/about', '/about-us', '/assets', '/logos'
    ]
    
    def __init__(self, company_name: str = '', max_pages: int = 5):
        self.company_name = company_name.lower()
        self.max_pages = max_pages
        self.client = httpx.Client(
            timeout=30.0,
            follow_redirects=True,
            headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            }
        )
        # Use intelligent extractor if available
        self._intel_extractor = HTMLIntelligenceExtractor() if HTML_INTELLIGENCE_AVAILABLE else None
        self._llm_context: Optional[str] = None
    
    def scrape_logos(self, website_url: str) -> List[LogoCandidate]:
        """Scrape logos using intelligent HTML extraction."""
        # Try intelligent extraction first
        if self._intel_extractor:
            return self._scrape_intelligent(website_url)
        return self._scrape_fallback(website_url)
    
    def get_llm_context(self) -> Optional[str]:
        """Get LLM context from last extraction."""
        return self._llm_context
    
    def _scrape_intelligent(self, website_url: str) -> List[LogoCandidate]:
        """Use HTML Intelligence layer for extraction."""
        try:
            intel = self._intel_extractor.extract(
                website_url, 
                self.company_name,
                crawl_brand_pages=True,
                fetch_manifests=True
            )
            
            # Store LLM context for later use
            self._llm_context = generate_llm_context(intel)
            
            # Convert to our LogoCandidate format
            candidates = []
            for ic in intel.logo_candidates:
                candidate = LogoCandidate(
                    url=ic.url,
                    format=ic.format,
                    source=ic.source,
                    score=ic.score,
                    width=ic.width,
                    height=ic.height,
                    alt=ic.alt,
                    inline_content=ic.inline_content,
                    css_classes=ic.css_classes if hasattr(ic, 'css_classes') else [],
                )
                candidates.append(candidate)
            
            return candidates
            
        except Exception as e:
            print(f"    ⚠️  Intelligent extraction failed: {e}, using fallback")
            return self._scrape_fallback(website_url)
    
    def _scrape_fallback(self, website_url: str) -> List[LogoCandidate]:
        """Fallback to simple extraction."""
        candidates = []
        base_url = self._normalize_base_url(website_url)
        if not base_url:
            return candidates
        
        # Phase 1: Scan homepage
        homepage_candidates, brand_links = self._scan_page(base_url, base_url)
        candidates.extend(homepage_candidates)
        
        # Phase 2: Add common brand paths
        for path in self.COMMON_BRAND_PATHS:
            page_url = base_url + path
            if page_url not in brand_links:
                brand_links.append(page_url)
        
        # Phase 3: Crawl brand pages (limit to 3 for speed)
        crawled = {base_url}
        for link in brand_links[:3]:
            if link in crawled:
                continue
            crawled.add(link)
            page_candidates, _ = self._scan_page(link, base_url)
            candidates.extend(page_candidates)
        
        # Score and sort
        for c in candidates:
            c.score = self._score_candidate(c)
        candidates.sort(key=lambda x: x.score, reverse=True)
        
        return candidates
    
    def _normalize_base_url(self, raw_url: str) -> Optional[str]:
        if not raw_url.startswith(('http://', 'https://')):
            raw_url = 'https://' + raw_url
        try:
            parsed = urlparse(raw_url)
            return f"{parsed.scheme}://{parsed.netloc}"
        except:
            return None
    
    def _scan_page(self, page_url: str, base_url: str) -> Tuple[List[LogoCandidate], List[str]]:
        candidates = []
        brand_links = []
        try:
            response = self.client.get(page_url)
            if response.status_code != 200:
                return candidates, brand_links
            soup = BeautifulSoup(response.content, 'html.parser')
            candidates.extend(self._extract_img_tags(soup, page_url, base_url))
            candidates.extend(self._extract_og_image(soup, page_url, base_url))
            candidates.extend(self._extract_favicons(soup, page_url, base_url))
        except Exception as e:
            print(f"    Error scanning {page_url}: {e}")
        return candidates, brand_links
    
    def _extract_img_tags(self, soup: BeautifulSoup, page_url: str, base_url: str) -> List[LogoCandidate]:
        candidates = []
        for img in soup.find_all('img'):
            src = img.get('src') or img.get('data-src') or ''
            if not src or src.startswith('data:'):
                continue
            absolute_url = urljoin(base_url, src)
            format_ = self._detect_format(absolute_url)
            alt = img.get('alt', '')
            in_header = img.find_parent(['header', 'nav']) is not None
            source = 'img_tag_header' if in_header else 'img_tag'
            if format_ == 'svg':
                source = 'img_svg_header' if in_header else 'img_svg'
            candidate = LogoCandidate(
                url=absolute_url, format=format_, source=source,
                width=self._parse_int(img.get('width', '0')),
                height=self._parse_int(img.get('height', '0')),
                alt=alt, found_on_page=page_url,
            )
            if self._contains_logo_keyword(src) or self._contains_logo_keyword(alt):
                candidate.score += 20
            candidates.append(candidate)
        return candidates
    
    def _extract_og_image(self, soup: BeautifulSoup, page_url: str, base_url: str) -> List[LogoCandidate]:
        candidates = []
        for meta in soup.find_all('meta', property='og:image'):
            content = meta.get('content', '')
            if content:
                absolute_url = urljoin(base_url, content)
                candidates.append(LogoCandidate(
                    url=absolute_url, format=self._detect_format(absolute_url),
                    source='og_image', found_on_page=page_url,
                ))
        return candidates
    
    def _extract_favicons(self, soup: BeautifulSoup, page_url: str, base_url: str) -> List[LogoCandidate]:
        candidates = []
        for link in soup.find_all('link', rel=lambda x: x and any(r in x for r in ['icon', 'apple-touch-icon'])):
            href = link.get('href', '')
            if href:
                absolute_url = urljoin(base_url, href)
                rel = ' '.join(link.get('rel', []))
                source = 'apple_touch_icon' if 'apple-touch-icon' in rel else 'favicon'
                candidates.append(LogoCandidate(
                    url=absolute_url, format=self._detect_format(absolute_url),
                    source=source, found_on_page=page_url,
                ))
        return candidates
    
    def _score_candidate(self, c: LogoCandidate) -> float:
        score = 0.0
        format_scores = {'svg': 100, 'png': 50, 'webp': 45, 'jpeg': 30, 'jpg': 30, 'gif': 20}
        score += format_scores.get(c.format, 0)
        if c.width > 0:
            score += c.width / 100.0
            if c.width >= 256: score += 10
        source_scores = {
            'img_svg_header': 25, 'img_tag_header': 20, 'img_svg': 12,
            'apple_touch_icon': 12, 'og_image': 10, 'img_tag': 5, 'favicon': 3
        }
        score += source_scores.get(c.source, 0)
        url_lower = c.url.lower()
        if 'logo' in url_lower: score += 20
        if 'brand' in url_lower: score += 15
        if self.company_name and self.company_name in url_lower: score += 10
        if 0 < c.width < 32: score -= 20
        return score + c.score
    
    def _detect_format(self, url: str) -> str:
        path = urlparse(url.lower()).path
        if path.endswith('.svg'): return 'svg'
        elif path.endswith('.png'): return 'png'
        elif path.endswith(('.jpg', '.jpeg')): return 'jpeg'
        elif path.endswith('.gif'): return 'gif'
        elif path.endswith('.webp'): return 'webp'
        elif path.endswith('.ico'): return 'ico'
        return 'unknown'
    
    def _contains_logo_keyword(self, s: str) -> bool:
        return any(kw in s.lower() for kw in self.LOGO_KEYWORDS)
    
    def _parse_int(self, val: str) -> int:
        try:
            return int(val.replace('px', '').strip())
        except:
            return 0

class LogoDiscoverer:
    """
    Enhanced logo discoverer with inline SVG support.
    
    Key improvements:
    1. Uses inline SVGs directly (no HTTP fetch needed)
    2. Captures LLM context from HTML extraction
    3. Better scoring via HTML Intelligence layer
    """
    def __init__(self):
        self.client = httpx.Client(
            timeout=30.0,
            follow_redirects=True,
            headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'image/svg+xml,image/*,*/*;q=0.8',
            }
        )
        self._llm_context: Optional[str] = None
    
    def discover_logo(self, website: str, company_name: str, stock_code: str) -> Optional[DiscoveredLogo]:
        if not website or not website.strip():
            return None
        
        scraper = LogoScraper(company_name=company_name)
        candidates = scraper.scrape_logos(website)
        
        # Capture LLM context for enrichment
        self._llm_context = scraper.get_llm_context()
        
        if not candidates:
            print(f"    No logo candidates found")
            return None
        
        print(f"    Found {len(candidates)} logo candidates")
        
        for candidate in candidates[:10]:  # Try top 10
            # Handle inline SVGs (no HTTP request needed!)
            if candidate.inline_content and candidate.source == 'inline_svg':
                print(f"    ✓ Using inline SVG (score: {candidate.score:.1f})")
                svg_bytes = candidate.inline_content.encode('utf-8')
                return DiscoveredLogo(
                    source_url=f"inline:{stock_code}",
                    image_data=svg_bytes,
                    format='svg',
                    width=candidate.width,
                    height=candidate.height,
                    quality_score=candidate.score,
                    is_svg=True,
                    svg_data=svg_bytes,
                    inline_svg=candidate.inline_content,
                    llm_context=self._llm_context,
                )
            
            # Handle data URIs (base64 inline images)
            if candidate.inline_content and candidate.url.startswith('data:'):
                print(f"    ✓ Using inline data URI (score: {candidate.score:.1f})")
                # Extract base64 data
                try:
                    _, data_part = candidate.inline_content.split(',', 1)
                    import base64
                    image_data = base64.b64decode(data_part)
                    return DiscoveredLogo(
                        source_url=f"inline:{stock_code}",
                        image_data=image_data,
                        format=candidate.format,
                        quality_score=candidate.score,
                        is_svg=False,
                        llm_context=self._llm_context,
                    )
                except:
                    continue
            
            # Skip other data URLs
            if candidate.url.startswith('data:') or candidate.url.startswith('inline:'):
                continue
            
            # Fetch external logo
            logo = self._fetch_logo(candidate)
            if logo:
                logo.llm_context = self._llm_context
                print(f"    ✓ Downloaded: {candidate.url[:60]}... (format: {logo.format}, score: {candidate.score:.1f})")
                return logo
        
        return None
    
    def get_llm_context(self) -> Optional[str]:
        """Get LLM context from last extraction."""
        return self._llm_context
    
    def _fetch_logo(self, candidate: LogoCandidate) -> Optional[DiscoveredLogo]:
        try:
            response = self.client.get(candidate.url)
            if response.status_code != 200:
                return None
            data = response.content
            if not data:
                return None
            format_ = candidate.format
            content_type = response.headers.get('content-type', '').lower()
            if format_ == 'unknown':
                if 'svg' in content_type: format_ = 'svg'
                elif 'png' in content_type: format_ = 'png'
                elif 'jpeg' in content_type: format_ = 'jpeg'
                elif 'webp' in content_type: format_ = 'webp'
            logo = DiscoveredLogo(
                source_url=candidate.url, image_data=data, format=format_,
                width=candidate.width, height=candidate.height,
                quality_score=candidate.score, is_svg=(format_ == 'svg'),
            )
            if format_ == 'svg':
                logo.svg_data = data
            return logo
        except:
            return None

# ============================================================
# Logo Processing
# ============================================================

def process_logo(logo: DiscoveredLogo, stock_code: str, output_dir: str) -> Dict[str, Any]:
    result = {
        'success': False, 'stock_code': stock_code, 'output_files': [],
        'has_icon': False, 'main_logo_path': None, 'icon_logo_path': None,
        'svg_logo_path': None, 'error': None
    }
    try:
        os.makedirs(output_dir, exist_ok=True)
        
        # Handle SVG - render to PNG first for icon extraction
        if logo.is_svg or logo.format == 'svg':
            svg_data = logo.svg_data if logo.svg_data else logo.image_data
            # Use absolute paths to avoid working directory issues
            abs_output_dir = os.path.abspath(output_dir)
            svg_path = os.path.join(abs_output_dir, f'{stock_code}.svg')
            with open(svg_path, 'wb') as f:
                f.write(svg_data)
            result['output_files'].append(svg_path)
            result['svg_logo_path'] = svg_path
            
            # Render to high-res PNG for logo processor
            try:
                import cairosvg
                png_path = os.path.join(abs_output_dir, f'{stock_code}_input.png')
                cairosvg.svg2png(url=svg_path, write_to=png_path, output_width=512)
                
                # Run logo processor on the rendered PNG for icon extraction
                venv_python = ENRICHMENT_PROCESSOR_DIR / 'venv' / 'bin' / 'python3'
                if LOGO_PROCESSOR_PATH.exists() and venv_python.exists():
                    cmd = [
                        str(venv_python), str(LOGO_PROCESSOR_PATH),
                        '--input', png_path,
                        '--output-dir', abs_output_dir,
                        '--stock-code', stock_code
                    ]
                    proc = subprocess.run(
                        cmd, capture_output=True, text=True,
                        cwd=str(ENRICHMENT_PROCESSOR_DIR), timeout=180
                    )
                    if proc.stdout:
                        for line in proc.stdout.strip().split('\n'):
                            if line.strip().startswith('{'):
                                try:
                                    parsed = json.loads(line)
                                    if parsed.get('success'):
                                        result['success'] = True
                                        result['output_files'] = [svg_path] + parsed.get('output_files', [])
                                        result['has_icon'] = parsed.get('has_icon', False)
                                        for path in parsed.get('output_files', []):
                                            if path.endswith(f'{stock_code}.png') and not path.endswith('_input.png'):
                                                result['main_logo_path'] = path
                                            elif path.endswith(f'{stock_code}_icon.png'):
                                                result['icon_logo_path'] = path
                                    break
                                except:
                                    continue
                    # Clean up input file
                    try:
                        os.unlink(png_path)
                    except:
                        pass
                else:
                    # Fallback: just use the rendered PNG
                    final_png = os.path.join(output_dir, f'{stock_code}.png')
                    os.rename(png_path, final_png)
                    result['output_files'].append(final_png)
                    result['main_logo_path'] = final_png
                    result['success'] = True
            except ImportError:
                print("    ⚠ cairosvg not available")
                result['success'] = len(result['output_files']) > 0
            except Exception as e:
                print(f"    ⚠ SVG processing error: {e}")
                result['success'] = len(result['output_files']) > 0
            
            return result
        
        # Save raster image
        abs_output_dir = os.path.abspath(output_dir)
        with tempfile.NamedTemporaryFile(suffix=f'.{logo.format}', delete=False) as tmp:
            tmp.write(logo.image_data)
            input_path = tmp.name
        
        try:
            # Try logo processor with venv Python
            venv_python = ENRICHMENT_PROCESSOR_DIR / 'venv' / 'bin' / 'python3'
            if LOGO_PROCESSOR_PATH.exists() and venv_python.exists():
                cmd = [
                    str(venv_python), str(LOGO_PROCESSOR_PATH),
                    '--input', input_path,
                    '--output-dir', abs_output_dir,
                    '--stock-code', stock_code
                ]
                
                proc = subprocess.run(
                    cmd, capture_output=True, text=True,
                    cwd=str(ENRICHMENT_PROCESSOR_DIR), timeout=180
                )
                
                if proc.stdout:
                    for line in proc.stdout.strip().split('\n'):
                        if line.strip().startswith('{'):
                            try:
                                parsed = json.loads(line)
                                if parsed.get('success'):
                                    result['success'] = True
                                    result['output_files'] = parsed.get('output_files', [])
                                    result['has_icon'] = parsed.get('has_icon', False)
                                    for path in result['output_files']:
                                        if path.endswith(f'{stock_code}.png') and '_icon' not in path and '_' not in os.path.basename(path).replace(f'{stock_code}.png', ''):
                                            result['main_logo_path'] = path
                                        elif path.endswith(f'{stock_code}_icon.png'):
                                            result['icon_logo_path'] = path
                                else:
                                    result['error'] = parsed.get('error')
                                break
                            except:
                                continue
            else:
                # Fallback: just save the image
                from PIL import Image
                img = Image.open(BytesIO(logo.image_data)).convert('RGBA')
                main_path = os.path.join(output_dir, f'{stock_code}.png')
                img.save(main_path, 'PNG')
                result['success'] = True
                result['output_files'] = [main_path]
                result['main_logo_path'] = main_path
        finally:
            try:
                os.unlink(input_path)
            except:
                pass
    except Exception as e:
        result['error'] = str(e)
    return result

# ============================================================
# GPT Enrichment
# ============================================================

def enrich_company_metadata(company: pd.Series) -> Dict[str, Any]:
    if not OPENAI_API_KEY:
        return {
            'stock_code': company['stock_code'],
            'enrichment_status': 'skipped',
            'enrichment_error': 'OPENAI_API_KEY not set'
        }
    
    client = OpenAI(api_key=OPENAI_API_KEY)
    stock_code = company['stock_code']
    
    system_prompt = """You are a financial analyst specializing in ASX companies.
Return ONLY valid JSON. No markdown. Be specific and factual."""

    user_prompt = f"""
<company_context>
Company Name: {company['company_name']}
Stock Code: {stock_code}
Industry: {company.get('industry', 'N/A')}
Website: {company.get('website', 'N/A')}
Summary: {company.get('summary', 'N/A')}
</company_context>

Return JSON with: tags (5 items), enhanced_summary, company_history, key_people (name, role, bio), competitive_advantages, risk_factors (array), recent_developments, social_media_links
"""
    
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=2000
        )
        raw = response.choices[0].message.content.strip()
        data = json.loads(raw)
        data['stock_code'] = stock_code
        data['enrichment_status'] = 'completed'
        data['enrichment_date'] = datetime.now().isoformat()
        return data
    except Exception as e:
        return {
            'stock_code': stock_code,
            'enrichment_status': 'failed',
            'enrichment_error': str(e)
        }

# ============================================================
# Main Test
# ============================================================

def main():
    import sys
    
    # Allow specifying a stock code via command line
    target_stock = sys.argv[1] if len(sys.argv) > 1 else None
    
    # Fetch one company
    print("\n📊 Fetching company to enrich...")
    engine = create_engine(DATABASE_URL)
    
    if target_stock:
        # Get specific company
        query = f"""
        SELECT stock_code, company_name, industry, website, summary, enrichment_status
        FROM "company-metadata"
        WHERE stock_code = '{target_stock}'
        LIMIT 1
        """
    else:
        # Get a company with a website that hasn't been enriched
        query = """
        SELECT stock_code, company_name, industry, website, summary, enrichment_status
        FROM "company-metadata"
        WHERE website IS NOT NULL AND website != ''
        AND (enrichment_status IS NULL OR enrichment_status = '' OR enrichment_status = 'pending')
        ORDER BY company_name
        LIMIT 1
        """
    df = pd.read_sql(query, engine)
    engine.dispose()
    
    if len(df) == 0:
        print("❌ No companies found that need enrichment")
        return
    
    company = df.iloc[0]
    stock_code = company['stock_code']
    
    print(f"\n{'='*60}")
    print(f"🔍 PROCESSING: {stock_code} - {company['company_name']}")
    print(f"{'='*60}")
    print(f"Industry: {company.get('industry', 'N/A')}")
    print(f"Website: {company.get('website', 'N/A')}")
    print()
    
    result = {
        'stock_code': stock_code,
        'company_name': company['company_name'],
    }
    
    # 1. Logo Discovery
    print("🔍 Phase 1: Logo Discovery")
    logo_discoverer = LogoDiscoverer()
    logo = logo_discoverer.discover_logo(
        company.get('website', ''),
        company['company_name'],
        stock_code
    )
    
    if logo:
        print(f"    ✓ Logo found: {logo.format} ({len(logo.image_data)} bytes)")
        result['logo_discovered'] = True
        result['logo_source_url'] = logo.source_url
        result['logo_format'] = logo.format
        
        # 2. Logo Processing
        print("\n🎨 Phase 2: Logo Processing")
        output_dir = f'data/test_logos/{stock_code}'
        processed = process_logo(logo, stock_code, output_dir)
        
        if processed.get('success'):
            print(f"    ✓ Processed: {len(processed.get('output_files', []))} files")
            print(f"    ✓ Has icon: {processed.get('has_icon')}")
            for f in processed.get('output_files', []):
                print(f"      - {f}")
            result['logo_processed'] = True
            result['logo_files'] = processed.get('output_files', [])
            result['has_icon'] = processed.get('has_icon')
        else:
            print(f"    ✗ Processing failed: {processed.get('error')}")
            result['logo_processed'] = False
            result['logo_error'] = processed.get('error')
    else:
        print("    ✗ No logo found")
        result['logo_discovered'] = False
    
    # 3. GPT Enrichment
    print("\n📝 Phase 3: GPT Metadata Enrichment")
    if OPENAI_API_KEY:
        metadata = enrich_company_metadata(company)
        result['enrichment_status'] = metadata.get('enrichment_status')
        
        if metadata.get('enrichment_status') == 'completed':
            print(f"    ✓ Enrichment completed")
            print(f"    Tags: {metadata.get('tags', [])}")
            summary = metadata.get('enhanced_summary', '')
            if summary:
                print(f"    Summary: {summary[:150]}...")
            result['tags'] = metadata.get('tags')
            result['enhanced_summary'] = metadata.get('enhanced_summary')
            result['key_people'] = metadata.get('key_people')
            result['risk_factors'] = metadata.get('risk_factors')
        else:
            print(f"    ✗ Enrichment failed: {metadata.get('enrichment_error')}")
            result['enrichment_error'] = metadata.get('enrichment_error')
    else:
        print("    ⚠ Skipped (OPENAI_API_KEY not set)")
        result['enrichment_status'] = 'skipped'
    
    # Summary
    print(f"\n{'='*60}")
    print("📊 TEST RESULTS SUMMARY")
    print(f"{'='*60}")
    print(f"Stock Code: {result['stock_code']}")
    print(f"Company: {result['company_name']}")
    print(f"Logo Discovered: {result.get('logo_discovered', False)}")
    print(f"Logo Processed: {result.get('logo_processed', False)}")
    print(f"Has Icon: {result.get('has_icon', False)}")
    print(f"Enrichment Status: {result.get('enrichment_status', 'N/A')}")
    if result.get('tags'):
        print(f"Tags: {result['tags']}")
    print()
    
    # Save results
    results_file = 'data/test_enrichment_result.json'
    os.makedirs('data', exist_ok=True)
    with open(results_file, 'w') as f:
        json.dump(result, f, indent=2, default=str)
    print(f"💾 Results saved to: {results_file}")
    
    return result

if __name__ == '__main__':
    main()
