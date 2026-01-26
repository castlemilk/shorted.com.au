"""
HTML Intelligence Layer - High-Signal Content Extraction

This is the critical layer for logo discovery and company enrichment.
Extracts ALL relevant signals from HTML to inform both:
1. Direct logo extraction (find and score logo candidates)
2. LLM enrichment (provide structured context for better analysis)

Key extraction categories:
- Structured data (Schema.org, JSON-LD, microdata)
- Logo signals (images, SVGs, favicons, CSS backgrounds)
- Company metadata (OpenGraph, Twitter cards, meta tags)
- Layout context (header/footer/nav structure)
- Asset manifests (manifest.json, browserconfig.xml)
"""
import re
import json
import base64
from typing import List, Dict, Any, Optional, Tuple, Set
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, parse_qs
import httpx
from io import StringIO
import cssutils
import logging

# Suppress cssutils logging
cssutils.log.setLevel(logging.CRITICAL)


# ============================================================
# Data Structures
# ============================================================

@dataclass
class LogoCandidate:
    """Rich logo candidate with all extraction signals."""
    url: str
    source: str  # Where it was found
    score: float = 0.0
    
    # Image metadata
    format: str = "unknown"
    width: int = 0
    height: int = 0
    alt: str = ""
    title: str = ""
    
    # Context signals
    in_header: bool = False
    in_footer: bool = False
    in_nav: bool = False
    css_classes: List[str] = field(default_factory=list)
    css_ids: List[str] = field(default_factory=list)
    parent_classes: List[str] = field(default_factory=list)
    
    # Content (for inline SVGs)
    inline_content: Optional[str] = None
    
    # Scoring breakdown
    score_breakdown: Dict[str, float] = field(default_factory=dict)


@dataclass 
class CompanyMetadata:
    """Structured company information extracted from HTML."""
    # Basic info
    name: Optional[str] = None
    description: Optional[str] = None
    tagline: Optional[str] = None
    
    # Structured data
    schema_org: Dict[str, Any] = field(default_factory=dict)
    json_ld: List[Dict[str, Any]] = field(default_factory=list)
    
    # OpenGraph
    og_title: Optional[str] = None
    og_description: Optional[str] = None
    og_image: Optional[str] = None
    og_site_name: Optional[str] = None
    og_type: Optional[str] = None
    
    # Twitter
    twitter_title: Optional[str] = None
    twitter_description: Optional[str] = None
    twitter_image: Optional[str] = None
    twitter_site: Optional[str] = None
    
    # Contact/Social
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    social_links: Dict[str, str] = field(default_factory=dict)
    
    # Navigation
    about_url: Optional[str] = None
    contact_url: Optional[str] = None
    press_url: Optional[str] = None
    investor_url: Optional[str] = None


@dataclass
class HTMLIntelligence:
    """Complete extraction result from HTML analysis."""
    url: str
    
    # Logo candidates (sorted by score)
    logo_candidates: List[LogoCandidate] = field(default_factory=list)
    
    # Company metadata
    metadata: CompanyMetadata = field(default_factory=CompanyMetadata)
    
    # Manifest/config files to fetch
    manifest_urls: List[str] = field(default_factory=list)
    
    # Brand-related pages to crawl
    brand_pages: List[str] = field(default_factory=list)
    
    # Raw signals for LLM context
    page_title: Optional[str] = None
    meta_keywords: List[str] = field(default_factory=list)
    heading_hierarchy: List[str] = field(default_factory=list)  # h1, h2, h3 text
    
    # Extraction stats
    stats: Dict[str, int] = field(default_factory=dict)


# ============================================================
# CSS Background Image Extractor
# ============================================================

class CSSBackgroundExtractor:
    """Extract background-image URLs from inline and linked CSS."""
    
    # Regex for background-image in CSS
    BG_IMAGE_PATTERN = re.compile(
        r'background(?:-image)?\s*:\s*url\([\'"]?([^\'"\)]+)[\'"]?\)',
        re.IGNORECASE
    )
    
    @classmethod
    def extract_from_style(cls, style: str, base_url: str) -> List[str]:
        """Extract background-image URLs from a style attribute or CSS block."""
        urls = []
        for match in cls.BG_IMAGE_PATTERN.finditer(style):
            url = match.group(1).strip()
            if url and not url.startswith('data:'):
                urls.append(urljoin(base_url, url))
        return urls
    
    @classmethod
    def extract_from_stylesheet(cls, css_content: str, base_url: str) -> List[Tuple[str, str]]:
        """
        Extract background-image URLs with their selectors.
        Returns [(selector, url), ...]
        """
        results = []
        try:
            sheet = cssutils.parseString(css_content)
            for rule in sheet:
                if rule.type == rule.STYLE_RULE:
                    selector = rule.selectorText
                    style = rule.style
                    bg = style.getPropertyValue('background-image') or style.getPropertyValue('background')
                    if bg:
                        for match in cls.BG_IMAGE_PATTERN.finditer(bg):
                            url = match.group(1).strip()
                            if url and not url.startswith('data:'):
                                results.append((selector, urljoin(base_url, url)))
        except:
            # Fallback to regex if cssutils fails
            pass
        return results


# ============================================================
# Main HTML Parser
# ============================================================

class IntelligentHTMLParser(HTMLParser):
    """
    Comprehensive HTML parser for logo and company intelligence extraction.
    
    Extracts:
    1. All potential logo images with rich context
    2. Inline SVGs (complete content)
    3. CSS background images
    4. Structured data (JSON-LD, Schema.org)
    5. Meta tags (OG, Twitter, etc.)
    6. Manifest links
    7. Brand-related navigation links
    8. Heading hierarchy for context
    """
    
    # Logo-related keywords for scoring
    LOGO_KEYWORDS = frozenset([
        'logo', 'brand', 'mark', 'emblem', 'icon', 'symbol',
        'wordmark', 'logotype', 'brandmark', 'site-logo', 'company-logo'
    ])
    
    # Navigation keywords for brand pages
    BRAND_NAV_KEYWORDS = frozenset([
        'about', 'brand', 'press', 'media', 'investor', 'contact',
        'company', 'corporate', 'newsroom', 'who-we-are'
    ])
    
    # Social media domains
    SOCIAL_DOMAINS = {
        'linkedin.com': 'linkedin',
        'twitter.com': 'twitter',
        'x.com': 'twitter',
        'facebook.com': 'facebook',
        'instagram.com': 'instagram',
        'youtube.com': 'youtube',
    }
    
    def __init__(self, base_url: str, company_name: str = ""):
        super().__init__()
        self.base_url = base_url
        self.company_name = company_name
        self.company_name_lower = company_name.lower() if company_name else ""
        
        # Results
        self.result = HTMLIntelligence(url=base_url)
        
        # Parsing state
        self._tag_stack: List[str] = []
        self._class_stack: List[List[str]] = []
        self._id_stack: List[str] = []
        self._in_head = False
        self._in_header = False
        self._in_footer = False
        self._in_nav = False
        self._in_script = False
        self._in_style = False
        self._in_svg = False
        self._svg_content = []
        self._svg_attrs: Dict[str, str] = {}
        self._current_data = []
        self._current_heading: Optional[str] = None
        
        # Deduplication
        self._seen_urls: Set[str] = set()
        
        # Stats
        self._stats = {
            'img_tags': 0,
            'svg_inline': 0,
            'css_backgrounds': 0,
            'json_ld_blocks': 0,
            'meta_tags': 0,
        }
    
    def feed(self, data: str):
        """Override to handle errors gracefully."""
        try:
            super().feed(data)
        except Exception as e:
            pass  # Continue despite parse errors
        
        # Finalize
        self.result.stats = self._stats
        self._score_all_candidates()
    
    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]):
        tag_lower = tag.lower()
        attrs_dict = {k.lower(): v for k, v in attrs if v is not None}
        
        # Track tag stack for context
        self._tag_stack.append(tag_lower)
        self._class_stack.append(attrs_dict.get('class', '').split())
        self._id_stack.append(attrs_dict.get('id', ''))
        
        # Track sections
        if tag_lower == 'head':
            self._in_head = True
        elif tag_lower == 'header':
            self._in_header = True
        elif tag_lower == 'footer':
            self._in_footer = True
        elif tag_lower == 'nav':
            self._in_nav = True
        elif tag_lower == 'script':
            self._in_script = True
            # Check for JSON-LD
            if attrs_dict.get('type') == 'application/ld+json':
                self._current_data = []
        elif tag_lower == 'style':
            self._in_style = True
            self._current_data = []
        elif tag_lower == 'svg':
            self._in_svg = True
            self._svg_content = [self._reconstruct_tag(tag, attrs)]
            self._svg_attrs = attrs_dict
        elif tag_lower in ('h1', 'h2', 'h3'):
            self._current_heading = tag_lower
            self._current_data = []
        
        # Skip content extraction in script/style (except JSON-LD)
        if self._in_script or self._in_style:
            return
        
        # Handle SVG content
        if self._in_svg and tag_lower != 'svg':
            self._svg_content.append(self._reconstruct_tag(tag, attrs))
            return
        
        # Extract signals
        if tag_lower == 'img':
            self._handle_img(attrs_dict)
        elif tag_lower == 'picture':
            pass  # Will handle source/img inside
        elif tag_lower == 'source':
            self._handle_source(attrs_dict)
        elif tag_lower == 'link':
            self._handle_link(attrs_dict)
        elif tag_lower == 'meta':
            self._handle_meta(attrs_dict)
        elif tag_lower == 'a':
            self._handle_anchor(attrs_dict)
        
        # Check for inline styles with background images
        style = attrs_dict.get('style', '')
        if style and 'background' in style.lower():
            self._handle_css_background(style, attrs_dict)
    
    def handle_endtag(self, tag: str):
        tag_lower = tag.lower()
        
        # Handle SVG end
        if self._in_svg:
            self._svg_content.append(f'</{tag_lower}>')
            if tag_lower == 'svg':
                self._finalize_svg()
                self._in_svg = False
            return
        
        # Handle JSON-LD script end
        if tag_lower == 'script' and self._in_script:
            content = ''.join(self._current_data).strip()
            if content:
                self._parse_json_ld(content)
            self._in_script = False
            self._current_data = []
        
        # Handle style end
        if tag_lower == 'style' and self._in_style:
            content = ''.join(self._current_data)
            self._parse_stylesheet(content)
            self._in_style = False
            self._current_data = []
        
        # Handle heading end
        if tag_lower in ('h1', 'h2', 'h3') and self._current_heading == tag_lower:
            text = ''.join(self._current_data).strip()
            if text:
                self.result.heading_hierarchy.append(f"{tag_lower}: {text[:100]}")
            self._current_heading = None
            self._current_data = []
        
        # Track sections
        if tag_lower == 'head':
            self._in_head = False
        elif tag_lower == 'header':
            self._in_header = False
        elif tag_lower == 'footer':
            self._in_footer = False
        elif tag_lower == 'nav':
            self._in_nav = False
        
        # Pop tag stack
        if self._tag_stack and self._tag_stack[-1] == tag_lower:
            self._tag_stack.pop()
            if self._class_stack:
                self._class_stack.pop()
            if self._id_stack:
                self._id_stack.pop()
    
    def handle_data(self, data: str):
        if self._in_svg:
            self._svg_content.append(data)
        elif self._in_script or self._in_style or self._current_heading:
            self._current_data.append(data)
    
    def _reconstruct_tag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> str:
        """Reconstruct an HTML tag from parsed components."""
        attr_str = ' '.join(
            f'{k}="{v}"' if v else k
            for k, v in attrs
        )
        return f'<{tag} {attr_str}>' if attr_str else f'<{tag}>'
    
    # ============================================================
    # Image Extraction
    # ============================================================
    
    def _handle_img(self, attrs: Dict[str, str]):
        """Extract image with full context."""
        self._stats['img_tags'] += 1
        
        # Get URL from various attributes
        src = (
            attrs.get('src') or 
            attrs.get('data-src') or 
            attrs.get('data-lazy-src') or
            attrs.get('data-original') or
            attrs.get('data-srcset', '').split()[0] if attrs.get('data-srcset') else ''
        )
        
        if not src or src.startswith('data:'):
            # Check for base64 images - might be inline logo
            if src and src.startswith('data:image'):
                self._handle_data_uri(src, attrs)
            return
        
        url = urljoin(self.base_url, src)
        if url in self._seen_urls:
            return
        self._seen_urls.add(url)
        
        # Also check srcset for higher resolution
        srcset = attrs.get('srcset', '')
        srcset_urls = self._parse_srcset(srcset)
        
        # Build candidate
        candidate = LogoCandidate(
            url=url,
            source=self._determine_img_source(),
            format=self._detect_format(url),
            width=self._parse_dim(attrs.get('width', '')),
            height=self._parse_dim(attrs.get('height', '')),
            alt=attrs.get('alt', ''),
            title=attrs.get('title', ''),
            in_header=self._in_header,
            in_footer=self._in_footer,
            in_nav=self._in_nav,
            css_classes=attrs.get('class', '').split(),
            css_ids=[attrs.get('id', '')] if attrs.get('id') else [],
            parent_classes=self._get_parent_classes(),
        )
        
        self.result.logo_candidates.append(candidate)
        
        # Add srcset variants
        for srcset_url, descriptor in srcset_urls:
            if srcset_url not in self._seen_urls:
                self._seen_urls.add(srcset_url)
                variant = LogoCandidate(
                    url=srcset_url,
                    source=candidate.source + '_srcset',
                    format=self._detect_format(srcset_url),
                    in_header=self._in_header,
                    in_footer=self._in_footer,
                    css_classes=candidate.css_classes,
                )
                # Parse width from descriptor (e.g., "2x" or "200w")
                if descriptor.endswith('w'):
                    try:
                        variant.width = int(descriptor[:-1])
                    except:
                        pass
                self.result.logo_candidates.append(variant)
    
    def _handle_source(self, attrs: Dict[str, str]):
        """Handle <source> elements inside <picture>."""
        srcset = attrs.get('srcset', '')
        if srcset:
            for url, descriptor in self._parse_srcset(srcset):
                if url not in self._seen_urls:
                    self._seen_urls.add(url)
                    media = attrs.get('media', '')
                    candidate = LogoCandidate(
                        url=urljoin(self.base_url, url),
                        source='picture_source',
                        format=self._detect_format(url),
                        in_header=self._in_header,
                    )
                    self.result.logo_candidates.append(candidate)
    
    def _handle_data_uri(self, data_uri: str, attrs: Dict[str, str]):
        """Handle base64-encoded inline images."""
        # Only process if it looks like a logo
        classes = attrs.get('class', '').lower()
        alt = attrs.get('alt', '').lower()
        
        if any(kw in classes or kw in alt for kw in self.LOGO_KEYWORDS):
            # Extract format
            format_match = re.match(r'data:image/(\w+);', data_uri)
            format_type = format_match.group(1) if format_match else 'unknown'
            
            candidate = LogoCandidate(
                url='data:' + data_uri[:50] + '...',  # Truncate for display
                source='inline_data_uri',
                format=format_type,
                inline_content=data_uri,  # Store full data URI
                css_classes=attrs.get('class', '').split(),
                in_header=self._in_header,
            )
            candidate.score = 80  # High score for inline logo
            self.result.logo_candidates.append(candidate)
    
    def _parse_srcset(self, srcset: str) -> List[Tuple[str, str]]:
        """Parse srcset attribute into (url, descriptor) pairs."""
        results = []
        if not srcset:
            return results
        
        for part in srcset.split(','):
            parts = part.strip().split()
            if parts:
                url = parts[0]
                descriptor = parts[1] if len(parts) > 1 else '1x'
                results.append((urljoin(self.base_url, url), descriptor))
        return results
    
    # ============================================================
    # SVG Extraction
    # ============================================================
    
    # Common UI icon patterns to filter out
    UI_ICON_PATTERNS = frozenset([
        'arrow', 'chevron', 'caret', 'close', 'menu', 'hamburger', 'search',
        'expand', 'collapse', 'toggle', 'dropdown', 'scroll', 'play', 'pause',
        'check', 'tick', 'cross', 'x-mark', 'spinner', 'loading', 'social',
        'facebook', 'twitter', 'linkedin', 'instagram', 'youtube', 'email',
        'phone', 'location', 'map', 'pin', 'calendar', 'clock', 'user', 'avatar',
        'sidebar', 'button', 'nav', 'navigation', 'mobile', 'icon-menu',
        'icon-close', 'icon-search', 'icon-arrow', 'icon-caret', 'bars',
    ])
    
    # SVG patterns that indicate a reference to external SVG (not actual logo)
    SVG_REFERENCE_PATTERNS = ['<use', 'xlink:href', 'symbol-defs', '#icon-']
    
    def _finalize_svg(self):
        """Process completed inline SVG with UI icon filtering."""
        self._stats['svg_inline'] += 1
        
        svg_content = ''.join(self._svg_content)
        svg_content_lower = svg_content.lower()
        
        # Filter out SVG references (not actual logos)
        # These use <use xlink:href="..."> to reference external SVG symbols
        if any(pattern in svg_content_lower for pattern in self.SVG_REFERENCE_PATTERNS):
            return  # Skip SVG references - not actual logo content
        
        # Filter out small/simple SVGs that are likely UI icons
        # 1. Check SVG content size (logos are usually more complex)
        content_len = len(svg_content)
        if content_len < 300:  # Very simple SVG, likely icon
            # But still allow if it has logo keywords
            classes = self._svg_attrs.get('class', '').lower()
            svg_id = self._svg_attrs.get('id', '').lower()
            if not any(kw in classes or kw in svg_id for kw in self.LOGO_KEYWORDS):
                return  # Skip this UI icon
        
        # 2. Check for UI icon class names
        classes = self._svg_attrs.get('class', '').lower()
        svg_id = self._svg_attrs.get('id', '').lower()
        title_match = re.search(r'<title>([^<]+)</title>', svg_content, re.IGNORECASE)
        svg_title = title_match.group(1).lower() if title_match else ''
        
        # Check if this looks like a UI icon
        all_identifiers = f"{classes} {svg_id} {svg_title}"
        if any(pattern in all_identifiers for pattern in self.UI_ICON_PATTERNS):
            # It's a UI icon - skip unless explicitly marked as logo
            if not any(kw in all_identifiers for kw in self.LOGO_KEYWORDS):
                return  # Skip this UI icon
        
        # 3. Check viewBox for very small icons (24x24, 16x16 etc are usually UI icons)
        viewbox = self._svg_attrs.get('viewbox', '')
        if viewbox:
            try:
                parts = viewbox.split()
                if len(parts) >= 4:
                    vb_width, vb_height = float(parts[2]), float(parts[3])
                    if vb_width <= 32 and vb_height <= 32:
                        # Small viewbox - likely UI icon
                        if not any(kw in all_identifiers for kw in self.LOGO_KEYWORDS):
                            return  # Skip
            except:
                pass
        
        # This SVG passes the filters - create candidate
        candidate = LogoCandidate(
            url=f"inline:svg:{hash(svg_content) & 0xFFFFFFFF:08x}",
            source='inline_svg',
            format='svg',
            inline_content=svg_content,
            width=self._parse_dim(self._svg_attrs.get('width', '')),
            height=self._parse_dim(self._svg_attrs.get('height', '')),
            css_classes=self._svg_attrs.get('class', '').split(),
            css_ids=[self._svg_attrs.get('id', '')] if self._svg_attrs.get('id') else [],
            in_header=self._in_header,
            in_footer=self._in_footer,
            in_nav=self._in_nav,
            parent_classes=self._get_parent_classes(),
        )
        
        self.result.logo_candidates.append(candidate)
        self._svg_content = []
        self._svg_attrs = {}
    
    # ============================================================
    # CSS Background Extraction
    # ============================================================
    
    def _handle_css_background(self, style: str, attrs: Dict[str, str]):
        """Extract background-image from inline style."""
        urls = CSSBackgroundExtractor.extract_from_style(style, self.base_url)
        
        for url in urls:
            if url not in self._seen_urls:
                self._seen_urls.add(url)
                self._stats['css_backgrounds'] += 1
                
                candidate = LogoCandidate(
                    url=url,
                    source='css_background',
                    format=self._detect_format(url),
                    css_classes=attrs.get('class', '').split(),
                    css_ids=[attrs.get('id', '')] if attrs.get('id') else [],
                    in_header=self._in_header,
                    parent_classes=self._get_parent_classes(),
                )
                self.result.logo_candidates.append(candidate)
    
    def _parse_stylesheet(self, css_content: str):
        """Extract logo-related background images from <style> blocks."""
        results = CSSBackgroundExtractor.extract_from_stylesheet(css_content, self.base_url)
        
        for selector, url in results:
            # Only interested in logo-related selectors
            selector_lower = selector.lower()
            if any(kw in selector_lower for kw in self.LOGO_KEYWORDS):
                if url not in self._seen_urls:
                    self._seen_urls.add(url)
                    self._stats['css_backgrounds'] += 1
                    
                    candidate = LogoCandidate(
                        url=url,
                        source='css_stylesheet',
                        format=self._detect_format(url),
                        css_classes=[selector],  # Store selector as class
                    )
                    self.result.logo_candidates.append(candidate)
    
    # ============================================================
    # Link Extraction (favicons, manifests)
    # ============================================================
    
    def _handle_link(self, attrs: Dict[str, str]):
        """Extract favicons, touch icons, and manifests."""
        rel = attrs.get('rel', '').lower()
        href = attrs.get('href', '')
        
        if not href:
            return
        
        absolute_url = urljoin(self.base_url, href)
        
        # Favicons and touch icons
        if 'icon' in rel:
            if absolute_url not in self._seen_urls:
                self._seen_urls.add(absolute_url)
                
                # Determine source type
                if 'apple-touch' in rel:
                    source = 'apple_touch_icon'
                elif 'mask-icon' in rel:
                    source = 'mask_icon'
                else:
                    source = 'favicon'
                
                # Parse sizes
                sizes = attrs.get('sizes', '')
                width = 0
                if sizes and 'x' in sizes:
                    try:
                        width = int(sizes.split('x')[0])
                    except:
                        pass
                
                candidate = LogoCandidate(
                    url=absolute_url,
                    source=source,
                    format=self._detect_format(absolute_url),
                    width=width,
                    height=width,  # Usually square
                )
                self.result.logo_candidates.append(candidate)
        
        # Manifest files
        elif rel in ('manifest', 'msapplication-config'):
            self.result.manifest_urls.append(absolute_url)
        
        # Canonical URL (useful for metadata)
        elif rel == 'canonical':
            pass  # Could extract if needed
    
    # ============================================================
    # Meta Tag Extraction
    # ============================================================
    
    def _handle_meta(self, attrs: Dict[str, str]):
        """Extract OpenGraph, Twitter, and other meta tags."""
        self._stats['meta_tags'] += 1
        
        name = attrs.get('name', '').lower()
        prop = attrs.get('property', '').lower()
        content = attrs.get('content', '')
        
        if not content:
            return
        
        meta = self.result.metadata
        
        # OpenGraph
        if prop.startswith('og:'):
            if prop == 'og:title':
                meta.og_title = content
            elif prop == 'og:description':
                meta.og_description = content
            elif prop == 'og:image':
                meta.og_image = urljoin(self.base_url, content)
                # Also add as logo candidate
                candidate = LogoCandidate(
                    url=meta.og_image,
                    source='og_image',
                    format=self._detect_format(content),
                )
                if meta.og_image not in self._seen_urls:
                    self._seen_urls.add(meta.og_image)
                    self.result.logo_candidates.append(candidate)
            elif prop == 'og:site_name':
                meta.og_site_name = content
            elif prop == 'og:type':
                meta.og_type = content
        
        # Twitter
        elif name.startswith('twitter:') or prop.startswith('twitter:'):
            key = name or prop
            if key == 'twitter:title':
                meta.twitter_title = content
            elif key == 'twitter:description':
                meta.twitter_description = content
            elif key == 'twitter:image':
                meta.twitter_image = urljoin(self.base_url, content)
                candidate = LogoCandidate(
                    url=meta.twitter_image,
                    source='twitter_image',
                    format=self._detect_format(content),
                )
                if meta.twitter_image not in self._seen_urls:
                    self._seen_urls.add(meta.twitter_image)
                    self.result.logo_candidates.append(candidate)
            elif key == 'twitter:site':
                meta.twitter_site = content
        
        # Standard meta
        elif name == 'description':
            meta.description = content
        elif name == 'keywords':
            self.result.meta_keywords = [k.strip() for k in content.split(',')]
        elif name == 'author':
            pass  # Could extract
    
    # ============================================================
    # Anchor/Navigation Extraction
    # ============================================================
    
    def _handle_anchor(self, attrs: Dict[str, str]):
        """Extract brand pages and social links."""
        href = attrs.get('href', '')
        if not href or href.startswith(('#', 'javascript:', 'mailto:', 'tel:')):
            return
        
        absolute_url = urljoin(self.base_url, href)
        href_lower = href.lower()
        
        # Brand/about pages
        if any(kw in href_lower for kw in self.BRAND_NAV_KEYWORDS):
            if absolute_url not in self.result.brand_pages:
                self.result.brand_pages.append(absolute_url)
                
                # Categorize
                meta = self.result.metadata
                if 'about' in href_lower or 'who-we-are' in href_lower:
                    meta.about_url = absolute_url
                elif 'contact' in href_lower:
                    meta.contact_url = absolute_url
                elif 'press' in href_lower or 'media' in href_lower or 'newsroom' in href_lower:
                    meta.press_url = absolute_url
                elif 'investor' in href_lower:
                    meta.investor_url = absolute_url
        
        # Social links
        try:
            parsed = urlparse(absolute_url)
            domain = parsed.netloc.lower()
            for social_domain, social_name in self.SOCIAL_DOMAINS.items():
                if social_domain in domain:
                    self.result.metadata.social_links[social_name] = absolute_url
                    break
        except:
            pass
    
    # ============================================================
    # JSON-LD / Schema.org Extraction
    # ============================================================
    
    def _parse_json_ld(self, content: str):
        """Parse JSON-LD structured data."""
        try:
            data = json.loads(content)
            self._stats['json_ld_blocks'] += 1
            
            # Handle array of objects
            if isinstance(data, list):
                for item in data:
                    self._process_json_ld_item(item)
            else:
                self._process_json_ld_item(data)
                
        except json.JSONDecodeError:
            pass
    
    def _process_json_ld_item(self, item: Dict):
        """Process a single JSON-LD item."""
        if not isinstance(item, dict):
            return
        
        self.result.metadata.json_ld.append(item)
        
        item_type = item.get('@type', '')
        
        # Organization/Company
        if item_type in ('Organization', 'Corporation', 'LocalBusiness', 'Company'):
            meta = self.result.metadata
            meta.schema_org = item
            
            if 'name' in item:
                meta.name = item['name']
            if 'description' in item:
                meta.description = item['description']
            if 'logo' in item:
                logo = item['logo']
                logo_url = logo if isinstance(logo, str) else logo.get('url', '')
                if logo_url:
                    absolute_url = urljoin(self.base_url, logo_url)
                    candidate = LogoCandidate(
                        url=absolute_url,
                        source='schema_org_logo',
                        format=self._detect_format(logo_url),
                    )
                    candidate.score = 150  # Very high score for Schema.org logo
                    if absolute_url not in self._seen_urls:
                        self._seen_urls.add(absolute_url)
                        self.result.logo_candidates.append(candidate)
            
            # Contact info
            if 'email' in item:
                meta.email = item['email']
            if 'telephone' in item:
                meta.phone = item['telephone']
            if 'address' in item:
                addr = item['address']
                if isinstance(addr, str):
                    meta.address = addr
                elif isinstance(addr, dict):
                    parts = [addr.get('streetAddress', ''), addr.get('addressLocality', ''),
                             addr.get('addressRegion', ''), addr.get('postalCode', '')]
                    meta.address = ', '.join(p for p in parts if p)
            
            # Social/same as
            if 'sameAs' in item:
                same_as = item['sameAs']
                if isinstance(same_as, list):
                    for url in same_as:
                        self._categorize_social(url)
                else:
                    self._categorize_social(same_as)
        
        # WebSite - might have logo
        elif item_type == 'WebSite':
            if 'publisher' in item and isinstance(item['publisher'], dict):
                self._process_json_ld_item(item['publisher'])
    
    def _categorize_social(self, url: str):
        """Categorize a social media URL."""
        try:
            parsed = urlparse(url)
            domain = parsed.netloc.lower()
            for social_domain, social_name in self.SOCIAL_DOMAINS.items():
                if social_domain in domain:
                    self.result.metadata.social_links[social_name] = url
                    break
        except:
            pass
    
    # ============================================================
    # Scoring
    # ============================================================
    
    def _score_all_candidates(self):
        """Score all logo candidates after parsing is complete."""
        for candidate in self.result.logo_candidates:
            candidate.score = self._calculate_score(candidate)
        
        # Sort by score
        self.result.logo_candidates.sort(key=lambda x: x.score, reverse=True)
    
    def _calculate_score(self, c: LogoCandidate) -> float:
        """Calculate comprehensive score for a logo candidate."""
        breakdown = {}
        score = c.score  # Start with any pre-set score
        
        # Format scoring (SVG is best for logos)
        format_scores = {
            'svg': 100, 'png': 50, 'webp': 45, 'jpeg': 35, 'jpg': 35, 'gif': 20, 'ico': 15
        }
        format_score = format_scores.get(c.format, 0)
        breakdown['format'] = format_score
        score += format_score
        
        # Source scoring
        source_scores = {
            'schema_org_logo': 50,  # Highest - explicitly marked as logo
            'inline_svg': 40,       # Inline SVGs are often logos
            'inline_data_uri': 35,  # Embedded images often logos
            'img_header': 30,
            'apple_touch_icon': 25,
            'mask_icon': 25,
            'css_background': 20,
            'og_image': 18,
            'twitter_image': 15,
            'picture_source': 15,
            'favicon': 12,
            'img_nav': 12,
            'img_footer': 8,
            'img_body': 5,
        }
        source_score = source_scores.get(c.source, 0)
        breakdown['source'] = source_score
        score += source_score
        
        # Location bonus
        if c.in_header and 'header' not in c.source:
            breakdown['in_header'] = 15
            score += 15
        if c.in_nav:
            breakdown['in_nav'] = 8
            score += 8
        
        # Keyword scoring (URL, alt, classes)
        url_lower = c.url.lower()
        keyword_score = 0
        
        if any(kw in url_lower for kw in self.LOGO_KEYWORDS):
            keyword_score += 30
        if c.alt and any(kw in c.alt.lower() for kw in self.LOGO_KEYWORDS):
            keyword_score += 25
        
        # Check CSS classes for logo hints
        all_classes = ' '.join(c.css_classes + c.parent_classes).lower()
        if any(kw in all_classes for kw in self.LOGO_KEYWORDS):
            keyword_score += 20
        
        # CSS IDs
        all_ids = ' '.join(c.css_ids).lower()
        if any(kw in all_ids for kw in self.LOGO_KEYWORDS):
            keyword_score += 20
        
        # Company name in URL
        if self.company_name_lower and self.company_name_lower in url_lower:
            keyword_score += 15
        
        breakdown['keywords'] = keyword_score
        score += keyword_score
        
        # Size scoring
        size_score = 0
        if c.width >= 256:
            size_score = 15
        elif c.width >= 128:
            size_score = 10
        elif c.width >= 64:
            size_score = 5
        elif 0 < c.width < 32:
            size_score = -15  # Too small
        breakdown['size'] = size_score
        score += size_score
        
        # Penalty for common non-logo patterns
        penalty = 0
        if 'avatar' in url_lower or 'user' in url_lower:
            penalty -= 30
        if 'banner' in url_lower or 'hero' in url_lower:
            penalty -= 20
        if 'background' in url_lower and 'logo' not in url_lower:
            penalty -= 15
        if 'placeholder' in url_lower or 'loading' in url_lower:
            penalty -= 40
        if 'ad' in url_lower.split('/') or 'ads' in url_lower.split('/'):
            penalty -= 50
        
        # Heavy penalty for UI icon patterns (arrow, menu, chevron, etc.)
        ui_icon_patterns = [
            'arrow', 'chevron', 'caret', 'close', 'menu', 'hamburger', 'search',
            'expand', 'collapse', 'toggle', 'dropdown', 'scroll', 'play', 'pause',
            'check', 'tick', 'cross', 'spinner', 'loading'
        ]
        all_classes = ' '.join(c.css_classes + c.parent_classes).lower()
        for pattern in ui_icon_patterns:
            if pattern in all_classes or pattern in url_lower:
                penalty -= 100  # Heavy penalty
                break
        
        # Penalty for very small SVG viewbox (likely UI icon)
        if c.source == 'inline_svg' and c.inline_content:
            viewbox_match = re.search(r'viewbox\s*=\s*["\']?\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)', 
                                      c.inline_content, re.IGNORECASE)
            if viewbox_match:
                try:
                    vb_w = float(viewbox_match.group(1))
                    vb_h = float(viewbox_match.group(2))
                    if vb_w <= 32 and vb_h <= 32:
                        penalty -= 80  # Small viewbox = likely icon
                except:
                    pass
            
            # Penalty for very simple SVGs (single path, small content)
            if len(c.inline_content) < 600:
                path_count = c.inline_content.lower().count('<path')
                if path_count <= 1:
                    penalty -= 50  # Very simple SVG
        
        breakdown['penalty'] = penalty
        score += penalty
        
        c.score_breakdown = breakdown
        return score
    
    # ============================================================
    # Utility Methods
    # ============================================================
    
    def _determine_img_source(self) -> str:
        """Determine the source type based on current location."""
        if self._in_header:
            return 'img_header'
        elif self._in_nav:
            return 'img_nav'
        elif self._in_footer:
            return 'img_footer'
        return 'img_body'
    
    def _get_parent_classes(self) -> List[str]:
        """Get CSS classes from parent elements."""
        classes = []
        for class_list in self._class_stack[-3:]:  # Last 3 parents
            classes.extend(class_list)
        return classes
    
    def _detect_format(self, url: str) -> str:
        """Detect image format from URL."""
        path = urlparse(url.lower()).path
        if path.endswith('.svg') or 'svg' in url.lower():
            return 'svg'
        elif path.endswith('.png'):
            return 'png'
        elif path.endswith(('.jpg', '.jpeg')):
            return 'jpeg'
        elif path.endswith('.gif'):
            return 'gif'
        elif path.endswith('.webp'):
            return 'webp'
        elif path.endswith('.ico'):
            return 'ico'
        return 'unknown'
    
    def _parse_dim(self, val: str) -> int:
        """Parse dimension value."""
        if not val:
            return 0
        try:
            return int(re.sub(r'[^\d]', '', str(val)))
        except:
            return 0


# ============================================================
# High-Level Extractor
# ============================================================

class HTMLIntelligenceExtractor:
    """
    Complete HTML intelligence extraction with multi-page support.
    """
    
    MAX_HTML_SIZE = 1024 * 1024  # 1MB max
    REQUEST_TIMEOUT = 20.0
    
    def __init__(self):
        self.client = httpx.Client(
            timeout=self.REQUEST_TIMEOUT,
            follow_redirects=True,
            headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate',
            },
        )
    
    def extract(self, url: str, company_name: str = "", 
                crawl_brand_pages: bool = True,
                fetch_manifests: bool = True) -> HTMLIntelligence:
        """
        Extract all intelligence from a website.
        
        Args:
            url: Website URL
            company_name: Company name for scoring
            crawl_brand_pages: Whether to crawl about/brand pages
            fetch_manifests: Whether to fetch manifest.json etc.
        """
        base_url = self._normalize_url(url)
        if not base_url:
            return HTMLIntelligence(url=url)
        
        # Phase 1: Extract from homepage
        result = self._extract_from_page(base_url, company_name)
        
        # Phase 2: Fetch manifests for additional icons
        if fetch_manifests and result.manifest_urls:
            manifest_candidates = self._fetch_manifests(result.manifest_urls, base_url)
            result.logo_candidates.extend(manifest_candidates)
        
        # Phase 3: Crawl brand pages if we don't have high-quality candidates
        high_quality = [c for c in result.logo_candidates if c.score >= 100]
        if crawl_brand_pages and len(high_quality) < 3 and result.brand_pages:
            for page_url in result.brand_pages[:2]:
                page_result = self._extract_from_page(page_url, company_name)
                # Merge candidates
                seen = {c.url for c in result.logo_candidates}
                for c in page_result.logo_candidates:
                    if c.url not in seen:
                        result.logo_candidates.append(c)
        
        # Re-sort after adding candidates
        result.logo_candidates.sort(key=lambda x: x.score, reverse=True)
        
        return result
    
    def _extract_from_page(self, url: str, company_name: str) -> HTMLIntelligence:
        """Extract from a single page."""
        try:
            response = self.client.get(url)
            if response.status_code != 200:
                return HTMLIntelligence(url=url)
            
            # Limit size
            html = response.text[:self.MAX_HTML_SIZE]
            
            # Parse
            parser = IntelligentHTMLParser(url, company_name)
            parser.feed(html)
            
            # Get page title
            title_match = re.search(r'<title[^>]*>([^<]+)</title>', html, re.IGNORECASE)
            if title_match:
                parser.result.page_title = title_match.group(1).strip()
            
            return parser.result
            
        except Exception as e:
            return HTMLIntelligence(url=url)
    
    def _fetch_manifests(self, manifest_urls: List[str], base_url: str) -> List[LogoCandidate]:
        """Fetch manifest.json and extract icon candidates."""
        candidates = []
        
        for manifest_url in manifest_urls[:3]:  # Limit
            try:
                response = self.client.get(manifest_url, timeout=10.0)
                if response.status_code != 200:
                    continue
                
                data = response.json()
                
                # Web App Manifest icons
                for icon in data.get('icons', []):
                    src = icon.get('src', '')
                    if src:
                        url = urljoin(base_url, src)
                        sizes = icon.get('sizes', '')
                        width = 0
                        if sizes and 'x' in sizes:
                            try:
                                width = int(sizes.split('x')[0])
                            except:
                                pass
                        
                        candidate = LogoCandidate(
                            url=url,
                            source='manifest_icon',
                            format=icon.get('type', '').split('/')[-1] or 'png',
                            width=width,
                            height=width,
                        )
                        # Score based on size
                        if width >= 512:
                            candidate.score = 80
                        elif width >= 192:
                            candidate.score = 60
                        else:
                            candidate.score = 40
                        candidates.append(candidate)
                
            except:
                continue
        
        return candidates
    
    def _normalize_url(self, url: str) -> Optional[str]:
        """Normalize URL."""
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
        self.client.close()


# ============================================================
# LLM Context Generator
# ============================================================

def generate_llm_context(intel: HTMLIntelligence) -> str:
    """
    Generate compact, high-signal context for LLM enrichment.
    
    This is the bridge between HTML extraction and LLM processing.
    Provides structured information to help the LLM understand the company.
    """
    lines = []
    meta = intel.metadata
    
    # Company identity
    if meta.name or meta.og_site_name:
        lines.append(f"Company: {meta.name or meta.og_site_name}")
    
    # Description
    desc = meta.og_description or meta.description or meta.twitter_description
    if desc:
        lines.append(f"Description: {desc[:200]}")
    
    # Schema.org data (high-value structured info)
    if meta.schema_org:
        schema = meta.schema_org
        if schema.get('industry'):
            lines.append(f"Industry: {schema.get('industry')}")
        if schema.get('foundingDate'):
            lines.append(f"Founded: {schema.get('foundingDate')}")
        if schema.get('numberOfEmployees'):
            lines.append(f"Employees: {schema.get('numberOfEmployees')}")
    
    # Contact info
    contact = []
    if meta.email:
        contact.append(f"Email: {meta.email}")
    if meta.phone:
        contact.append(f"Phone: {meta.phone}")
    if meta.address:
        contact.append(f"Address: {meta.address[:100]}")
    if contact:
        lines.append("Contact: " + " | ".join(contact))
    
    # Social presence
    if meta.social_links:
        lines.append(f"Social: {', '.join(meta.social_links.keys())}")
    
    # Page structure hints
    if intel.heading_hierarchy:
        lines.append(f"Key headings: {' > '.join(intel.heading_hierarchy[:5])}")
    
    # Keywords
    if intel.meta_keywords:
        lines.append(f"Keywords: {', '.join(intel.meta_keywords[:10])}")
    
    return "\n".join(lines)


# ============================================================
# Demo / Testing
# ============================================================

if __name__ == "__main__":
    import sys
    
    test_urls = [
        ("https://www.4dsmemory.com", "4DS Memory"),
        ("https://www.galileomining.com.au", "Galileo Mining"),
        ("https://www.austal.com", "Austal"),
    ]
    
    extractor = HTMLIntelligenceExtractor()
    
    for url, name in test_urls:
        print(f"\n{'='*60}")
        print(f"Extracting: {name} ({url})")
        print('='*60)
        
        intel = extractor.extract(url, name, crawl_brand_pages=False)
        
        print(f"\n📊 Stats: {intel.stats}")
        print(f"📄 Title: {intel.page_title}")
        
        print(f"\n🖼️  Logo Candidates: {len(intel.logo_candidates)}")
        for i, c in enumerate(intel.logo_candidates[:5]):
            print(f"  {i+1}. [{c.score:.0f}] {c.source}: {c.format} - {c.url[:60]}...")
            if c.inline_content:
                print(f"      (inline content: {len(c.inline_content)} chars)")
            if c.score_breakdown:
                print(f"      Breakdown: {c.score_breakdown}")
        
        print(f"\n📋 Metadata:")
        meta = intel.metadata
        if meta.og_title:
            print(f"  OG Title: {meta.og_title}")
        if meta.og_description:
            print(f"  OG Desc: {meta.og_description[:100]}...")
        if meta.social_links:
            print(f"  Social: {meta.social_links}")
        
        print(f"\n🔗 Brand Pages: {intel.brand_pages[:3]}")
        print(f"📦 Manifests: {intel.manifest_urls}")
        
        print(f"\n💡 LLM Context:")
        print(generate_llm_context(intel))
    
    extractor.close()
