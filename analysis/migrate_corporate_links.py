#!/usr/bin/env python3
"""
Migrate corporate links from raw scraped links text → structured JSONB.

Reads the existing `links` text column (Python list as string) from company-metadata,
extracts and categorizes useful corporate links (investor pages, social media, governance,
team pages, etc.), deduplicates, resolves relative URLs, and writes back to:
  - `corporate_links` JSONB column (categorized corporate links)
  - `social_media_links` JSONB column (social media URLs — updates existing)

Usage:
  # Dry run (just print what would be updated)
  python3 migrate_corporate_links.py --dry-run

  # Against local dev DB
  python3 migrate_corporate_links.py

  # Against production
  DATABASE_URL=postgresql://... python3 migrate_corporate_links.py
"""

import argparse
import ast
import json
import os
import re
import sys
from urllib.parse import urljoin, urlparse

import psycopg2
import psycopg2.extras


# ---------------------------------------------------------------------------
# Link categorization rules
# ---------------------------------------------------------------------------

SOCIAL_MEDIA_PATTERNS = {
    "linkedin": re.compile(r"linkedin\.com/", re.I),
    "twitter": re.compile(r"(twitter\.com/|x\.com/)", re.I),
    "facebook": re.compile(r"facebook\.com/", re.I),
    "youtube": re.compile(r"(youtube\.com/|youtu\.be/)", re.I),
    "instagram": re.compile(r"instagram\.com/", re.I),
}

CORPORATE_CATEGORIES = {
    "investor_relations": re.compile(
        r"(investor|shareholder|annual.?report|financial.?report|investor.?presentation|asx.?announcement|company.?report)",
        re.I,
    ),
    "governance": re.compile(
        r"(governance|corporate.?governance|charter|constitution|committee)",
        re.I,
    ),
    "team": re.compile(
        r"(board|management|team|director|leadership|executive|people|who.?we.?are)",
        re.I,
    ),
    "sustainability": re.compile(
        r"(sustainability|esg|environment|climate|responsible|social.?impact)",
        re.I,
    ),
    "careers": re.compile(r"(career|job|work.?with|join.?us|recruitment)", re.I),
    "contact": re.compile(r"(contact|enquir|get.?in.?touch)", re.I),
}

# Links to skip entirely
SKIP_PATTERNS = re.compile(
    r"(^#|^javascript:|^mailto:|^tel:|/privacy|/terms|/cookie|/disclaimer|/sitemap|"
    r"/wp-content/|/wp-admin/|\.pdf$|\.jpg$|\.png$|\.svg$|favicon|"
    r"oliveragency|stockhead\.com|mining\.com)",
    re.I,
)


def parse_links(links_text: str) -> list[str]:
    """Parse the Python list stored as text."""
    if not links_text:
        return []
    try:
        links = ast.literal_eval(links_text)
        if isinstance(links, list):
            return [str(l).strip() for l in links if l]
        return []
    except Exception:
        return []


def resolve_url(url: str, website: str | None) -> str | None:
    """Resolve relative URLs and clean up."""
    if not url or url in ("#", "/", ""):
        return None

    # Skip junk
    if SKIP_PATTERNS.search(url):
        return None

    # Resolve relative URLs
    parsed = urlparse(url)
    if not parsed.scheme and website:
        base = website.rstrip("/")
        if not base.startswith("http"):
            base = "https://" + base
        url = urljoin(base + "/", url)
        parsed = urlparse(url)

    # Must have a scheme and host
    if not parsed.scheme or not parsed.netloc:
        return None

    # Normalize
    url = url.rstrip("/")
    return url


def categorize_link(url: str) -> tuple[str | None, str | None]:
    """
    Returns (category, subcategory) for a URL.
    category: 'social_media' | 'corporate' | None
    subcategory: specific category name or None
    """
    # Check social media first
    for platform, pattern in SOCIAL_MEDIA_PATTERNS.items():
        if pattern.search(url):
            return ("social_media", platform)

    # Check corporate categories
    for category, pattern in CORPORATE_CATEGORIES.items():
        if pattern.search(url):
            return ("corporate", category)

    return (None, None)


def extract_structured_links(
    raw_links: list[str], website: str | None
) -> dict:
    """
    Extract and categorize useful links from raw scraped links.

    Returns:
    {
        "investor_relations": ["https://..."],
        "governance": ["https://..."],
        "team": ["https://..."],
        "sustainability": ["https://..."],
        "careers": ["https://..."],
        "contact": ["https://..."],
    }
    """
    corporate: dict[str, set[str]] = {
        cat: set() for cat in CORPORATE_CATEGORIES
    }
    social: dict[str, str | None] = {
        platform: None for platform in SOCIAL_MEDIA_PATTERNS
    }

    seen = set()
    for raw_url in raw_links:
        url = resolve_url(raw_url, website)
        if not url or url in seen:
            continue
        seen.add(url)

        cat, subcat = categorize_link(url)
        if cat == "social_media" and subcat:
            # Keep first (usually most relevant)
            if not social[subcat]:
                social[subcat] = url
        elif cat == "corporate" and subcat:
            corporate[subcat].add(url)

    # Convert sets to sorted lists
    corporate_links = {
        cat: sorted(urls) for cat, urls in corporate.items() if urls
    }
    social_links = {k: v for k, v in social.items() if v}

    return {"corporate": corporate_links, "social": social_links}


def main():
    parser = argparse.ArgumentParser(description="Migrate corporate links")
    parser.add_argument("--dry-run", action="store_true", help="Print changes without writing")
    parser.add_argument("--limit", type=int, default=0, help="Limit rows to process (0=all)")
    args = parser.parse_args()

    db_url = os.environ.get(
        "DATABASE_URL",
        "postgresql://admin:password@localhost:5438/shorts",
    )

    conn = psycopg2.connect(db_url)
    conn.autocommit = False

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            # Check if corporate_links column exists
            cur.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'company-metadata' AND column_name = 'corporate_links'
            """)
            if not cur.fetchone():
                print("Adding corporate_links JSONB column...")
                if not args.dry_run:
                    cur.execute("""
                        ALTER TABLE "company-metadata"
                        ADD COLUMN IF NOT EXISTS corporate_links JSONB DEFAULT '{}'::jsonb
                    """)
                    conn.commit()
                else:
                    print("  [DRY RUN] Would add corporate_links column")

            # Fetch all rows with links data
            query = """
                SELECT stock_code, website, links, social_media_links
                FROM "company-metadata"
                WHERE links IS NOT NULL AND links != ''
            """
            if args.limit:
                query += f" LIMIT {args.limit}"

            cur.execute(query)
            rows = cur.fetchall()
            print(f"Processing {len(rows)} companies with links data...")

            updated = 0
            social_updated = 0
            stats: dict[str, int] = {}

            for row in rows:
                stock_code = row["stock_code"]
                website = row["website"]
                raw_links = parse_links(row["links"])
                existing_social = row["social_media_links"] or {}

                if not raw_links:
                    continue

                result = extract_structured_links(raw_links, website)

                corporate_links = result["corporate"]
                new_social = result["social"]

                # Count categories
                for cat in corporate_links:
                    stats[cat] = stats.get(cat, 0) + 1

                if corporate_links:
                    if args.dry_run:
                        cats = ", ".join(
                            f"{k}({len(v)})" for k, v in corporate_links.items()
                        )
                        if updated < 10:
                            print(f"  {stock_code}: {cats}")
                    else:
                        cur.execute(
                            """
                            UPDATE "company-metadata"
                            SET corporate_links = %s
                            WHERE stock_code = %s
                            """,
                            (json.dumps(corporate_links), stock_code),
                        )
                    updated += 1

                # Update social media links if we found new ones
                if new_social:
                    merged_social = dict(existing_social) if isinstance(existing_social, dict) else {}
                    changed = False
                    for platform, url in new_social.items():
                        if url and (not merged_social.get(platform)):
                            merged_social[platform] = url
                            changed = True

                    if changed:
                        if not args.dry_run:
                            cur.execute(
                                """
                                UPDATE "company-metadata"
                                SET social_media_links = %s
                                WHERE stock_code = %s
                                """,
                                (json.dumps(merged_social), stock_code),
                            )
                        social_updated += 1

            if not args.dry_run:
                conn.commit()

            print(f"\n--- Results ---")
            print(f"Companies with corporate links: {updated}")
            print(f"Social media links updated: {social_updated}")
            print(f"\nCategory breakdown:")
            for cat, count in sorted(stats.items(), key=lambda x: -x[1]):
                print(f"  {cat}: {count} companies")

    except Exception as e:
        conn.rollback()
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
