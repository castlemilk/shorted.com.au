#!/usr/bin/env python3
"""
Populate shorts table from ASIC CSV data files.

This script reads all CSV files in the data/shorts directory and loads them into
the PostgreSQL database. It handles encoding detection, schema normalization,
and efficient batch processing with Dask.

Usage:
    # Download CSVs first (if not already downloaded)
    cd scripts && npx ts-node sync-short-data.ts

    # Then run this script
    cd analysis
    export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
    python3 populate_shorts_from_csv.py

    # Or specify database URL directly
    python3 populate_shorts_from_csv.py --database-url "postgresql://..."
"""
import httpx
import os
import sys
import argparse
from pathlib import Path
from tqdm import tqdm
import pandas as pd
import dask
import dask.dataframe as dd
from dask.diagnostics import ProgressBar
import chardet
from datetime import datetime


# Configuration
SHORTS_DATA_DIRECTORY = "data/shorts"
DATA_URL = "https://download.asic.gov.au/short-selling/short-selling-data.json"
BASE_URL = "https://download.asic.gov.au/short-selling/"

# Expected schema for shorts data
EXPECTED_SCHEMA = {
    "DATE": "datetime64[ns]",
    "PRODUCT": "object",
    "PRODUCT_CODE": "object",
    "REPORTED_SHORT_POSITIONS": "float64",
    "TOTAL_PRODUCT_IN_ISSUE": "float64",
    "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS": "float64",
}


def setup_data_directory():
    """Ensure the data directory exists."""
    if not os.path.exists(SHORTS_DATA_DIRECTORY):
        os.makedirs(SHORTS_DATA_DIRECTORY)
        print(f"📁 Created directory: {SHORTS_DATA_DIRECTORY}")


def generate_download_url(record):
    """Generate download URL for each record."""
    date_str = str(record["date"])
    year, month, day = date_str[:4], date_str[4:6], date_str[6:]
    return f"{BASE_URL}RR{year}{month}{day}-{record['version']}-SSDailyAggShortPos.csv"


def download_file(client, url, file_path, progress_bar):
    """Download a file from a given URL to a specified path."""
    if not os.path.exists(file_path):
        try:
            with client.stream("GET", url) as response:
                response.raise_for_status()
                with open(file_path, "wb") as f:
                    for chunk in response.iter_bytes(chunk_size=8192):
                        f.write(chunk)
        except Exception as e:
            print(f"\n⚠️  Failed to download {url}: {e}")
    progress_bar.update(1)


def download_records(skip_download=False):
    """Download the short selling data from the ASIC website."""
    if skip_download:
        print("⏭️  Skipping download (--skip-download flag set)")
        return

    print("📥 Downloading short selling data from ASIC...")

    # Fetch the list of downloadable CSVs
    client = httpx.Client(timeout=30.0)
    try:
        response = client.get(DATA_URL)
        short_selling_data = response.json()
        print(f"📊 Found {len(short_selling_data)} files to download")

        # Initialize progress bar
        progress_bar = tqdm(total=len(short_selling_data), desc="Downloading")

        # Iterate through the records and download the CSV files
        for record in short_selling_data:
            file_url = generate_download_url(record)
            file_name = file_url.split("/")[-1]
            file_path = os.path.join(SHORTS_DATA_DIRECTORY, file_name)

            # Download the file if it does not already exist
            download_file(client, file_url, file_path, progress_bar=progress_bar)

        progress_bar.close()
        print("✅ Download complete")

    finally:
        client.close()


def read_csv_smart(file_path, expected_schema: dict):
    """
    Read an individual short data report CSV and normalize to the defined schema.

    Handles:
    - Different encodings (UTF-8, ISO-8859-1, etc.)
    - Varying column names and order
    - Missing columns
    - Type conversions
    """
    expected_columns = list(expected_schema.keys())

    # Detect file encoding
    try:
        with open(file_path, "rb") as f:
            result = chardet.detect(f.read(10000))
        encoding = result["encoding"] or "utf-8"
    except Exception:
        encoding = "utf-8"

    try:
        # Extract date from filename (format: RRYYYYMMDD-...)
        date_str = "".join(filter(str.isdigit, file_path.name.split("-")[0]))

        # Read CSV with detected encoding
        df = pd.read_csv(file_path, encoding=encoding, engine="python", sep=None)

        # Normalize column names
        df.columns = (
            df.columns.str.upper()
            .str.strip()
            .str.replace(" ", "_")
            .str.replace("%", "PERCENT")
        )

        # Ensure all expected columns are present
        for column in expected_columns:
            if column not in df.columns:
                df[column] = pd.NA

        # Reorder to match expected schema
        df = df[expected_columns]

        # Convert columns to expected types
        for column, dtype in expected_schema.items():
            if column != "DATE":  # Handle DATE separately
                df[column] = df[column].astype(dtype, errors="ignore")

        # Convert percentage to float64, coercing errors
        if (
            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
            in df.columns
        ):
            df["PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"] = (
                pd.to_numeric(
                    df["PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"],
                    errors="coerce",
                )
            )

        # Parse date from filename
        df["DATE"] = pd.to_datetime(date_str, format="%Y%m%d")

        # Strip whitespace from string columns
        df["PRODUCT_CODE"] = df["PRODUCT_CODE"].str.strip()
        df["PRODUCT"] = df["PRODUCT"].str.strip()

        return df

    except Exception as e:
        print(f"\n⚠️  Failed to read {file_path} with encoding {encoding}: {e}")
        # Return an empty DataFrame with expected columns if reading fails
        return pd.DataFrame(columns=expected_columns).astype(expected_schema)


def process_short_data_into_dataframe():
    """
    Read all the downloaded short selling CSV files into a DataFrame.
    Uses Dask for efficient parallel processing of thousands of files.
    """
    print("\n📊 Processing CSV files into DataFrame...")

    # Collect CSV files
    csv_files = list(Path(SHORTS_DATA_DIRECTORY).glob("*.csv"))

    if not csv_files:
        print(f"❌ No CSV files found in {SHORTS_DATA_DIRECTORY}")
        print(f"   Please download data first:")
        print(f"   cd scripts && npx ts-node sync-short-data.ts")
        sys.exit(1)

    print(f"📁 Found {len(csv_files)} CSV files")

    # Create delayed readings for parallel processing
    expected_columns = list(EXPECTED_SCHEMA.keys())
    delayed_readings = [
        dask.delayed(read_csv_smart)(file, EXPECTED_SCHEMA) for file in csv_files
    ]

    # Create meta DataFrame for Dask
    meta_df = pd.DataFrame(columns=expected_columns).astype(EXPECTED_SCHEMA)

    # Create Dask DataFrame
    ddf = dd.from_delayed(delayed_readings, meta=meta_df)

    # Compute to get final pandas DataFrame
    print("⚙️  Processing (this may take a few minutes)...")
    with ProgressBar():
        agg_df = ddf.compute()

    # Remove any rows with null stock codes
    initial_rows = len(agg_df)
    agg_df = agg_df.dropna(subset=["PRODUCT_CODE"])
    filtered_rows = initial_rows - len(agg_df)

    if filtered_rows > 0:
        print(f"🧹 Filtered {filtered_rows:,} rows with null stock codes")

    print(f"✅ Processed {len(agg_df):,} records")

    return agg_df


def write_short_data_to_postgres(
    df, table_name, connection_string, if_exists="replace"
):
    """
    Write the short selling data to a PostgreSQL database.

    Args:
        df: pandas DataFrame with shorts data
        table_name: name of the table to write to
        connection_string: PostgreSQL connection string
        if_exists: 'replace' to recreate table, 'append' to add to existing
    """
    print(f"\n💾 Writing data to PostgreSQL...")
    print(f"   Table: {table_name}")
    print(f"   Mode: {if_exists}")

    try:
        from sqlalchemy import create_engine

        engine = create_engine(connection_string)

        # Write in chunks for better memory management
        chunk_size = 10000
        total_chunks = (len(df) + chunk_size - 1) // chunk_size

        print(f"   Records: {len(df):,}")
        print(f"   Writing in {total_chunks} chunks...")

        # Progress bar for writing
        with tqdm(total=len(df), desc="Writing to DB") as pbar:
            for i in range(0, len(df), chunk_size):
                chunk = df.iloc[i : i + chunk_size]
                chunk.to_sql(
                    table_name,
                    engine,
                    if_exists=if_exists if i == 0 else "append",
                    index=False,
                    method="multi",
                )
                pbar.update(len(chunk))

        print("✅ Write complete")

        # Verify the write
        with engine.connect() as conn:
            result = conn.execute(f'SELECT COUNT(*) FROM "{table_name}"')
            count = result.fetchone()[0]
            print(f"✅ Verified: {count:,} records in database")

    except ImportError:
        print("❌ Missing required package: sqlalchemy")
        print("   Install with: pip install sqlalchemy psycopg2-binary")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error writing to database: {e}")
        sys.exit(1)


def print_summary(df):
    """Print summary statistics about the data."""
    print("\n" + "=" * 60)
    print("📊 DATA SUMMARY")
    print("=" * 60)

    print(f"Total records: {len(df):,}")
    print(f"Unique stocks: {df['PRODUCT_CODE'].nunique():,}")
    print(f"Date range: {df['DATE'].min().date()} to {df['DATE'].max().date()}")
    print(f"Memory usage: {df.memory_usage(deep=True).sum() / 1024**2:.1f} MB")

    # Top 10 stocks by number of records
    print("\n📈 Top 10 stocks by record count:")
    top_stocks = df["PRODUCT_CODE"].value_counts().head(10)
    for stock, count in top_stocks.items():
        print(f"   {stock}: {count:,} records")

    print("=" * 60)


def main():
    """Main function."""
    parser = argparse.ArgumentParser(
        description="Populate shorts table from ASIC CSV data",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL connection string (default: from DATABASE_URL env var)",
    )
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Skip downloading files (use existing CSVs)",
    )
    parser.add_argument(
        "--append",
        action="store_true",
        help="Append to existing table instead of replacing",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Process data but don't write to database",
    )

    args = parser.parse_args()

    # Validate database URL
    if not args.dry_run and not args.database_url:
        print("❌ DATABASE_URL not set")
        print("   Set it with: export DATABASE_URL='postgresql://...'")
        print("   Or use: --database-url 'postgresql://...'")
        sys.exit(1)

    print("🚀 POPULATE SHORTS TABLE FROM CSV DATA")
    print("=" * 60)
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    if not args.dry_run:
        # Hide password in output
        safe_url = (
            args.database_url.split("@")[-1]
            if "@" in args.database_url
            else args.database_url
        )
        print(f"Database: {safe_url}")
    print("=" * 60)

    # Setup
    setup_data_directory()

    # Download data (unless --skip-download)
    download_records(skip_download=args.skip_download)

    # Process CSV files
    df = process_short_data_into_dataframe()

    # Print summary
    print_summary(df)

    # Write to database (unless --dry-run)
    if args.dry_run:
        print("\n⏭️  Dry run - skipping database write")
    else:
        write_short_data_to_postgres(
            df,
            "shorts",
            args.database_url,
            if_exists="append" if args.append else "replace",
        )

    print("\n" + "=" * 60)
    print("✅ COMPLETE")
    print(f"Finished: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)


if __name__ == "__main__":
    main()
