"""
Simple test to verify the Cloud Run service can start.
"""

import os
import sys

# Set environment variables
os.environ["DATABASE_URL"] = "postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"
os.environ["DATA_PROVIDER"] = "alpha_vantage"
os.environ["ALPHA_VANTAGE_API_KEY"] = "UOI9AM59F03A0WZC"

try:
    print("Testing imports...")
    from data_providers.factory import DataProviderFactory
    print("✅ Data provider factory imported")
    
    from data_providers.alpha_vantage import AlphaVantageProvider
    print("✅ Alpha Vantage provider imported")
    
    from fastapi import FastAPI
    print("✅ FastAPI imported")
    
    print("Testing provider creation...")
    provider = DataProviderFactory.create_provider("alpha_vantage", api_key="UOI9AM59F03A0WZC")
    print(f"✅ Provider created: {provider.get_provider_name()}")
    
    print("Testing FastAPI app creation...")
    app = FastAPI()
    print("✅ FastAPI app created")
    
    print("🎉 All tests passed! Service should start successfully.")
    
except Exception as e:
    print(f"❌ Error: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

