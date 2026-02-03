#!/usr/bin/env python3
"""
Enhanced Logo Discovery - Multi-Source Logo Fetcher

Extends the existing logo discovery with additional sources:
1. Clearbit Logo API (free, domain-based)
2. Google Favicon Service (fallback)
3. DuckDuckGo Instant Answer API
4. Brand.dev / Logo.dev APIs
5. ASX company profile scraping
6. Wayback Machine for historical logos
7. Better website crawling (press kits, investor pages)

Usage:
    python enhanced_logo_discovery.py --stock CBA
    python enhanced_logo_discovery.py --batch --limit 50
"""
import os
import sys
import json
import time
import hashlib
import argparse
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field, asdict
from urllib.parse import urlparse, urljoin, quote
from concurrent.futures import ThreadPoolExecutor, as_completed
import re

import httpx
from bs4 import BeautifulSoup
from PIL import Image
from io import BytesIO
from sqlalchemy import create_engine, text
from tqdm import tqdm

# Load environment
from dotenv import load_dotenv
load_dotenv()

# Configuration
DATABASE_URL = os.getenv('DATABASE_URL')
GCS_LOGO_BUCKET = 'shorted-company-logos'
OUTPUT_DIR = Path('data/discovered_logos')

# API Keys (optional)
BRANDFETCH_API_KEY = os.getenv('BRANDFETCH_API_KEY', '')

# ============================================================
# Data Classes
# ============================================================

@dataclass
class LogoSource:
    """A discovered logo from any source."""
    url: str
    source: str  # Which API/method found it
    format: str = 'unknown'
    width: int = 0
    height: int = 0
    quality_score: float = 0.0
    is_vector: bool = False
    raw_data: Optional[bytes] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class DiscoveryResult:
    """Complete discovery result for a company."""
    stock_code: str
    company_name: str
    website: str

    # All discovered logos
    logos: List[LogoSource] = field(default_factory=list)

    # Best logo selected
    best_logo: Optional[LogoSource] = None

    # Discovery stats
    sources_checked: List[str] = field(default_factory=list)
    sources_succeeded: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    # Timing
    discovery_time_ms: int = 0


# ============================================================
# Logo Source Fetchers
# ============================================================

class LogoFetcher:
    """Base class for logo fetchers."""

    def __init__(self):
        self.client = httpx.Client(
            timeout=15.0,
            follow_redirects=True,
            headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/*,*/*;q=0.8',
            }
        )

    def get_domain(self, website: str) -> str:
        """Extract domain from website URL."""
        if not website:
            return ''
        if not website.startswith(('http://', 'https://')):
            website = 'https://' + website
        try:
            parsed = urlparse(website)
            return parsed.netloc.lower().replace('www.', '')
        except:
            return ''

    def fetch_image(self, url: str, referer: str = None) -> Optional[bytes]:
        """Fetch image data from URL, optionally with Referer header."""
        try:
            headers = {}
            if referer:
                headers['Referer'] = referer
            response = self.client.get(url, headers=headers)
            if response.status_code == 200:
                content_type = response.headers.get('content-type', '')
                # Make sure we got an image, not an error page
                if 'image' in content_type or len(response.content) > 100:
                    return response.content
            # If 403, try again with referer if we didn't have one
            elif response.status_code == 403 and not referer:
                # Extract domain for referer
                from urllib.parse import urlparse
                parsed = urlparse(url)
                referer_url = f"{parsed.scheme}://{parsed.netloc}/"
                return self.fetch_image(url, referer=referer_url)
        except Exception as e:
            pass
        return None

    def validate_image(self, data: bytes) -> Tuple[bool, int, int, str]:
        """Validate image data and get dimensions."""
        try:
            img = Image.open(BytesIO(data))
            return True, img.width, img.height, img.format.lower() if img.format else 'unknown'
        except:
            return False, 0, 0, 'unknown'

    def close(self):
        self.client.close()


class ClearbitFetcher(LogoFetcher):
    """Clearbit Logo API - free, domain-based."""

    SOURCE_NAME = 'clearbit'
    BASE_URL = 'https://logo.clearbit.com'

    def fetch(self, website: str, company_name: str) -> List[LogoSource]:
        """Fetch logo from Clearbit."""
        logos = []
        domain = self.get_domain(website)
        if not domain:
            return logos

        # Try different sizes
        for size in [512, 256, 128]:
            url = f"{self.BASE_URL}/{domain}?size={size}&format=png"
            try:
                response = self.client.get(url)
                if response.status_code == 200 and len(response.content) > 1000:
                    valid, w, h, fmt = self.validate_image(response.content)
                    if valid and w >= 64:
                        logos.append(LogoSource(
                            url=url,
                            source=self.SOURCE_NAME,
                            format='png',
                            width=w,
                            height=h,
                            quality_score=80 + (size / 10),
                            raw_data=response.content,
                        ))
                        break  # Got one, don't need more sizes
            except:
                pass

        return logos


class GoogleFaviconFetcher(LogoFetcher):
    """Google Favicon Service - for fallback icons."""

    SOURCE_NAME = 'google_favicon'
    BASE_URL = 'https://www.google.com/s2/favicons'

    def fetch(self, website: str, company_name: str) -> List[LogoSource]:
        """Fetch favicon from Google."""
        logos = []
        domain = self.get_domain(website)
        if not domain:
            return logos

        # Get high-res favicon
        url = f"{self.BASE_URL}?domain={domain}&sz=128"
        try:
            response = self.client.get(url)
            if response.status_code == 200 and len(response.content) > 500:
                valid, w, h, fmt = self.validate_image(response.content)
                if valid and w >= 32:
                    logos.append(LogoSource(
                        url=url,
                        source=self.SOURCE_NAME,
                        format=fmt,
                        width=w,
                        height=h,
                        quality_score=40,  # Lower score - favicon quality
                        raw_data=response.content,
                    ))
        except:
            pass

        return logos


class DuckDuckGoFetcher(LogoFetcher):
    """DuckDuckGo Instant Answer API - sometimes has logos."""

    SOURCE_NAME = 'duckduckgo'
    API_URL = 'https://api.duckduckgo.com'

    def fetch(self, website: str, company_name: str) -> List[LogoSource]:
        """Fetch logo from DuckDuckGo."""
        logos = []
        if not company_name:
            return logos

        # Search for company
        params = {
            'q': f'{company_name} company',
            'format': 'json',
            'no_html': '1',
            'skip_disambig': '1',
        }

        try:
            response = self.client.get(self.API_URL, params=params)
            if response.status_code == 200:
                data = response.json()

                # Check for image in response
                image_url = data.get('Image', '')
                if image_url and not image_url.endswith('.svg'):
                    # Make absolute URL
                    if image_url.startswith('//'):
                        image_url = 'https:' + image_url
                    elif image_url.startswith('/'):
                        image_url = 'https://duckduckgo.com' + image_url

                    img_data = self.fetch_image(image_url)
                    if img_data:
                        valid, w, h, fmt = self.validate_image(img_data)
                        if valid and w >= 64:
                            logos.append(LogoSource(
                                url=image_url,
                                source=self.SOURCE_NAME,
                                format=fmt,
                                width=w,
                                height=h,
                                quality_score=60,
                                raw_data=img_data,
                            ))
        except:
            pass

        return logos


class ASXProfileFetcher(LogoFetcher):
    """ASX Company Profile - scrape logos from ASX website."""

    SOURCE_NAME = 'asx_profile'
    BASE_URL = 'https://www2.asx.com.au/markets/company'

    def fetch(self, website: str, company_name: str, stock_code: str = '') -> List[LogoSource]:
        """Fetch logo from ASX company profile."""
        logos = []
        if not stock_code:
            return logos

        url = f"{self.BASE_URL}/{stock_code.upper()}"
        try:
            response = self.client.get(url)
            if response.status_code == 200:
                soup = BeautifulSoup(response.content, 'html.parser')

                # Look for company logo in the profile
                for img in soup.find_all('img'):
                    src = img.get('src', '')
                    alt = img.get('alt', '').lower()
                    classes = ' '.join(img.get('class', []))

                    # Check if it's a company logo
                    if ('logo' in src.lower() or 'logo' in alt or 'company' in classes.lower()):
                        if src.startswith('/'):
                            src = 'https://www2.asx.com.au' + src
                        elif not src.startswith('http'):
                            src = urljoin(url, src)

                        img_data = self.fetch_image(src)
                        if img_data:
                            valid, w, h, fmt = self.validate_image(img_data)
                            if valid and w >= 48:
                                logos.append(LogoSource(
                                    url=src,
                                    source=self.SOURCE_NAME,
                                    format=fmt,
                                    width=w,
                                    height=h,
                                    quality_score=70,
                                    raw_data=img_data,
                                ))
        except:
            pass

        return logos


class WebsiteCrawler(LogoFetcher):
    """Enhanced website crawler - checks multiple pages."""

    SOURCE_NAME = 'website_crawl'

    # Pages to check
    PAGES_TO_CHECK = [
        '',  # Homepage
        '/about', '/about-us', '/about-us/', '/company',
        '/brand', '/brand-assets', '/media', '/media-kit', '/press',
        '/investors', '/investor-relations', '/corporate',
        '/contact', '/logos', '/assets',
    ]

    # Logo indicators in URLs/classes/IDs
    LOGO_INDICATORS = ['logo', 'brand', 'mark', 'emblem', 'identity']

    def fetch(self, website: str, company_name: str) -> List[LogoSource]:
        """Crawl website for logos."""
        logos = []
        if not website:
            return logos

        base_url = website if website.startswith('http') else f'https://{website}'
        base_url = base_url.rstrip('/')

        seen_urls = set()

        for page_path in self.PAGES_TO_CHECK[:8]:  # Limit pages
            page_url = base_url + page_path
            try:
                response = self.client.get(page_url)
                # Accept 200, or 403 if it has HTML content (some sites block but serve content)
                content_type = response.headers.get('content-type', '')
                if response.status_code == 200 or (response.status_code == 403 and 'text/html' in content_type and len(response.content) > 1000):
                    pass  # Continue processing
                else:
                    continue

                soup = BeautifulSoup(response.content, 'html.parser')

                # Extract logos from this page
                page_logos = self._extract_logos(soup, page_url, base_url, seen_urls)
                logos.extend(page_logos)

            except Exception as e:
                pass

        return logos

    def _extract_logos(self, soup: BeautifulSoup, page_url: str, base_url: str, seen_urls: set) -> List[LogoSource]:
        """Extract logo candidates from HTML."""
        logos = []

        # 1. Check <img> tags
        for img in soup.find_all('img'):
            src = img.get('src') or img.get('data-src') or ''
            if not src or src.startswith('data:'):
                continue

            src = urljoin(page_url, src)
            if src in seen_urls:
                continue

            # Score this image
            score = self._score_img(img, src)
            if score > 20:
                seen_urls.add(src)
                img_data = self.fetch_image(src, referer=page_url)
                if img_data:
                    valid, w, h, fmt = self.validate_image(img_data)
                    if valid and w >= 48:
                        logos.append(LogoSource(
                            url=src,
                            source=self.SOURCE_NAME,
                            format=fmt,
                            width=w,
                            height=h,
                            quality_score=score,
                            raw_data=img_data,
                            metadata={'page': page_url}
                        ))

        # 2. Check inline SVGs
        for svg in soup.find_all('svg'):
            classes = ' '.join(svg.get('class', []))
            svg_id = svg.get('id', '')

            if any(ind in classes.lower() or ind in svg_id.lower() for ind in self.LOGO_INDICATORS):
                svg_content = str(svg)
                if len(svg_content) > 200:  # Not a tiny icon
                    svg_hash = hashlib.md5(svg_content.encode()).hexdigest()[:8]
                    if svg_hash not in seen_urls:
                        seen_urls.add(svg_hash)
                        logos.append(LogoSource(
                            url=f'inline:svg:{svg_hash}',
                            source=self.SOURCE_NAME + '_svg',
                            format='svg',
                            quality_score=85,
                            is_vector=True,
                            raw_data=svg_content.encode('utf-8'),
                            metadata={'page': page_url}
                        ))

        # 3. Check meta tags
        og_image = soup.find('meta', property='og:image')
        if og_image and og_image.get('content'):
            src = urljoin(page_url, og_image['content'])
            if src not in seen_urls:
                seen_urls.add(src)
                img_data = self.fetch_image(src, referer=page_url)
                if img_data:
                    valid, w, h, fmt = self.validate_image(img_data)
                    if valid:
                        logos.append(LogoSource(
                            url=src,
                            source=self.SOURCE_NAME + '_og',
                            format=fmt,
                            width=w,
                            height=h,
                            quality_score=50,
                            raw_data=img_data,
                        ))

        # 4. Check favicons
        for link in soup.find_all('link', rel=lambda x: x and ('icon' in x if isinstance(x, str) else any('icon' in r for r in x))):
            href = link.get('href', '')
            if href:
                src = urljoin(page_url, href)
                if src not in seen_urls:
                    seen_urls.add(src)
                    sizes = link.get('sizes', '')
                    # Prefer larger icons
                    if sizes and 'x' in sizes:
                        try:
                            size = int(sizes.split('x')[0])
                            if size >= 128:
                                img_data = self.fetch_image(src, referer=page_url)
                                if img_data:
                                    valid, w, h, fmt = self.validate_image(img_data)
                                    if valid:
                                        logos.append(LogoSource(
                                            url=src,
                                            source=self.SOURCE_NAME + '_favicon',
                                            format=fmt,
                                            width=w,
                                            height=h,
                                            quality_score=45,
                                            raw_data=img_data,
                                        ))
                        except:
                            pass

        return logos

    def _score_img(self, img, src: str) -> float:
        """Score an image for likelihood of being a logo."""
        score = 0.0

        src_lower = src.lower()
        alt = img.get('alt', '').lower()
        classes = ' '.join(img.get('class', [])).lower()
        img_id = img.get('id', '').lower()

        # Check for logo keywords
        all_text = f"{src_lower} {alt} {classes} {img_id}"
        for ind in self.LOGO_INDICATORS:
            if ind in all_text:
                score += 30
                break

        # Check parent elements
        parent = img.parent
        while parent and parent.name:
            if parent.name in ['header', 'nav']:
                score += 20
                break
            parent_classes = ' '.join(parent.get('class', [])).lower()
            if any(ind in parent_classes for ind in self.LOGO_INDICATORS):
                score += 15
                break
            parent = parent.parent

        # Bonus for SVG format
        if src_lower.endswith('.svg'):
            score += 15

        # Penalty for small explicit dimensions
        width = img.get('width', '')
        height = img.get('height', '')
        try:
            if width and int(width) < 32:
                score -= 20
            if height and int(height) < 32:
                score -= 20
        except:
            pass

        return score


# ============================================================
# Main Discovery Engine
# ============================================================

class EnhancedLogoDiscovery:
    """Multi-source logo discovery engine."""

    def __init__(self):
        self.fetchers = [
            ('clearbit', ClearbitFetcher()),
            ('website', WebsiteCrawler()),
            ('google_favicon', GoogleFaviconFetcher()),
            ('duckduckgo', DuckDuckGoFetcher()),
            ('asx', ASXProfileFetcher()),
        ]

    def discover(self, stock_code: str, company_name: str, website: str) -> DiscoveryResult:
        """Discover logos from all sources."""
        start_time = time.time()

        result = DiscoveryResult(
            stock_code=stock_code,
            company_name=company_name,
            website=website,
        )

        for source_name, fetcher in self.fetchers:
            result.sources_checked.append(source_name)
            try:
                if source_name == 'asx':
                    logos = fetcher.fetch(website, company_name, stock_code)
                else:
                    logos = fetcher.fetch(website, company_name)

                if logos:
                    result.sources_succeeded.append(source_name)
                    result.logos.extend(logos)
            except Exception as e:
                result.errors.append(f"{source_name}: {str(e)}")

        # Sort by quality score and select best
        result.logos.sort(key=lambda x: x.quality_score, reverse=True)
        if result.logos:
            # Prefer vector logos, then highest quality raster
            vector_logos = [l for l in result.logos if l.is_vector]
            if vector_logos:
                result.best_logo = vector_logos[0]
            else:
                # Prefer larger images
                large_logos = [l for l in result.logos if l.width >= 128]
                if large_logos:
                    result.best_logo = large_logos[0]
                else:
                    result.best_logo = result.logos[0]

        result.discovery_time_ms = int((time.time() - start_time) * 1000)
        return result

    def close(self):
        for _, fetcher in self.fetchers:
            fetcher.close()


# ============================================================
# Database Integration
# ============================================================

def get_companies_needing_logos(limit: int = 50) -> List[Dict]:
    """Get companies that need logo discovery."""
    engine = create_engine(DATABASE_URL)

    query = text("""
        WITH latest_shorts AS (
            SELECT DISTINCT ON ("PRODUCT_CODE")
                "PRODUCT_CODE" as code,
                "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as short_pct
            FROM shorts
            WHERE "DATE" >= (CURRENT_DATE - INTERVAL '60 days')
            ORDER BY "PRODUCT_CODE", "DATE" DESC
        )
        SELECT
            cm.stock_code,
            cm.company_name,
            cm.website,
            COALESCE(ls.short_pct, 0) as short_pct
        FROM "company-metadata" cm
        LEFT JOIN latest_shorts ls ON cm.stock_code = ls.code
        WHERE (cm.logo_gcs_url IS NULL OR cm.logo_gcs_url = '')
          AND cm.website IS NOT NULL AND cm.website != ''
          AND cm.enrichment_status IN ('pending', 'completed')
          AND cm.company_name NOT ILIKE '%etf%'
          AND cm.company_name NOT ILIKE '%units%'
        ORDER BY COALESCE(ls.short_pct, 0) DESC
        LIMIT :limit
    """)

    with engine.connect() as conn:
        result = conn.execute(query, {'limit': limit})
        companies = [
            {
                'stock_code': row[0],
                'company_name': row[1],
                'website': row[2],
                'short_pct': row[3],
            }
            for row in result
        ]

    engine.dispose()
    return companies


def save_discovery_result(result: DiscoveryResult, output_dir: Path):
    """Save discovery result to disk."""
    stock_dir = output_dir / result.stock_code
    stock_dir.mkdir(parents=True, exist_ok=True)

    # Save metadata
    meta = {
        'stock_code': result.stock_code,
        'company_name': result.company_name,
        'website': result.website,
        'sources_checked': result.sources_checked,
        'sources_succeeded': result.sources_succeeded,
        'errors': result.errors,
        'discovery_time_ms': result.discovery_time_ms,
        'logos_found': len(result.logos),
        'best_logo_source': result.best_logo.source if result.best_logo else None,
        'best_logo_format': result.best_logo.format if result.best_logo else None,
        'best_logo_score': result.best_logo.quality_score if result.best_logo else None,
    }

    with open(stock_dir / 'discovery.json', 'w') as f:
        json.dump(meta, f, indent=2)

    # Save best logo
    if result.best_logo and result.best_logo.raw_data:
        ext = result.best_logo.format if result.best_logo.format != 'unknown' else 'png'
        logo_path = stock_dir / f'{result.stock_code}.{ext}'
        with open(logo_path, 'wb') as f:
            f.write(result.best_logo.raw_data)
        return logo_path

    return None


def upload_to_gcs(logo_path: Path, stock_code: str) -> Optional[str]:
    """Upload logo to GCS and return public URL."""
    try:
        from google.cloud import storage

        client = storage.Client()
        bucket = client.bucket(GCS_LOGO_BUCKET)

        # Convert to PNG for consistency
        img = Image.open(logo_path)
        if img.mode in ('RGBA', 'LA', 'P'):
            # Handle transparency - composite on white or keep alpha
            pass

        # Upload as PNG
        blob_name = f'logos/{stock_code}.png'
        blob = bucket.blob(blob_name)

        # Convert to PNG in memory
        from io import BytesIO
        buffer = BytesIO()
        img.convert('RGBA').save(buffer, format='PNG', optimize=True)
        buffer.seek(0)

        blob.upload_from_file(buffer, content_type='image/png')
        blob.make_public()

        return f'https://storage.googleapis.com/{GCS_LOGO_BUCKET}/{blob_name}'

    except ImportError:
        print("    ⚠️  google-cloud-storage not installed, skipping GCS upload")
        return None
    except Exception as e:
        print(f"    ⚠️  GCS upload failed: {e}")
        return None


def update_database_logo(stock_code: str, logo_url: str):
    """Update logo_gcs_url in database."""
    engine = create_engine(DATABASE_URL)

    query = text("""
        UPDATE "company-metadata"
        SET logo_gcs_url = :logo_url
        WHERE stock_code = :stock_code
    """)

    try:
        with engine.connect() as conn:
            conn.execute(query, {'logo_url': logo_url, 'stock_code': stock_code})
            conn.commit()
        return True
    except Exception as e:
        print(f"    ⚠️  Database update failed: {e}")
        return False
    finally:
        engine.dispose()


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description='Enhanced Logo Discovery')
    parser.add_argument('--stock', help='Single stock code to process')
    parser.add_argument('--batch', action='store_true', help='Process batch of stocks')
    parser.add_argument('--limit', type=int, default=50, help='Batch size limit')
    parser.add_argument('--output', type=str, default='data/discovered_logos', help='Output directory')
    parser.add_argument('--upload', action='store_true', help='Upload discovered logos to GCS')
    parser.add_argument('--update-db', action='store_true', help='Update database with logo URLs')
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    discoverer = EnhancedLogoDiscovery()

    try:
        if args.stock:
            # Single stock mode
            engine = create_engine(DATABASE_URL)
            query = text("""
                SELECT stock_code, company_name, website
                FROM "company-metadata"
                WHERE stock_code = :code
            """)
            with engine.connect() as conn:
                row = conn.execute(query, {'code': args.stock.upper()}).fetchone()
            engine.dispose()

            if not row:
                print(f"Stock {args.stock} not found")
                return

            company = {'stock_code': row[0], 'company_name': row[1], 'website': row[2]}
            print(f"\n{'='*60}")
            print(f"Discovering logos for: {company['stock_code']} - {company['company_name']}")
            print(f"Website: {company['website']}")
            print('='*60)

            result = discoverer.discover(
                company['stock_code'],
                company['company_name'],
                company['website']
            )

            print(f"\nResults:")
            print(f"  Sources checked: {result.sources_checked}")
            print(f"  Sources succeeded: {result.sources_succeeded}")
            print(f"  Logos found: {len(result.logos)}")
            print(f"  Discovery time: {result.discovery_time_ms}ms")

            if result.best_logo:
                print(f"\n  Best logo:")
                print(f"    Source: {result.best_logo.source}")
                print(f"    Format: {result.best_logo.format}")
                print(f"    Size: {result.best_logo.width}x{result.best_logo.height}")
                print(f"    Score: {result.best_logo.quality_score}")

                logo_path = save_discovery_result(result, output_dir)
                if logo_path:
                    print(f"    Saved to: {logo_path}")
            else:
                print("\n  No logo found!")

            if result.errors:
                print(f"\n  Errors: {result.errors}")

        elif args.batch:
            # Batch mode
            print(f"\n{'='*60}")
            print(f"BATCH LOGO DISCOVERY")
            print(f"{'='*60}")
            if args.upload:
                print(f"Mode: DISCOVER + UPLOAD TO GCS")
            if args.update_db:
                print(f"Mode: UPDATE DATABASE")

            companies = get_companies_needing_logos(args.limit)
            print(f"Found {len(companies)} companies needing logos\n")

            stats = {
                'processed': 0,
                'logos_found': 0,
                'uploaded': 0,
                'db_updated': 0,
                'no_logo': 0,
                'errors': 0,
            }

            for company in tqdm(companies, desc="Discovering logos"):
                try:
                    result = discoverer.discover(
                        company['stock_code'],
                        company['company_name'],
                        company['website']
                    )
                    stats['processed'] += 1

                    if result.best_logo:
                        stats['logos_found'] += 1
                        logo_path = save_discovery_result(result, output_dir)
                        msg = f"  ✓ {company['stock_code']}: {result.best_logo.source} ({result.best_logo.format})"

                        # Upload to GCS if requested
                        if args.upload and logo_path:
                            gcs_url = upload_to_gcs(logo_path, company['stock_code'])
                            if gcs_url:
                                stats['uploaded'] += 1
                                msg += f" → GCS"

                                # Update database if requested
                                if args.update_db:
                                    if update_database_logo(company['stock_code'], gcs_url):
                                        stats['db_updated'] += 1
                                        msg += f" → DB"

                        tqdm.write(msg)
                    else:
                        stats['no_logo'] += 1
                        tqdm.write(f"  ✗ {company['stock_code']}: No logo found")

                except Exception as e:
                    stats['errors'] += 1
                    tqdm.write(f"  ✗ {company['stock_code']}: Error - {e}")

            print(f"\n{'='*60}")
            print(f"SUMMARY")
            print(f"{'='*60}")
            print(f"Processed: {stats['processed']}")
            print(f"Logos found: {stats['logos_found']}")
            if args.upload:
                print(f"Uploaded to GCS: {stats['uploaded']}")
            if args.update_db:
                print(f"Database updated: {stats['db_updated']}")
            print(f"No logo: {stats['no_logo']}")
            print(f"Errors: {stats['errors']}")
            print(f"\nLogos saved to: {output_dir}")

        else:
            parser.print_help()

    finally:
        discoverer.close()


if __name__ == '__main__':
    main()
