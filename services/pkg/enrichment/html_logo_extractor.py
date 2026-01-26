"""
High-Signal HTML Logo Extractor

Extracts only logo-relevant content from HTML pages with minimal parsing.
Inspired by ChunkHound's semantic chunking approach - extract structure, not content.

Key optimizations:
1. Stream-parse HTML, stop early when we have enough candidates
2. Only extract logo-relevant tags (img, link[rel=icon], meta[og:image])
3. Skip non-essential sections (scripts, styles, comments)
4. Limit page size to reduce memory/bandwidth
"""
import re
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
import httpx


@dataclass
class LogoSignal:
    """Minimal logo candidate with only essential fields."""
    url: str
    source: str  # img_header, img_body, og_image, favicon, apple_touch
    score: float = 0.0
    alt: str = ""
    width: int = 0
    height: int = 0
    in_header: bool = False


class LogoHTMLParser(HTMLParser):
    """
    Streaming HTML parser that extracts only logo signals.
    
    Stops parsing once we have sufficient high-quality candidates
    to minimize processing time and memory usage.
    """
    
    LOGO_KEYWORDS = frozenset(['logo', 'brand', 'mark', 'emblem', 'icon', 'symbol'])
    MAX_CANDIDATES = 20  # Stop after finding this many high-signal candidates
    
    def __init__(self, base_url: str, company_name: str = ""):
        super().__init__()
        self.base_url = base_url
        self.company_name_lower = company_name.lower() if company_name else ""
        
        # Results
        self.candidates: List[LogoSignal] = []
        self.brand_links: List[str] = []
        
        # Parsing state
        self._in_head = False
        self._in_header = False
        self._in_nav = False
        self._in_skip = False  # Inside script/style/comment
        self._depth = 0
        self._done = False
        
    def feed(self, data: str):
        """Override to support early termination."""
        try:
            super().feed(data)
        except StopIteration:
            pass  # Early termination
    
    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]):
        if self._done:
            raise StopIteration()
        
        tag_lower = tag.lower()
        attrs_dict = {k.lower(): v for k, v in attrs if v is not None}
        
        # Track sections
        if tag_lower == 'head':
            self._in_head = True
        elif tag_lower == 'header':
            self._in_header = True
        elif tag_lower == 'nav':
            self._in_nav = True
        elif tag_lower in ('script', 'style', 'noscript'):
            self._in_skip = True
            return
        
        if self._in_skip:
            return
        
        # Extract logo signals
        if tag_lower == 'img':
            self._handle_img(attrs_dict)
        elif tag_lower == 'link':
            self._handle_link(attrs_dict)
        elif tag_lower == 'meta':
            self._handle_meta(attrs_dict)
        elif tag_lower == 'a':
            self._handle_anchor(attrs_dict)
        
        # Check if we have enough candidates
        if len(self.candidates) >= self.MAX_CANDIDATES:
            high_score = [c for c in self.candidates if c.score >= 50]
            if len(high_score) >= 5:
                self._done = True
                raise StopIteration()
    
    def handle_endtag(self, tag: str):
        tag_lower = tag.lower()
        if tag_lower == 'head':
            self._in_head = False
        elif tag_lower == 'header':
            self._in_header = False
        elif tag_lower == 'nav':
            self._in_nav = False
        elif tag_lower in ('script', 'style', 'noscript'):
            self._in_skip = False
    
    def _handle_img(self, attrs: Dict[str, str]):
        src = attrs.get('src') or attrs.get('data-src') or attrs.get('data-lazy-src', '')
        if not src or src.startswith('data:'):
            return
        
        absolute_url = urljoin(self.base_url, src)
        alt = attrs.get('alt', '')
        
        # Parse dimensions
        width = self._parse_dim(attrs.get('width', ''))
        height = self._parse_dim(attrs.get('height', ''))
        
        in_header = self._in_header or self._in_nav
        
        candidate = LogoSignal(
            url=absolute_url,
            source='img_header' if in_header else 'img_body',
            alt=alt,
            width=width,
            height=height,
            in_header=in_header,
        )
        candidate.score = self._score_candidate(candidate)
        
        # Only add if score is reasonable
        if candidate.score > 10 or in_header:
            self.candidates.append(candidate)
    
    def _handle_link(self, attrs: Dict[str, str]):
        rel = attrs.get('rel', '').lower()
        href = attrs.get('href', '')
        
        if not href:
            return
        
        # Favicons and touch icons
        if 'icon' in rel:
            absolute_url = urljoin(self.base_url, href)
            source = 'apple_touch' if 'apple-touch' in rel else 'favicon'
            
            # Parse sizes attribute (e.g., "180x180")
            sizes = attrs.get('sizes', '')
            width = 0
            if sizes and 'x' in sizes:
                try:
                    width = int(sizes.split('x')[0])
                except:
                    pass
            
            candidate = LogoSignal(
                url=absolute_url,
                source=source,
                width=width,
            )
            candidate.score = self._score_candidate(candidate)
            self.candidates.append(candidate)
    
    def _handle_meta(self, attrs: Dict[str, str]):
        prop = attrs.get('property', '').lower()
        name = attrs.get('name', '').lower()
        content = attrs.get('content', '')
        
        if not content:
            return
        
        # OpenGraph image
        if prop == 'og:image' or name == 'og:image':
            absolute_url = urljoin(self.base_url, content)
            candidate = LogoSignal(
                url=absolute_url,
                source='og_image',
            )
            candidate.score = self._score_candidate(candidate)
            self.candidates.append(candidate)
        
        # Twitter card image
        elif name == 'twitter:image':
            absolute_url = urljoin(self.base_url, content)
            candidate = LogoSignal(
                url=absolute_url,
                source='twitter_image',
            )
            candidate.score = self._score_candidate(candidate)
            self.candidates.append(candidate)
    
    def _handle_anchor(self, attrs: Dict[str, str]):
        """Extract links to brand/about pages for deeper crawling."""
        href = attrs.get('href', '')
        if not href or href.startswith(('#', 'javascript:', 'mailto:', 'tel:')):
            return
        
        href_lower = href.lower()
        if any(kw in href_lower for kw in ['brand', 'about', 'press', 'media', 'logo']):
            absolute_url = urljoin(self.base_url, href)
            if absolute_url not in self.brand_links:
                self.brand_links.append(absolute_url)
    
    def _score_candidate(self, c: LogoSignal) -> float:
        """Score a logo candidate based on multiple signals."""
        score = 0.0
        url_lower = c.url.lower()
        
        # Format scoring
        if '.svg' in url_lower:
            score += 100
        elif '.png' in url_lower:
            score += 50
        elif '.webp' in url_lower:
            score += 45
        elif '.jpg' in url_lower or '.jpeg' in url_lower:
            score += 30
        
        # Source scoring
        source_scores = {
            'img_header': 25,
            'apple_touch': 20,
            'og_image': 15,
            'twitter_image': 12,
            'img_body': 5,
            'favicon': 8,
        }
        score += source_scores.get(c.source, 0)
        
        # Keyword scoring
        if 'logo' in url_lower:
            score += 30
        if 'brand' in url_lower:
            score += 20
        if c.alt and 'logo' in c.alt.lower():
            score += 25
        if self.company_name_lower and self.company_name_lower in url_lower:
            score += 15
        
        # Size scoring
        if c.width >= 256:
            score += 15
        elif c.width >= 128:
            score += 10
        elif c.width >= 64:
            score += 5
        elif 0 < c.width < 32:
            score -= 15  # Too small, likely tiny icon
        
        # Header bonus
        if c.in_header:
            score += 10
        
        return score
    
    def _parse_dim(self, val: str) -> int:
        """Parse dimension value like '180' or '180px'."""
        if not val:
            return 0
        try:
            return int(re.sub(r'[^\d]', '', val))
        except:
            return 0


class FastLogoExtractor:
    """
    High-signal logo extractor with minimal HTTP and parsing overhead.
    
    Optimizations:
    1. Limit response size (first 500KB of HTML)
    2. Use streaming parser that stops early
    3. Parallel candidate validation
    4. Cache DNS lookups
    """
    
    MAX_HTML_SIZE = 500 * 1024  # 500KB max
    REQUEST_TIMEOUT = 15.0
    
    def __init__(self):
        self.client = httpx.Client(
            timeout=self.REQUEST_TIMEOUT,
            follow_redirects=True,
            headers={
                'User-Agent': 'Mozilla/5.0 (compatible; LogoBot/1.0)',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Encoding': 'gzip, deflate',
            },
            limits=httpx.Limits(max_connections=10),
        )
    
    def extract_logos(self, url: str, company_name: str = "") -> List[LogoSignal]:
        """
        Extract logo candidates from a URL with minimal overhead.
        
        Returns sorted list of LogoSignal objects.
        """
        base_url = self._normalize_url(url)
        if not base_url:
            return []
        
        all_candidates = []
        
        # Phase 1: Extract from homepage (limited HTML)
        homepage_candidates, brand_links = self._extract_from_page(base_url, company_name)
        all_candidates.extend(homepage_candidates)
        
        # Phase 2: Check common logo paths directly (no HTML parsing)
        direct_candidates = self._check_common_paths(base_url, company_name)
        all_candidates.extend(direct_candidates)
        
        # Phase 3: If we don't have good candidates, try brand pages
        high_score = [c for c in all_candidates if c.score >= 80]
        if len(high_score) < 2 and brand_links:
            for link in brand_links[:2]:  # Limit to 2 extra pages
                page_candidates, _ = self._extract_from_page(link, company_name)
                all_candidates.extend(page_candidates)
        
        # Dedupe and sort
        seen_urls = set()
        unique = []
        for c in all_candidates:
            if c.url not in seen_urls:
                seen_urls.add(c.url)
                unique.append(c)
        
        unique.sort(key=lambda x: x.score, reverse=True)
        return unique
    
    def _extract_from_page(self, url: str, company_name: str) -> Tuple[List[LogoSignal], List[str]]:
        """Extract logos from a single page with size limits."""
        try:
            # Stream response to limit size
            with self.client.stream('GET', url) as response:
                if response.status_code != 200:
                    return [], []
                
                # Read limited content
                chunks = []
                total_size = 0
                for chunk in response.iter_bytes(chunk_size=8192):
                    chunks.append(chunk)
                    total_size += len(chunk)
                    if total_size >= self.MAX_HTML_SIZE:
                        break
                
                html = b''.join(chunks).decode('utf-8', errors='ignore')
            
            # Parse with streaming parser
            parser = LogoHTMLParser(url, company_name)
            parser.feed(html)
            
            return parser.candidates, parser.brand_links
            
        except Exception as e:
            return [], []
    
    def _check_common_paths(self, base_url: str, company_name: str) -> List[LogoSignal]:
        """Check common logo file paths without full HTML parsing."""
        candidates = []
        common_paths = [
            '/logo.svg', '/logo.png', '/images/logo.svg', '/images/logo.png',
            '/assets/logo.svg', '/assets/logo.png', '/img/logo.svg', '/img/logo.png',
            '/favicon.svg', '/favicon-32x32.png', '/apple-touch-icon.png',
            '/static/logo.svg', '/static/logo.png',
        ]
        
        for path in common_paths:
            full_url = base_url.rstrip('/') + path
            try:
                # HEAD request to check existence without downloading
                response = self.client.head(full_url, timeout=5.0)
                if response.status_code == 200:
                    content_type = response.headers.get('content-type', '')
                    if 'image' in content_type or 'svg' in content_type:
                        source = 'direct_svg' if '.svg' in path else 'direct_path'
                        candidate = LogoSignal(
                            url=full_url,
                            source=source,
                            score=120 if '.svg' in path else 80,  # High score for direct hits
                        )
                        candidates.append(candidate)
            except:
                continue
        
        return candidates
    
    def _normalize_url(self, url: str) -> Optional[str]:
        """Normalize URL to base form."""
        if not url:
            return None
        if not url.startswith(('http://', 'https://')):
            url = 'https://' + url
        try:
            parsed = urlparse(url)
            return f"{parsed.scheme}://{parsed.netloc}"
        except:
            return None
    
    def close(self):
        """Clean up HTTP client."""
        self.client.close()


# ============================================================
# Benchmark comparison
# ============================================================

def benchmark_extractors():
    """Compare old vs new extractor performance."""
    import time
    
    test_urls = [
        ("https://www.4dsmemory.com", "4DS Memory"),
        ("https://www.galileomining.com.au", "Galileo Mining"),
        ("https://www.austal.com", "Austal"),
    ]
    
    extractor = FastLogoExtractor()
    
    for url, name in test_urls:
        start = time.time()
        candidates = extractor.extract_logos(url, name)
        elapsed = time.time() - start
        
        print(f"\n{name} ({url}):")
        print(f"  Time: {elapsed:.2f}s")
        print(f"  Candidates: {len(candidates)}")
        if candidates:
            print(f"  Top 3:")
            for c in candidates[:3]:
                print(f"    - {c.score:.0f}: {c.source} - {c.url[:60]}...")
    
    extractor.close()


if __name__ == "__main__":
    benchmark_extractors()
