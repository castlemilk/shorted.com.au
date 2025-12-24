#!/usr/bin/env python3
"""
Check sync status from database
"""
import os
import sys
from datetime import datetime, timedelta
from urllib.parse import urlparse

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    print("❌ psycopg2 not installed")
    print("   Install with: pip install psycopg2-binary")
    sys.exit(1)


def check_sync_status():
    """Check recent sync runs from sync_status table"""
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("❌ DATABASE_URL not set")
        print("   Set it with: export DATABASE_URL='postgresql://...'")
        sys.exit(1)

    try:
        # Parse connection string
        parsed = urlparse(db_url)
        conn = psycopg2.connect(
            host=parsed.hostname,
            port=parsed.port or 5432,
            database=parsed.path[1:] if parsed.path else "postgres",
            user=parsed.username,
            password=parsed.password,
            sslmode=(
                "require"
                if "pooler.supabase.com" in db_url or "sslmode" in db_url
                else "prefer"
            ),
        )

        cur = conn.cursor(cursor_factory=RealDictCursor)

        # Get recent sync runs
        cur.execute(
            """
            SELECT 
                run_id,
                started_at,
                completed_at,
                status,
                error_message,
                shorts_records_updated,
                prices_records_updated,
                prices_alpha_success,
                prices_yahoo_success,
                prices_failed,
                prices_skipped,
                total_duration_seconds,
                environment,
                hostname
            FROM sync_status
            ORDER BY started_at DESC
            LIMIT 10
        """
        )

        rows = cur.fetchall()

        if not rows:
            print("⚠️  No sync runs found in sync_status table")
            cur.close()
            conn.close()
            return

        print("=" * 80)
        print("📊 RECENT SYNC RUNS")
        print("=" * 80)
        print()

        for i, row in enumerate(rows, 1):
            print(f"Run #{i}: {row['run_id']}")
            print(f"  Started:    {row['started_at']}")
            if row["completed_at"]:
                print(f"  Completed:  {row['completed_at']}")
                duration = row["completed_at"] - row["started_at"]
                print(f"  Duration:   {duration}")
            else:
                print(f"  Status:     {row['status']} (not completed)")

            print(f"  Status:     {row['status']}")
            if row["error_message"]:
                print(f"  Error:      {row['error_message'][:100]}")

            print(f"  Shorts:     {row['shorts_records_updated']:,} records")
            print(f"  Prices:     {row['prices_records_updated']:,} records")
            print(f"    - Alpha Vantage: {row['prices_alpha_success']}")
            print(f"    - Yahoo Finance: {row['prices_yahoo_success']}")
            print(f"    - Failed:        {row['prices_failed']}")
            print(f"    - Skipped:       {row['prices_skipped']}")

            if row["total_duration_seconds"]:
                print(f"  Total Time: {row['total_duration_seconds']:.1f}s")

            if row["environment"]:
                print(f"  Environment: {row['environment']}")
            if row["hostname"]:
                print(f"  Hostname:    {row['hostname']}")

            print()

        # Check latest run
        latest = rows[0]
        now = (
            datetime.now(latest["started_at"].tzinfo)
            if latest["started_at"] and latest["started_at"].tzinfo
            else datetime.now()
        )
        time_since = now - latest["started_at"] if latest["started_at"] else None

        print("=" * 80)
        print("📈 SUMMARY")
        print("=" * 80)
        print(f"Latest run: {latest['status']}")
        if time_since:
            hours_ago = time_since.total_seconds() / 3600
            print(f"Last sync: {hours_ago:.1f} hours ago")

        if latest["status"] == "completed":
            print(f"✅ Last sync completed successfully")
            print(f"   - Updated {latest['prices_records_updated']:,} price records")
        elif latest["status"] == "running":
            print(f"⏳ Sync is currently running")
        elif latest["status"] == "failed":
            print(f"❌ Last sync failed")
            if latest["error_message"]:
                print(f"   Error: {latest['error_message'][:200]}")

        # Check stock prices recency
        cur.execute(
            """
            SELECT 
                COUNT(DISTINCT stock_code) as total_stocks,
                COUNT(DISTINCT CASE WHEN date >= CURRENT_DATE - INTERVAL '7 days' THEN stock_code END) as recent_stocks,
                MAX(date) as latest_price_date
            FROM stock_prices
        """
        )

        price_stats = cur.fetchone()
        if price_stats:
            print()
            print("📊 STOCK PRICES DATABASE")
            print(f"   Total stocks with data: {price_stats['total_stocks']}")
            print(
                f"   Stocks with recent data (7 days): {price_stats['recent_stocks']}"
            )
            if price_stats["latest_price_date"]:
                days_old = (
                    datetime.now().date() - price_stats["latest_price_date"]
                ).days
                print(
                    f"   Latest price date: {price_stats['latest_price_date']} ({days_old} days ago)"
                )

        cur.close()
        conn.close()

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    check_sync_status()


