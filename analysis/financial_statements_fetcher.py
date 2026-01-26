#!/usr/bin/env python3
"""
Financial Statements Fetcher using yfinance

Pulls detailed financial statements from Yahoo Finance:
- Income Statement (annual & quarterly)
- Balance Sheet (annual & quarterly) 
- Cash Flow Statement (annual & quarterly)

This provides the exact data shown on Yahoo Finance financials page.
"""

import json
from typing import Dict, Any, Optional
from datetime import datetime

import yfinance as yf
import pandas as pd


def fetch_financial_statements(stock_code: str, include_quarterly: bool = True) -> Dict[str, Any]:
    """
    Fetch complete financial statements for a company.
    
    Args:
        stock_code: ASX stock code (e.g., 'CBA', 'BHP')
        include_quarterly: Whether to include quarterly data
    
    Returns:
        Dictionary with income statement, balance sheet, and cash flow data
    """
    
    yahoo_symbol = f"{stock_code}.AX"
    
    result = {
        'stock_code': stock_code,
        'yahoo_symbol': yahoo_symbol,
        'annual': {},
        'quarterly': {},
        'last_updated': datetime.now().isoformat(),
        'success': False,
        'error': None
    }
    
    try:
        print(f"  📊 Fetching financial statements for {stock_code}...")
        
        ticker = yf.Ticker(yahoo_symbol)
        
        # ====================================================================
        # ANNUAL DATA
        # ====================================================================
        
        # Income Statement (Annual)
        try:
            income_stmt = ticker.financials
            if income_stmt is not None and not income_stmt.empty:
                # Convert to dict with dates as strings
                income_dict = {}
                for col in income_stmt.columns:
                    date_str = col.strftime('%Y-%m-%d')
                    income_dict[date_str] = income_stmt[col].to_dict()
                
                result['annual']['income_statement'] = income_dict
                print(f"    ✅ Income Statement: {len(income_dict)} years")
        except Exception as e:
            print(f"    ⚠️  Income Statement error: {e}")
        
        # Balance Sheet (Annual)
        try:
            balance_sheet = ticker.balance_sheet
            if balance_sheet is not None and not balance_sheet.empty:
                balance_dict = {}
                for col in balance_sheet.columns:
                    date_str = col.strftime('%Y-%m-%d')
                    balance_dict[date_str] = balance_sheet[col].to_dict()
                
                result['annual']['balance_sheet'] = balance_dict
                print(f"    ✅ Balance Sheet: {len(balance_dict)} years")
        except Exception as e:
            print(f"    ⚠️  Balance Sheet error: {e}")
        
        # Cash Flow (Annual)
        try:
            cashflow = ticker.cashflow
            if cashflow is not None and not cashflow.empty:
                cashflow_dict = {}
                for col in cashflow.columns:
                    date_str = col.strftime('%Y-%m-%d')
                    cashflow_dict[date_str] = cashflow[col].to_dict()
                
                result['annual']['cash_flow'] = cashflow_dict
                print(f"    ✅ Cash Flow: {len(cashflow_dict)} years")
        except Exception as e:
            print(f"    ⚠️  Cash Flow error: {e}")
        
        # ====================================================================
        # QUARTERLY DATA (optional)
        # ====================================================================
        
        if include_quarterly:
            # Income Statement (Quarterly)
            try:
                quarterly_income = ticker.quarterly_financials
                if quarterly_income is not None and not quarterly_income.empty:
                    quarterly_income_dict = {}
                    for col in quarterly_income.columns:
                        date_str = col.strftime('%Y-%m-%d')
                        quarterly_income_dict[date_str] = quarterly_income[col].to_dict()
                    
                    result['quarterly']['income_statement'] = quarterly_income_dict
                    print(f"    ✅ Quarterly Income: {len(quarterly_income_dict)} quarters")
            except Exception as e:
                print(f"    ⚠️  Quarterly Income error: {e}")
            
            # Balance Sheet (Quarterly)
            try:
                quarterly_balance = ticker.quarterly_balance_sheet
                if quarterly_balance is not None and not quarterly_balance.empty:
                    quarterly_balance_dict = {}
                    for col in quarterly_balance.columns:
                        date_str = col.strftime('%Y-%m-%d')
                        quarterly_balance_dict[date_str] = quarterly_balance[col].to_dict()
                    
                    result['quarterly']['balance_sheet'] = quarterly_balance_dict
                    print(f"    ✅ Quarterly Balance: {len(quarterly_balance_dict)} quarters")
            except Exception as e:
                print(f"    ⚠️  Quarterly Balance error: {e}")
            
            # Cash Flow (Quarterly)
            try:
                quarterly_cashflow = ticker.quarterly_cashflow
                if quarterly_cashflow is not None and not quarterly_cashflow.empty:
                    quarterly_cashflow_dict = {}
                    for col in quarterly_cashflow.columns:
                        date_str = col.strftime('%Y-%m-%d')
                        quarterly_cashflow_dict[date_str] = quarterly_cashflow[col].to_dict()
                    
                    result['quarterly']['cash_flow'] = quarterly_cashflow_dict
                    print(f"    ✅ Quarterly Cash Flow: {len(quarterly_cashflow_dict)} quarters")
            except Exception as e:
                print(f"    ⚠️  Quarterly Cash Flow error: {e}")
        
        # Mark as successful if we got at least one statement
        if (result['annual'].get('income_statement') or 
            result['annual'].get('balance_sheet') or 
            result['annual'].get('cash_flow')):
            result['success'] = True
            print(f"  ✅ Successfully fetched financial statements for {stock_code}")
        else:
            result['error'] = 'No financial statements available'
            print(f"  ⚠️  No financial statements found for {stock_code}")
    
    except Exception as e:
        result['error'] = str(e)
        print(f"  ❌ Error fetching {stock_code}: {e}")
    
    return result


def extract_key_metrics(financial_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extract key metrics from financial statements.
    
    Args:
        financial_data: Output from fetch_financial_statements()
    
    Returns:
        Dictionary with key metrics (revenue, net income, etc.)
    """
    
    metrics = {
        'stock_code': financial_data['stock_code'],
        'latest_annual': {},
        'latest_quarterly': {}
    }
    
    try:
        # Get latest annual data
        if financial_data['annual'].get('income_statement'):
            income_stmt = financial_data['annual']['income_statement']
            # Get most recent year (first key in the sorted dict)
            latest_year = sorted(income_stmt.keys(), reverse=True)[0]
            latest_data = income_stmt[latest_year]
            
            metrics['latest_annual'] = {
                'date': latest_year,
                'total_revenue': latest_data.get('Total Revenue'),
                'operating_revenue': latest_data.get('Operating Revenue'),
                'net_income': latest_data.get('Net Income'),
                'operating_expense': latest_data.get('Operating Expense'),
                'pretax_income': latest_data.get('Pretax Income'),
                'tax_provision': latest_data.get('Tax Provision'),
                'basic_eps': latest_data.get('Basic EPS'),
                'diluted_eps': latest_data.get('Diluted EPS'),
            }
        
        # Get latest quarterly data
        if financial_data['quarterly'].get('income_statement'):
            quarterly_income = financial_data['quarterly']['income_statement']
            latest_quarter = sorted(quarterly_income.keys(), reverse=True)[0]
            latest_q_data = quarterly_income[latest_quarter]
            
            metrics['latest_quarterly'] = {
                'date': latest_quarter,
                'total_revenue': latest_q_data.get('Total Revenue'),
                'net_income': latest_q_data.get('Net Income'),
                'basic_eps': latest_q_data.get('Basic EPS'),
            }
    
    except Exception as e:
        print(f"  ⚠️  Error extracting metrics: {e}")
    
    return metrics


def format_for_database(financial_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Format financial statements for database storage.
    
    Converts NaN to None, handles large numbers, etc.
    """
    import numpy as np
    
    def clean_value(val):
        """Clean a single value for JSON serialization"""
        if pd.isna(val):
            return None
        if isinstance(val, (np.integer, np.floating)):
            if np.isnan(val) or np.isinf(val):
                return None
            return float(val)
        return val
    
    def clean_dict(d):
        """Recursively clean dictionary"""
        if isinstance(d, dict):
            return {k: clean_dict(v) for k, v in d.items()}
        elif isinstance(d, (list, tuple)):
            return [clean_dict(item) for item in d]
        else:
            return clean_value(d)
    
    return clean_dict(financial_data)


# ============================================================================
# TEST/DEMO
# ============================================================================

if __name__ == "__main__":
    # Test on a few companies
    test_stocks = ["CBA", "BHP", "WBC"]
    
    all_results = []
    
    for stock_code in test_stocks:
        print(f"\n{'=' * 80}")
        print(f"Fetching: {stock_code}")
        print(f"{'=' * 80}")
        
        # Fetch financial statements
        financial_data = fetch_financial_statements(stock_code, include_quarterly=True)
        
        # Extract key metrics
        if financial_data['success']:
            metrics = extract_key_metrics(financial_data)
            
            print(f"\n📈 KEY METRICS - {stock_code}:")
            print(f"\n  Latest Annual ({metrics['latest_annual'].get('date', 'N/A')}):")
            for key, value in metrics['latest_annual'].items():
                if key != 'date' and value is not None:
                    if isinstance(value, (int, float)) and value > 1000000:
                        print(f"    {key:25s}: ${value:,.0f} ({value/1e9:.2f}B)")
                    else:
                        print(f"    {key:25s}: {value}")
            
            if metrics['latest_quarterly'].get('date'):
                print(f"\n  Latest Quarterly ({metrics['latest_quarterly'].get('date', 'N/A')}):")
                for key, value in metrics['latest_quarterly'].items():
                    if key != 'date' and value is not None:
                        if isinstance(value, (int, float)) and value > 1000000:
                            print(f"    {key:25s}: ${value:,.0f} ({value/1e9:.2f}B)")
                        else:
                            print(f"    {key:25s}: {value}")
        
        # Clean for database storage
        clean_data = format_for_database(financial_data)
        all_results.append(clean_data)
    
    # Save to file
    output_file = "financial_statements_data.json"
    with open(output_file, 'w') as f:
        json.dump(all_results, f, indent=2)
    
    print(f"\n\n✅ Saved {len(all_results)} company financial statements to {output_file}")
    print(f"\n💡 To integrate into enrichment pipeline:")
    print(f"   1. Add to Cell 6.5 in notebook")
    print(f"   2. Store in JSONB column: financial_statements")
    print(f"   3. ~2-3 seconds per company (free!)")

