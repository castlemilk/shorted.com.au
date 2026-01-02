#!/usr/bin/env python3
"""
Fetch key metrics from Yahoo Finance for a single stock.
Called by the Go shorts service for on-demand sync.
"""
import sys
import json
import yfinance as yf


def fetch_metrics(stock_code: str) -> dict:
    """Fetch key metrics from Yahoo Finance."""
    yahoo_symbol = f"{stock_code}.AX"
    
    try:
        ticker = yf.Ticker(yahoo_symbol)
        info = ticker.info
        
        if not info or info.get("regularMarketPrice") is None:
            return {"error": "No data available from Yahoo Finance"}
        
        # Helper to sanitize numeric values (handle infinity, None, etc.)
        def sanitize_number(value):
            if value is None:
                return None
            if isinstance(value, str):
                return None
            if value == float('inf') or value == float('-inf'):
                return None
            if isinstance(value, (int, float)) and (value != value):  # NaN check
                return None
            return value
        
        return {
            "stock_code": stock_code,
            "market_cap": sanitize_number(info.get("marketCap")),
            "pe_ratio": sanitize_number(info.get("trailingPE")),
            "forward_pe": sanitize_number(info.get("forwardPE")),
            "eps": sanitize_number(info.get("trailingEps")),
            "dividend_yield": sanitize_number(info.get("dividendYield")),
            "book_value": sanitize_number(info.get("bookValue")),
            "price_to_book": sanitize_number(info.get("priceToBook")),
            "revenue": sanitize_number(info.get("totalRevenue")),
            "profit_margin": sanitize_number(info.get("profitMargins")),
            "debt_to_equity": sanitize_number(info.get("debtToEquity")),
            "return_on_equity": sanitize_number(info.get("returnOnEquity")),
            "fifty_two_week_high": sanitize_number(info.get("fiftyTwoWeekHigh")),
            "fifty_two_week_low": sanitize_number(info.get("fiftyTwoWeekLow")),
            "avg_volume": sanitize_number(info.get("averageVolume")),
            "beta": sanitize_number(info.get("beta")),
        }
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Usage: fetch_key_metrics.py <STOCK_CODE>"}))
        sys.exit(1)
    
    stock_code = sys.argv[1].upper()
    result = fetch_metrics(stock_code)
    print(json.dumps(result))

