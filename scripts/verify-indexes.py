#!/usr/bin/env python3
"""
Simple script to verify indexes are created and show basic stats.
"""

import os
import sys
import asyncio
import asyncpg

async def verify():
    database_url = os.getenv("DATABASE_URL")
    
    if not database_url:
        print("❌ DATABASE_URL environment variable required")
        return False

    try:
        print("🔌 Connecting to database...")
        conn = await asyncpg.connect(database_url, statement_cache_size=0)
        print("✅ Connected successfully\n")

        # Check all indexes on shorts table
        print("=" * 80)
        print("📑 ALL INDEXES ON 'shorts' TABLE")
        print("=" * 80)
        
        shorts_indexes = await conn.fetch("""
            SELECT indexname, indexdef
            FROM pg_indexes 
            WHERE tablename = 'shorts' 
            ORDER BY indexname
        """)

        if shorts_indexes:
            print(f"\nFound {len(shorts_indexes)} indexes:")
            for i, row in enumerate(shorts_indexes, 1):
                print(f"\n{i}. {row['indexname']}")
                # Show just the index type
                if 'USING btree' in row['indexdef']:
                    print("   Type: B-tree")
                elif 'USING gin' in row['indexdef']:
                    print("   Type: GIN")
        else:
            print("⚠️  No indexes found!")

        # Check company-metadata indexes
        print("\n" + "=" * 80)
        print("📑 INDEXES ON 'company-metadata' TABLE")
        print("=" * 80)
        
        cm_indexes = await conn.fetch("""
            SELECT indexname, indexdef
            FROM pg_indexes 
            WHERE tablename = 'company-metadata' 
            ORDER BY indexname
        """)

        if cm_indexes:
            print(f"\nFound {len(cm_indexes)} indexes:")
            for i, row in enumerate(cm_indexes, 1):
                print(f"\n{i}. {row['indexname']}")
        else:
            print("⚠️  No indexes found!")

        # Check for our performance indexes specifically
        print("\n" + "=" * 80)
        print("✅ PERFORMANCE INDEXES STATUS")
        print("=" * 80)
        
        perf_indexes = await conn.fetch("""
            SELECT indexname 
            FROM pg_indexes 
            WHERE tablename = 'shorts' 
            AND (
                indexname LIKE 'idx_shorts_date_product%' OR
                indexname LIKE 'idx_shorts_percent_date%' OR
                indexname LIKE 'idx_shorts_timeseries%' OR
                indexname LIKE 'idx_shorts_product_date_for%' OR
                indexname LIKE 'idx_shorts_date_desc%'
            )
            ORDER BY indexname
        """)
        
        expected_indexes = [
            'idx_shorts_date_desc_only',
            'idx_shorts_date_product_percent',
            'idx_shorts_percent_date',
            'idx_shorts_product_date_for_windows',
            'idx_shorts_timeseries_covering'
        ]
        
        found_names = [row['indexname'] for row in perf_indexes]
        
        print("\nPerformance indexes:")
        for idx_name in expected_indexes:
            status = "✅" if idx_name in found_names else "❌"
            print(f"  {status} {idx_name}")

        # Get table row counts
        print("\n" + "=" * 80)
        print("📊 TABLE STATISTICS")
        print("=" * 80)
        
        shorts_count = await conn.fetchval('SELECT COUNT(*) FROM shorts')
        cm_count = await conn.fetchval('SELECT COUNT(*) FROM "company-metadata"')
        max_date = await conn.fetchval('SELECT MAX("DATE") FROM shorts')
        
        print(f"\nshorts table: {shorts_count:,} rows")
        print(f"company-metadata table: {cm_count:,} rows")
        print(f"Latest data: {max_date}")

        await conn.close()
        
        print("\n" + "=" * 80)
        print("🎉 VERIFICATION COMPLETE")
        print("=" * 80)
        print(f"\n✅ Found {len(perf_indexes)}/5 performance indexes")
        print(f"✅ Total indexes on shorts: {len(shorts_indexes)}")
        print(f"✅ Total indexes on company-metadata: {len(cm_indexes)}")
        
        if len(perf_indexes) == 5:
            print("\n🚀 All performance indexes are active!")
            print("   Your treemap and top shorts queries should now be 10-20x faster!")
            return True
        else:
            print(f"\n⚠️  Only {len(perf_indexes)}/5 performance indexes found")
            return False

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    result = asyncio.run(verify())
    sys.exit(0 if result else 1)

