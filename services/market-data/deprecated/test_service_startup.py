"""
Simple test to verify the Cloud Run service can start.
"""

import os
import sys

# Set environment variables (DATABASE_URL and ALPHA_VANTAGE_API_KEY must be set externally)
if "DATABASE_URL" not in os.environ:
    print("ERROR: DATABASE_URL environment variable must be set")
    sys.exit(1)
os.environ.setdefault("DATA_PROVIDER", "alpha_vantage")
if "ALPHA_VANTAGE_API_KEY" not in os.environ:
    print("ERROR: ALPHA_VANTAGE_API_KEY environment variable must be set")
    sys.exit(1)

try:
    print("Testing imports...")
    from data_providers.factory import DataProviderFactory
    print("✅ Data provider factory imported")
    
    from data_providers.alpha_vantage import AlphaVantageProvider
    print("✅ Alpha Vantage provider imported")
    
    from fastapi import FastAPI
    print("✅ FastAPI imported")
    
    print("Testing provider creation...")
    provider = DataProviderFactory.create_provider("alpha_vantage", api_key=os.environ["ALPHA_VANTAGE_API_KEY"])
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

