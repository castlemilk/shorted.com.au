#!/usr/bin/env python3
"""
Lightweight test script for company metadata enrichment pipeline.
Tests with just 3 companies to validate the setup.
"""

import httpx
import pandas as pd
from openai import OpenAI
import json
from sqlalchemy import create_engine, text
import os
from datetime import datetime
import time
from typing import Dict, List, Any
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configuration
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')
DATABASE_URL = os.getenv('DATABASE_URL')
CMS_DATABASE_URL = os.getenv('CMS_DATABASE_URL', DATABASE_URL)
GCS_LOGO_BASE_URL = os.getenv('GCS_LOGO_BASE_URL', 'https://storage.googleapis.com/shorted-company-logos/logos')

print("🧪 Company Metadata Enrichment - Test Run")
print("=" * 60)

# Test 1: OpenAI Connection
print("\n1️⃣  Testing OpenAI API connection...")
try:
    client = OpenAI(api_key=OPENAI_API_KEY)
    # Simple test to validate API key
    response = client.chat.completions.create(
        model="gpt-4o-mini",  # Use cheaper model for test
        messages=[{"role": "user", "content": "Say 'API connection successful' in 3 words"}],
        max_tokens=10
    )
    print(f"   ✅ OpenAI API: {response.choices[0].message.content}")
except Exception as e:
    print(f"   ❌ OpenAI API Error: {e}")
    exit(1)

# Test 2: Database Connection
print("\n2️⃣  Testing database connection...")
try:
    engine = create_engine(DATABASE_URL)
    with engine.connect() as conn:
        result = conn.execute(text('SELECT COUNT(*) FROM "company-metadata"'))
        count = result.scalar()
        print(f"   ✅ Database connected: {count} companies in metadata table")
except Exception as e:
    print(f"   ❌ Database Error: {e}")
    exit(1)

# Test 3: Fetch Sample Companies
print("\n3️⃣  Fetching 3 sample companies...")
try:
    query = text("""
        SELECT stock_code, company_name, industry, website
        FROM "company-metadata"
        WHERE stock_code IS NOT NULL
        ORDER BY company_name
        LIMIT 3
    """)
    
    with engine.connect() as conn:
        df = pd.read_sql(query, conn)
    
    if len(df) == 0:
        print("   ❌ No companies found in database")
        exit(1)
    
    print(f"   ✅ Fetched {len(df)} companies:")
    for _, row in df.iterrows():
        print(f"      - {row['stock_code']}: {row['company_name']}")
except Exception as e:
    print(f"   ❌ Fetch Error: {e}")
    exit(1)

# Test 4: Enrich ONE Company (as a test)
print("\n4️⃣  Testing enrichment on ONE company...")
test_company = df.iloc[0]
print(f"   Testing with: {test_company['stock_code']} - {test_company['company_name']}")

try:
    user_prompt = f"""
    Provide a brief company profile for {test_company['company_name']} (ASX: {test_company['stock_code']}).
    
    Return JSON with:
    - tags: array of 3-5 specialty tags
    - enhanced_summary: 100-200 word overview
    
    Keep it concise for testing purposes.
    """
    
    response = client.chat.completions.create(
        model="gpt-4o-mini",  # Cheaper model for testing
        messages=[
            {"role": "system", "content": "You are a financial analyst. Return valid JSON only."},
            {"role": "user", "content": user_prompt}
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
        max_tokens=500
    )
    
    enriched_data = json.loads(response.choices[0].message.content)
    print(f"   ✅ Enrichment successful!")
    print(f"      Tags: {enriched_data.get('tags', [])}")
    print(f"      Summary length: {len(enriched_data.get('enhanced_summary', ''))} chars")
    
except Exception as e:
    print(f"   ❌ Enrichment Error: {e}")
    exit(1)

# Test 5: Database Update
print("\n5️⃣  Testing database update...")
try:
    update_query = text("""
        UPDATE "company-metadata"
        SET 
            tags = :tags,
            enhanced_summary = :enhanced_summary,
            enrichment_status = 'completed',
            enrichment_date = :enrichment_date
        WHERE stock_code = :stock_code
    """)
    
    with engine.connect() as conn:
        conn.execute(update_query, {
            'tags': enriched_data.get('tags', []),
            'enhanced_summary': enriched_data.get('enhanced_summary', ''),
            'enrichment_date': datetime.now().isoformat(),
            'stock_code': test_company['stock_code']
        })
        conn.commit()
    
    print(f"   ✅ Database update successful for {test_company['stock_code']}")
    
except Exception as e:
    print(f"   ❌ Database Update Error: {e}")
    exit(1)

# Test 6: Verify Update
print("\n6️⃣  Verifying database update...")
try:
    verify_query = text("""
        SELECT stock_code, tags, enrichment_status, enrichment_date
        FROM "company-metadata"
        WHERE stock_code = :stock_code
    """)
    
    with engine.connect() as conn:
        result = pd.read_sql(verify_query, conn, params={'stock_code': test_company['stock_code']})
    
    if len(result) > 0 and result.iloc[0]['enrichment_status'] == 'completed':
        print(f"   ✅ Verification successful!")
        print(f"      Status: {result.iloc[0]['enrichment_status']}")
        print(f"      Tags: {result.iloc[0]['tags']}")
    else:
        print(f"   ❌ Verification failed")
        
except Exception as e:
    print(f"   ❌ Verification Error: {e}")

print("\n" + "=" * 60)
print("✅ ALL TESTS PASSED!")
print("\n📝 Next steps:")
print("   1. Review the test results above")
print("   2. Run the full notebook: jupyter notebook enrich-company-metadata.ipynb")
print("   3. Start with Cell → Run All to process 3 companies")
print("   4. Review results, then increase SUBSET_SIZE if satisfied")
print("=" * 60)

