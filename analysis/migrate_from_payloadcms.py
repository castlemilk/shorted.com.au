#!/usr/bin/env python3
"""
Migrate ALL remaining data from PayloadCMS Supabase DB → main Shorted PostgreSQL DB.

This script:
1. Reads all metadata + links from PayloadCMS
2. Compares with existing data in main DB
3. Fills gaps (companies missing website, address, listing_date, summary, details, etc.)
4. Imports media/logo references
5. Reports what was migrated

Usage:
  # Dry run (just report gaps)
  python3 migrate_from_payloadcms.py --dry-run

  # Run migration
  python3 migrate_from_payloadcms.py

  # Against production main DB
  MAIN_DATABASE_URL=postgresql://... python3 migrate_from_payloadcms.py
"""

import argparse
import json
import os
import sys

import psycopg2
import psycopg2.extras


CMS_DB_URL = os.environ.get(
    "CMS_DATABASE_URL",
    "postgresql://postgres.vfzzkelbpyjdvuujyrpu:GpbQqFc7rwe3gF0v@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres",
)

MAIN_DB_URL = os.environ.get(
    "MAIN_DATABASE_URL",
    os.environ.get("DATABASE_URL", "postgresql://admin:password@localhost:5438/shorts"),
)

# Fields to copy from CMS → main DB when main DB has empty/null values
FIELDS_TO_FILL = [
    "website",
    "address",
    "listing_date",
    "summary",
    "details",
    "industry",
    "company_logo_link",
    "logo_gcs_url",
]


def main():
    parser = argparse.ArgumentParser(description="Migrate data from PayloadCMS → main DB")
    parser.add_argument("--dry-run", action="store_true", help="Report gaps without writing")
    args = parser.parse_args()

    print(f"CMS DB: {CMS_DB_URL[:50]}...")
    print(f"Main DB: {MAIN_DB_URL[:50]}...")
    print()

    cms_conn = psycopg2.connect(CMS_DB_URL)
    main_conn = psycopg2.connect(MAIN_DB_URL)
    main_conn.autocommit = False

    try:
        # ---------------------------------------------------------------
        # 1. Load all CMS metadata
        # ---------------------------------------------------------------
        with cms_conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cms_cur:
            cms_cur.execute("""
                SELECT stock_code, company_name, website, address, listing_date,
                       summary, details, industry, market_cap,
                       company_logo_link, logo_gcs_url
                FROM metadata
                WHERE stock_code IS NOT NULL AND stock_code != ''
            """)
            cms_rows = {row["stock_code"]: dict(row) for row in cms_cur.fetchall()}
            print(f"CMS: {len(cms_rows)} companies loaded")

            # Load CMS links
            cms_cur.execute("""
                SELECT m.stock_code, ml.link
                FROM metadata_links ml
                JOIN metadata m ON m.id = ml._parent_id
                WHERE ml.link IS NOT NULL AND ml.link != ''
                ORDER BY m.stock_code, ml._order
            """)
            cms_links: dict[str, list[str]] = {}
            for row in cms_cur.fetchall():
                code = row["stock_code"]
                if code not in cms_links:
                    cms_links[code] = []
                cms_links[code].append(row["link"])
            print(f"CMS: {len(cms_links)} companies have structured links ({sum(len(v) for v in cms_links.values())} total links)")

            # Load CMS media (logos)
            cms_cur.execute("""
                SELECT m.stock_code, med.url, med.filename, med.mime_type, med.width, med.height
                FROM metadata m
                JOIN media med ON m.id = med.id
                WHERE med.url IS NOT NULL
            """)
            cms_media = {}
            for row in cms_cur.fetchall():
                if row["stock_code"]:
                    cms_media[row["stock_code"]] = dict(row)
            print(f"CMS: {len(cms_media)} companies have media records")

        # ---------------------------------------------------------------
        # 2. Load main DB metadata
        # ---------------------------------------------------------------
        with main_conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as main_cur:
            main_cur.execute("""
                SELECT stock_code, company_name, website, address, listing_date,
                       summary, details, industry, market_cap,
                       company_logo_link, logo_gcs_url, links, images
                FROM "company-metadata"
            """)
            main_rows = {row["stock_code"]: dict(row) for row in main_cur.fetchall()}
            print(f"Main DB: {len(main_rows)} companies loaded")

        # ---------------------------------------------------------------
        # 3. Find gaps and fill them
        # ---------------------------------------------------------------
        stats = {
            "fields_filled": {f: 0 for f in FIELDS_TO_FILL},
            "new_companies_inserted": 0,
            "market_cap_updated": 0,
            "company_name_filled": 0,
        }

        updates: list[tuple[dict, str]] = []  # (updates_dict, stock_code)
        inserts: list[dict] = []

        for stock_code, cms_data in cms_rows.items():
            main_data = main_rows.get(stock_code)

            if main_data is None:
                # Company exists in CMS but not in main DB — insert it
                inserts.append(cms_data)
                stats["new_companies_inserted"] += 1
                continue

            # Company exists in both — fill missing fields
            field_updates = {}
            for field in FIELDS_TO_FILL:
                cms_val = cms_data.get(field)
                main_val = main_data.get(field)

                # Fill if main DB is empty but CMS has data
                if cms_val and (not main_val or main_val.strip() == ""):
                    field_updates[field] = cms_val
                    stats["fields_filled"][field] += 1

            # Update market_cap if CMS has it and main DB doesn't
            if cms_data.get("market_cap") and not main_data.get("market_cap"):
                field_updates["market_cap"] = cms_data["market_cap"]
                stats["market_cap_updated"] += 1

            # Fill company_name if missing
            if cms_data.get("company_name") and not main_data.get("company_name"):
                field_updates["company_name"] = cms_data["company_name"]
                stats["company_name_filled"] += 1

            if field_updates:
                updates.append((field_updates, stock_code))

        # ---------------------------------------------------------------
        # 4. Report
        # ---------------------------------------------------------------
        print(f"\n--- Gap Analysis ---")
        print(f"New companies to insert: {stats['new_companies_inserted']}")
        print(f"Company names to fill: {stats['company_name_filled']}")
        print(f"Market caps to fill: {stats['market_cap_updated']}")
        print(f"\nField gaps to fill:")
        for field, count in stats["fields_filled"].items():
            print(f"  {field}: {count} companies")
        print(f"\nTotal companies to update: {len(updates)}")

        if args.dry_run:
            # Show sample updates
            print(f"\nSample updates (first 10):")
            for field_updates, stock_code in updates[:10]:
                fields = ", ".join(f"{k}={v[:40] if isinstance(v, str) else v}" for k, v in field_updates.items())
                print(f"  {stock_code}: {fields}")

            if inserts:
                print(f"\nSample inserts (first 10):")
                for cms_data in inserts[:10]:
                    print(f"  {cms_data['stock_code']}: {cms_data.get('company_name', 'N/A')}")
            return

        # ---------------------------------------------------------------
        # 5. Apply updates
        # ---------------------------------------------------------------
        with main_conn.cursor() as main_cur:
            # Updates
            for field_updates, stock_code in updates:
                set_clauses = []
                values = []
                for field, value in field_updates.items():
                    set_clauses.append(f'"{field}" = %s')
                    values.append(value)
                values.append(stock_code)

                sql = f"""
                    UPDATE "company-metadata"
                    SET {", ".join(set_clauses)}
                    WHERE stock_code = %s
                """
                main_cur.execute(sql, values)

            # Inserts
            for cms_data in inserts:
                main_cur.execute("""
                    INSERT INTO "company-metadata" (
                        stock_code, company_name, website, address, listing_date,
                        summary, details, industry, market_cap,
                        company_logo_link, logo_gcs_url
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (stock_code) DO NOTHING
                """, (
                    cms_data["stock_code"],
                    cms_data.get("company_name"),
                    cms_data.get("website"),
                    cms_data.get("address"),
                    cms_data.get("listing_date"),
                    cms_data.get("summary"),
                    cms_data.get("details"),
                    cms_data.get("industry"),
                    cms_data.get("market_cap"),
                    cms_data.get("company_logo_link"),
                    cms_data.get("logo_gcs_url"),
                ))

            main_conn.commit()

        print(f"\n--- Applied ---")
        print(f"Updated: {len(updates)} companies")
        print(f"Inserted: {len(inserts)} new companies")

        # ---------------------------------------------------------------
        # 6. Verify
        # ---------------------------------------------------------------
        with main_conn.cursor() as main_cur:
            main_cur.execute("""
                SELECT
                    count(1) as total,
                    count(nullif(website, '')) as has_website,
                    count(nullif(address, '')) as has_address,
                    count(nullif(listing_date, '')) as has_listing_date,
                    count(nullif(company_logo_link, '')) as has_logo_link,
                    count(nullif(logo_gcs_url, '')) as has_gcs_logo,
                    count(nullif(summary, '')) as has_summary,
                    count(nullif(details, '')) as has_details,
                    count(nullif(industry, '')) as has_industry,
                    count(market_cap) as has_market_cap
                FROM "company-metadata"
            """)
            row = main_cur.fetchone()
            print(f"\n--- Post-Migration Coverage ---")
            cols = ["total", "has_website", "has_address", "has_listing_date",
                    "has_logo_link", "has_gcs_logo", "has_summary", "has_details",
                    "has_industry", "has_market_cap"]
            for col, val in zip(cols, row):
                print(f"  {col}: {val}")

    except Exception as e:
        main_conn.rollback()
        print(f"Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        cms_conn.close()
        main_conn.close()


if __name__ == "__main__":
    main()
