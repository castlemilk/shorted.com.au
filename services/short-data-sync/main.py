from fastapi import FastAPI, HTTPException
import os
import httpx
import os
from tqdm import tqdm
import pandas as pd
import dask
from pathlib import Path
import dask.dataframe as dd
from dask.diagnostics import ProgressBar
import chardet
from google.cloud import storage

# Define the directory to store CSV files and ensure it exists
SHORTS_DATA_DIRECTORY = "data/shorts"
if not os.path.exists(SHORTS_DATA_DIRECTORY):
    os.makedirs(SHORTS_DATA_DIRECTORY)

# URLs for fetching the JSON data and the base URL for downloads
data_url = "https://download.asic.gov.au/short-selling/short-selling-data.json"
base_url = "https://download.asic.gov.au/short-selling/"
TABLE_NAME="shorts"
# GCS bucket and directory settings
BUCKET_NAME = "shorted-short-selling-data"
GCS_FOLDER = "data/shorts"
INDEX_FILE_PATH = "downloaded_files_index.csv"
INDEX_FILE_GCS_PATH = f"{GCS_FOLDER}/downloaded_files_index.json"


def load_index_file(bucket):
    """Load the index file from gcs into a dataframe"""
    blob = bucket.blob(INDEX_FILE_GCS_PATH)
    blob.download_to_filename(INDEX_FILE_PATH)
    df = pd.read_json(INDEX_FILE_PATH)
    return df


def update_index_file(bucket, downloaded_files: list[str]):
    """Update the index file with a new filename."""
    existing_df = load_index_file(bucket)
    new_records = pd.DataFrame(downloaded_files, columns=["filename"])
    df = pd.concat([existing_df, new_records], ignore_index=True)
    blob = bucket.blob(INDEX_FILE_GCS_PATH)
    blob.upload_from_string(df.to_json(index=False))


def bootstrap_index_file(bucket):
    """Bootstrap the index file by listing objects in the GCS bucket."""
    blobs = bucket.list_blobs(prefix=GCS_FOLDER)
    blob_names = [blob.name.split("/")[-1] for blob in blobs if "/" in blob.name]
    df = pd.DataFrame(blob_names, columns=["filename"])
    blob = bucket.blob(INDEX_FILE_GCS_PATH)
    blob.upload_from_string(df.to_json(index=False))
    print(f"Index file bootstrapped {len(df)} items")


def generate_download_url(record):
    """Generate download URL for each record."""
    date_str = str(record["date"])
    year, month, day = date_str[:4], date_str[4:6], date_str[6:]
    return f"{base_url}RR{year}{month}{day}-{record['version']}-SSDailyAggShortPos.csv"


def download_file(url, file_path, progress_bar):
    """Download a file from a given URL to a specified path."""
    if not os.path.exists(file_path):
        with client.stream("GET", url) as response:
            print("streaming: ", url)
            response.raise_for_status()
            with open(file_path, "wb") as f:
                for chunk in response.iter_bytes(chunk_size=8192):
                    f.write(chunk)
        progress_bar.update(1)
    else:
        progress_bar.update(1)


def download_records(short_selling_data):
    """
    Download the short selling data from the ASIC website.
    """
    # Initialize progress bar
    progress_bar = tqdm(total=len(short_selling_data))
    # Iterate through the records and download the CSV files
    for record in short_selling_data:
        file_url = generate_download_url(record)
        file_name = file_url.split("/")[-1]
        file_path = os.path.join(SHORTS_DATA_DIRECTORY, file_name)

        # Download the file if it does not already exist
        download_file(file_url, file_path, progress_bar=progress_bar)

    progress_bar.close()


def gcs_file_exists(bucket, blob_name):
    """Check if a file exists in GCS."""
    blob = bucket.blob(blob_name)
    return blob.exists()


def upload_file_to_gcs(bucket, url, file_name, progress_bar) -> bool:
    """Download a file from a given URL to GCS if it does not already exist."""

    index_df = load_index_file(bucket)
    # if not gcs_file_exists(bucket, blob_name):
    if file_name not in index_df.index:
        blob = bucket.blob(f"{GCS_FOLDER}/{file_name}")
        with client.stream("GET", url) as response:
            response.raise_for_status()
            blob.upload_from_string(response.read())
            with open(os.path.join(SHORTS_DATA_DIRECTORY, file_name), "wb") as f:
                for chunk in response.iter_bytes(chunk_size=8192):
                    f.write(chunk)

        progress_bar.update(1)
        return True
    else:
        progress_bar.update(1)
        return False


def download_records_gcs(short_selling_data):
    """Download the short selling data from the ASIC website."""
    print("Downloading files to GCS...")
    storage_client = storage.Client()
    bucket = storage_client.bucket(BUCKET_NAME)
    index = load_index_file(bucket)
    print(f"Index file loaded with {len(index)} records.")
    print(index.head())
    records_to_download = [
        record
        for record in short_selling_data
        if generate_download_url(record).split("/")[-1] not in index["filename"].values
    ]
    progress_bar = tqdm(total=len(records_to_download))
    downloaded_files = []
    for record in records_to_download:
        url = generate_download_url(record)
        file_name = url.split("/")[-1]
        downloaded = upload_file_to_gcs(bucket, url, file_name, progress_bar)
        if downloaded:
            downloaded_files.append(file_name)
    update_index_file(bucket, downloaded_files)
    progress_bar.close()


def read_csv_from_disk(file_path, expected_schema: dict):
    """
    Read an individual short data report for a given day in CSV format and normalises to the defined schema.
    """
    expected_columns = list(expected_schema.keys())
    # Detect file encoding
    with open(file_path, "rb") as f:
        result = chardet.detect(f.read(10000))
    encoding = result["encoding"]

    try:
        date_str = "".join(filter(str.isdigit, file_path.name.split("-")[0]))
        df = pd.read_csv(file_path, encoding=encoding, engine="python", sep=None)
        # Normalize column names
        df.columns = (
            df.columns.str.upper()
            .str.strip()
            .str.replace(" ", "_")
            .str.replace("%", "PERCENT")
        )

        # Ensure all expected columns are present, even if they're missing in the CSV, and reorder to match expected schema
        for column in expected_columns:
            if column not in df.columns:
                df[column] = pd.NA
        df = df[expected_columns]

        # Convert columns to expected types
        for column, dtype in expected_schema.items():
            df[column] = df[column].astype(dtype, errors="ignore")
        # Convert '%_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS' to float64, coercing errors
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
        df["DATE"] = pd.to_datetime(date_str, format="%Y%m%d")

        # strip white space
        df["PRODUCT_CODE"] = df["PRODUCT_CODE"].str.strip()
        df["PRODUCT"] = df["PRODUCT"].str.strip()
        return df
    except Exception as e:
        print(f"Failed to read {file_path} with encoding {encoding}: {e}")
        # Return an empty DataFrame with expected columns if reading fails
        return pd.DataFrame(columns=expected_columns).astype(expected_schema)


def download_records_gcs(short_selling_data):
    """Download the short selling data from the ASIC website."""
    print("Downloading files to GCS...")
    storage_client = storage.Client()
    bucket = storage_client.bucket(BUCKET_NAME)
    index = load_index_file(bucket)
    print(f"Index file loaded with {len(index)} records.")
    print(index.head())
    records_to_download = [
        record
        for record in short_selling_data
        if generate_download_url(record).split("/")[-1] not in index["filename"].values
    ]
    progress_bar = tqdm(total=len(records_to_download))
    downloaded_files = []
    for record in records_to_download:
        url = generate_download_url(record)
        file_name = url.split("/")[-1]
        downloaded = upload_file_to_gcs(bucket, url, file_name, progress_bar)
        if downloaded:
            downloaded_files.append(file_name)
    update_index_file(bucket, downloaded_files)
    progress_bar.close()


def read_csv_from_gcs(bucket, file_path, expected_schema: dict):
    """
    Read an individual short data report for a given day in CSV format and normalises to the defined schema.
    """
    expected_columns = list(expected_schema.keys())
    blob = bucket.blob(f"{GCS_FOLDER}/{file_path.name}")
    blob.download_to_filename(file_path)
    # Detect file encoding
    with open(file_path, "rb") as f:
        result = chardet.detect(f.read(10000))
    encoding = result["encoding"]

    try:
        date_str = "".join(filter(str.isdigit, file_path.name.split("-")[0]))
        df = pd.read_csv(file_path, encoding=encoding, engine="python", sep=None)
        # Normalize column names
        df.columns = (
            df.columns.str.upper()
            .str.strip()
            .str.replace(" ", "_")
            .str.replace("%", "PERCENT")
        )

        # Ensure all expected columns are present, even if they're missing in the CSV, and reorder to match expected schema
        for column in expected_columns:
            if column not in df.columns:
                df[column] = pd.NA
        df = df[expected_columns]

        # Convert columns to expected types
        for column, dtype in expected_schema.items():
            df[column] = df[column].astype(dtype, errors="ignore")
        # Convert '%_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS' to float64, coercing errors
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
        df["DATE"] = pd.to_datetime(date_str, format="%Y%m%d")

        # strip white space
        df["PRODUCT_CODE"] = df["PRODUCT_CODE"].str.strip()
        df["PRODUCT"] = df["PRODUCT"].str.strip()
        return df
    except Exception as e:
        print(f"Failed to read {file_path} with encoding {encoding}: {e}")
        # Return an empty DataFrame with expected columns if reading fails
        return pd.DataFrame(columns=expected_columns).astype(expected_schema)


def process_short_data_into_dataframe():
    """
    Read all the downloaded short selling data into a DataFrame.
    """
    storage_client = storage.Client()
    bucket = storage_client.bucket(BUCKET_NAME)
    # Define the expected schema (column names and their order)
    expected_schema = {
        "DATE": "datetime64[ns]",
        "PRODUCT": "object",
        "PRODUCT_CODE": "object",
        "REPORTED_SHORT_POSITIONS": "float64",
        "TOTAL_PRODUCT_IN_ISSUE": "float64",
        "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS": "float64",
    }
    expected_columns = list(expected_schema.keys())
    # Collect CSV files and read them using Dask
    csv_files = list(Path(SHORTS_DATA_DIRECTORY).glob("*.csv"))
    if len(csv_files) == 0:
        return None
    delayed_readings = [
        dask.delayed(read_csv_from_disk)(file, expected_schema)
        for file in csv_files
    ]
    # Use the defined schema to create the meta DataFrame for Dask
    meta_df = pd.DataFrame(columns=expected_columns).astype(expected_schema)

    # Create a Dask DataFrame from the delayed objects
    ddf = dd.from_delayed(delayed_readings, meta=meta_df)

    # Compute the Dask DataFrame to get the final pandas DataFrame
    with ProgressBar():
        agg_df = ddf.compute()
    return agg_df


def write_short_data_to_postgres(df, table_name, connection_string):
    """
    Write the short selling data to a PostgreSQL database.
    """
    from sqlalchemy import create_engine
    def chunker(seq, size):
        return (seq[pos:pos + size] for pos in range(0, len(seq), size))

    engine = create_engine(connection_string)
    chunksize = int(len(df) / 30)
    with tqdm(total=len(df)) as pbar:
        for i, df in enumerate(chunker(df, chunksize)):
            df.to_sql(table_name, engine, if_exists="append", index=False) 
            pbar.update(chunksize)
            tqdm._instances.clear()
app = FastAPI()
# Initialize an HTTP client
client = httpx.Client()


@app.post("/process")
async def process_full_workflow():
    """
    This endpoint handles the full workflow of downloading,
    processing, and uploading short selling data.
    """
    try:

        # Fetch the list of downloadable CSVs
        response = client.get(data_url)
        short_selling_data = response.json()

        # Download data
        download_records_gcs(short_selling_data)

        # Process the data into a DataFrame
        df = process_short_data_into_dataframe()

        # Write the DataFrame to PostgreSQL
        write_short_data_to_postgres(
            df,
            TABLE_NAME,
            os.environ.get(
                "DATABASE_URL", "postgresql://admin:password@localhost:5432/shorts"
            ),
        )

        return {"message": "Workflow completed successfully."}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"An error occurred during the workflow: {str(e)}"
        )


@app.post("/bootstrap")
async def bootstrap():
    """Event that runs on application startup to ensure index file is ready."""
    storage_client = storage.Client()
    bucket = storage_client.bucket(BUCKET_NAME)
    if not Path(INDEX_FILE_PATH).exists():
        bootstrap_index_file(bucket)


if __name__ == "__main__":
    """
    This endpoint handles the full workflow of downloading,
    processing, and uploading short selling data.
    """
    if (os.environ.get("DATABASE_URL") is None):
        print("DATABASE_URL must be set in environment variables.")
        exit(1)
    # Fetch the list of downloadable CSVs
    response = client.get(data_url)
    short_selling_data = response.json()

    # Download data
    download_records_gcs(short_selling_data)

    # Process the data into a DataFrame
    processed_data = process_short_data_into_dataframe()
    if processed_data and len(processed_data) > 0:
        # Write the DataFrame to PostgreSQL
        write_short_data_to_postgres(
            processed_data,
            TABLE_NAME,
            os.environ.get("DATABASE_URL"),
        )
        print(f"Workflow completed successfully. added ${len(processed_data)} records.")
        exit(0)
    else:
        print("No new files to process.")
        exit(0)
    
