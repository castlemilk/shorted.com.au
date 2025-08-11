import { NextRequest, NextResponse } from 'next/server';
import { getMarketDataApiUrl } from '~/app/actions/config';

const MARKET_DATA_API_URL = getMarketDataApiUrl();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Forward the request to the market data service
    const response = await fetch(`${MARKET_DATA_API_URL}/marketdata.v1.MarketDataService/GetStockCorrelations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Market data API responded with status: ${response.status}`);
    }

    const data = await response.json();
    
    // Handle empty response from market data service
    if (!data || Object.keys(data).length === 0) {
      return NextResponse.json({ correlations: {} });
    }
    
    return NextResponse.json(data);
  } catch (error) {
    console.error('Market data proxy error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch correlations' },
      { status: 500 }
    );
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}