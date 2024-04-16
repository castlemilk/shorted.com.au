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

# Define the directory to store CSV files and ensure it exists
SHORTS_DATA_DIRECTORY = "data/shorts"
if not os.path.exists(SHORTS_DATA_DIRECTORY):
    os.makedirs(SHORTS_DATA_DIRECTORY)

# URLs for fetching the JSON data and the base URL for downloads
data_url = "https://download.asic.gov.au/short-selling/short-selling-data.json"
base_url = "https://download.asic.gov.au/short-selling/"

# Initialize an HTTP client
client = httpx.Client()

# Fetch the list of downloadable CSVs
response = client.get(data_url)
short_selling_data = response.json()



def generate_download_url(record):
    """Generate download URL for each record."""
    date_str = str(record['date'])
    year, month, day = date_str[:4], date_str[4:6], date_str[6:]
    return f"{base_url}RR{year}{month}{day}-{record['version']}-SSDailyAggShortPos.csv"

def download_file(url, file_path, progress_bar):
    """Download a file from a given URL to a specified path."""
    if not os.path.exists(file_path):
        with client.stream("GET", url) as response:
            response.raise_for_status()
            with open(file_path, 'wb') as f:
                for chunk in response.iter_bytes(chunk_size=8192):
                    f.write(chunk)
        progress_bar.update(1)
    else:
        progress_bar.update(1)

def download_records():
    """
    Download the short selling data from the ASIC website.
    """
    # Initialize progress bar
    progress_bar = tqdm(total=len(short_selling_data))
    # Iterate through the records and download the CSV files
    for record in short_selling_data:
        file_url = generate_download_url(record)
        file_name = file_url.split('/')[-1]
        file_path = os.path.join(SHORTS_DATA_DIRECTORY, file_name)
        
        # Download the file if it does not already exist
        download_file(file_url, file_path, progress_bar=progress_bar)

    progress_bar.close()

def read_csv_smart(file_path, expected_schema: dict):
    """
    Read an individual short data report for a given day in CSV format and normalises to the defined schema.
    """
    expected_columns = list(expected_schema.keys())
    # Detect file encoding
    with open(file_path, 'rb') as f:
        result = chardet.detect(f.read(10000))
    encoding = result['encoding']

    try:
        date_str = ''.join(filter(str.isdigit, file_path.name.split('-')[0]))
        df = pd.read_csv(file_path, encoding=encoding, engine='python', sep=None)
        # Normalize column names
        df.columns = df.columns.str.upper().str.strip().str.replace(' ', '_').str.replace('%', 'PERCENT')
            
        # Ensure all expected columns are present, even if they're missing in the CSV, and reorder to match expected schema
        for column in expected_columns:
            if column not in df.columns:
                df[column] = pd.NA
        df = df[expected_columns]

        # Convert columns to expected types
        for column, dtype in expected_schema.items():
            df[column] = df[column].astype(dtype, errors='ignore')
          # Convert '%_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS' to float64, coercing errors
        if 'PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS' in df.columns:
            df['PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS'] = pd.to_numeric(df['PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS'], errors='coerce')
        df['DATE'] = pd.to_datetime(date_str, format='%Y%m%d')

        # strip white space
        df['PRODUCT_CODE']=df['PRODUCT_CODE'].str.strip()
        df['PRODUCT']=df['PRODUCT'].str.strip()
        return df
    except Exception as e:
        print(f"Failed to read {file_path} with encoding {encoding}: {e}")
        # Return an empty DataFrame with expected columns if reading fails
        return pd.DataFrame(columns=expected_columns).astype(expected_schema)
    
def process_short_data_into_dataframe():
    """
    Read all the downloaded short selling data into a DataFrame.
    """
    # Define the expected schema (column names and their order)
    expected_schema = {
        'DATE': 'datetime64[ns]',
        'PRODUCT': 'object',
        'PRODUCT_CODE': 'object',
        'REPORTED_SHORT_POSITIONS': 'float64',
        'TOTAL_PRODUCT_IN_ISSUE': 'float64',
        'PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS': 'float64'
    }
    expected_columns = list(expected_schema.keys())
    # Collect CSV files and read them using Dask
    csv_files = list(Path(SHORTS_DATA_DIRECTORY).glob('*.csv'))
    delayed_readings = [dask.delayed(read_csv_smart)(file, expected_schema) for file in csv_files]
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
    engine = create_engine(connection_string)
    df.to_sql(table_name, engine, if_exists='replace', index=False)


app = FastAPI()





@app.post("/process")
async def process_full_workflow():
    """
    This endpoint handles the full workflow of downloading,
    processing, and uploading short selling data.
    """
    try:
        # Download data
        download_records()

        # Process the data into a DataFrame
        df = process_short_data_into_dataframe()

        # Write the DataFrame to PostgreSQL
        write_short_data_to_postgres(df, 'shorts', os.environ.get('DATABASE_URL', "postgresql://admin:password@localhost:5432/shorts"))

        return {"message": "Workflow completed successfully."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An error occurred during the workflow: {str(e)}")
