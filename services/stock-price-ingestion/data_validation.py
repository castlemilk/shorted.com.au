"""
Data validation functions for stock price ingestion
"""
from typing import Dict, List, Optional, Tuple
import pandas as pd
import numpy as np
from datetime import date, datetime, timedelta
import logging

logger = logging.getLogger(__name__)

class DataValidator:
    """Validates stock price data for quality and consistency"""
    
    def __init__(self):
        # Define reasonable bounds for stock prices
        self.MIN_PRICE = 0.01
        self.MAX_PRICE = 100000.0
        self.MAX_DAILY_CHANGE_PCT = 0.5  # 50% max daily change
        self.MIN_VOLUME = 0
        self.MAX_VOLUME = 1e12  # 1 trillion shares
        
    def validate_price_data(self, df: pd.DataFrame, stock_code: str) -> Tuple[bool, List[Dict]]:
        """
        Validate a DataFrame of stock price data
        
        Returns:
            (is_valid, issues): Tuple of validation result and list of issues found
        """
        issues = []
        
        if df.empty:
            return True, []
        
        # Check required columns
        required_columns = ['date', 'close']
        missing_columns = [col for col in required_columns if col not in df.columns]
        if missing_columns:
            issues.append({
                'type': 'missing_columns',
                'columns': missing_columns,
                'severity': 'critical'
            })
            return False, issues
        
        # Validate date column
        date_issues = self._validate_dates(df, stock_code)
        issues.extend(date_issues)
        
        # Validate price columns
        price_columns = ['open', 'high', 'low', 'close', 'adjusted_close']
        for col in price_columns:
            if col in df.columns:
                price_issues = self._validate_prices(df, col, stock_code)
                issues.extend(price_issues)
        
        # Validate volume
        if 'volume' in df.columns:
            volume_issues = self._validate_volume(df, stock_code)
            issues.extend(volume_issues)
        
        # Validate OHLC relationships
        ohlc_issues = self._validate_ohlc_relationships(df, stock_code)
        issues.extend(ohlc_issues)
        
        # Validate price movements
        movement_issues = self._validate_price_movements(df, stock_code)
        issues.extend(movement_issues)
        
        # Check for data completeness
        completeness_issues = self._validate_completeness(df, stock_code)
        issues.extend(completeness_issues)
        
        # Determine if data is valid based on critical issues
        critical_issues = [i for i in issues if i.get('severity') == 'critical']
        is_valid = len(critical_issues) == 0
        
        return is_valid, issues
    
    def _validate_dates(self, df: pd.DataFrame, stock_code: str) -> List[Dict]:
        """Validate date column"""
        issues = []
        
        # Check for duplicate dates
        duplicates = df[df.duplicated(subset=['date'], keep=False)]
        if not duplicates.empty:
            issues.append({
                'type': 'duplicate_dates',
                'stock_code': stock_code,
                'dates': duplicates['date'].tolist(),
                'severity': 'critical'
            })
        
        # Check date ordering
        if not df['date'].is_monotonic_increasing:
            issues.append({
                'type': 'dates_not_ordered',
                'stock_code': stock_code,
                'severity': 'warning'
            })
        
        # Check for weekend dates (ASX is closed on weekends)
        weekend_dates = df[df['date'].dt.dayofweek.isin([5, 6])]['date'].tolist()
        if weekend_dates:
            issues.append({
                'type': 'weekend_dates',
                'stock_code': stock_code,
                'dates': weekend_dates,
                'severity': 'info'
            })
        
        # Check for future dates
        future_dates = df[df['date'] > pd.Timestamp.now()]['date'].tolist()
        if future_dates:
            issues.append({
                'type': 'future_dates',
                'stock_code': stock_code,
                'dates': future_dates,
                'severity': 'critical'
            })
        
        return issues
    
    def _validate_prices(self, df: pd.DataFrame, column: str, stock_code: str) -> List[Dict]:
        """Validate price column values"""
        issues = []
        
        # Check for negative prices
        negative_prices = df[df[column] < 0]
        if not negative_prices.empty:
            issues.append({
                'type': 'negative_prices',
                'stock_code': stock_code,
                'column': column,
                'dates': negative_prices['date'].tolist(),
                'severity': 'critical'
            })
        
        # Check for zero prices (except for volume)
        zero_prices = df[df[column] == 0]
        if not zero_prices.empty:
            issues.append({
                'type': 'zero_prices',
                'stock_code': stock_code,
                'column': column,
                'dates': zero_prices['date'].tolist(),
                'severity': 'warning'
            })
        
        # Check for unreasonably high prices
        high_prices = df[df[column] > self.MAX_PRICE]
        if not high_prices.empty:
            issues.append({
                'type': 'excessive_prices',
                'stock_code': stock_code,
                'column': column,
                'dates': high_prices['date'].tolist(),
                'max_price': high_prices[column].max(),
                'severity': 'warning'
            })
        
        # Check for missing values
        missing_values = df[df[column].isna()]
        if not missing_values.empty and column == 'close':
            issues.append({
                'type': 'missing_close_prices',
                'stock_code': stock_code,
                'dates': missing_values['date'].tolist(),
                'severity': 'critical'
            })
        
        return issues
    
    def _validate_volume(self, df: pd.DataFrame, stock_code: str) -> List[Dict]:
        """Validate volume data"""
        issues = []
        
        # Check for negative volume
        negative_volume = df[df['volume'] < 0]
        if not negative_volume.empty:
            issues.append({
                'type': 'negative_volume',
                'stock_code': stock_code,
                'dates': negative_volume['date'].tolist(),
                'severity': 'critical'
            })
        
        # Check for excessive volume
        excessive_volume = df[df['volume'] > self.MAX_VOLUME]
        if not excessive_volume.empty:
            issues.append({
                'type': 'excessive_volume',
                'stock_code': stock_code,
                'dates': excessive_volume['date'].tolist(),
                'max_volume': excessive_volume['volume'].max(),
                'severity': 'warning'
            })
        
        # Check for zero volume on price changes
        if 'close' in df.columns and len(df) > 1:
            df_sorted = df.sort_values('date')
            df_sorted['price_change'] = df_sorted['close'].diff()
            zero_vol_changes = df_sorted[
                (df_sorted['volume'] == 0) & 
                (df_sorted['price_change'].abs() > 0.01)
            ]
            if not zero_vol_changes.empty:
                issues.append({
                    'type': 'zero_volume_price_change',
                    'stock_code': stock_code,
                    'dates': zero_vol_changes['date'].tolist(),
                    'severity': 'info'
                })
        
        return issues
    
    def _validate_ohlc_relationships(self, df: pd.DataFrame, stock_code: str) -> List[Dict]:
        """Validate OHLC price relationships"""
        issues = []
        
        # Check if all OHLC columns exist
        ohlc_cols = ['open', 'high', 'low', 'close']
        if not all(col in df.columns for col in ohlc_cols):
            return issues
        
        # High should be >= all other prices
        invalid_high = df[
            (df['high'] < df['open']) | 
            (df['high'] < df['close']) | 
            (df['high'] < df['low'])
        ]
        if not invalid_high.empty:
            issues.append({
                'type': 'invalid_high_price',
                'stock_code': stock_code,
                'dates': invalid_high['date'].tolist(),
                'severity': 'critical'
            })
        
        # Low should be <= all other prices
        invalid_low = df[
            (df['low'] > df['open']) | 
            (df['low'] > df['close']) | 
            (df['low'] > df['high'])
        ]
        if not invalid_low.empty:
            issues.append({
                'type': 'invalid_low_price',
                'stock_code': stock_code,
                'dates': invalid_low['date'].tolist(),
                'severity': 'critical'
            })
        
        # Open and close should be between high and low
        invalid_oc = df[
            (df['open'] > df['high']) | 
            (df['open'] < df['low']) |
            (df['close'] > df['high']) | 
            (df['close'] < df['low'])
        ]
        if not invalid_oc.empty:
            issues.append({
                'type': 'invalid_open_close_range',
                'stock_code': stock_code,
                'dates': invalid_oc['date'].tolist(),
                'severity': 'critical'
            })
        
        return issues
    
    def _validate_price_movements(self, df: pd.DataFrame, stock_code: str) -> List[Dict]:
        """Validate price movements for anomalies"""
        issues = []
        
        if 'close' not in df.columns or len(df) < 2:
            return issues
        
        # Sort by date and calculate returns
        df_sorted = df.sort_values('date').copy()
        df_sorted['returns'] = df_sorted['close'].pct_change()
        
        # Check for extreme daily movements
        extreme_moves = df_sorted[df_sorted['returns'].abs() > self.MAX_DAILY_CHANGE_PCT]
        if not extreme_moves.empty:
            for _, row in extreme_moves.iterrows():
                issues.append({
                    'type': 'extreme_price_movement',
                    'stock_code': stock_code,
                    'date': row['date'],
                    'change_pct': row['returns'] * 100,
                    'severity': 'warning'
                })
        
        # Check for price gaps (more than 20% change)
        gaps = df_sorted[df_sorted['returns'].abs() > 0.2]
        if not gaps.empty:
            issues.append({
                'type': 'price_gaps',
                'stock_code': stock_code,
                'dates': gaps['date'].tolist(),
                'severity': 'info'
            })
        
        return issues
    
    def _validate_completeness(self, df: pd.DataFrame, stock_code: str) -> List[Dict]:
        """Check for missing trading days"""
        issues = []
        
        if df.empty or 'date' not in df.columns:
            return issues
        
        # Get date range
        min_date = df['date'].min()
        max_date = df['date'].max()
        
        # Generate expected trading days (weekdays only)
        expected_dates = pd.bdate_range(start=min_date, end=max_date)
        actual_dates = pd.to_datetime(df['date'])
        
        # Find missing dates
        missing_dates = expected_dates.difference(actual_dates)
        
        # Filter out known Australian public holidays (simplified)
        # In production, use a proper holiday calendar
        if len(missing_dates) > 0:
            missing_pct = len(missing_dates) / len(expected_dates) * 100
            if missing_pct > 10:  # More than 10% missing
                issues.append({
                    'type': 'missing_data',
                    'stock_code': stock_code,
                    'missing_dates_count': len(missing_dates),
                    'missing_pct': missing_pct,
                    'date_range': (min_date, max_date),
                    'severity': 'warning'
                })
        
        return issues
    
    def validate_batch(self, data: Dict[str, pd.DataFrame]) -> Dict[str, Tuple[bool, List[Dict]]]:
        """Validate multiple stocks at once"""
        results = {}
        for stock_code, df in data.items():
            results[stock_code] = self.validate_price_data(df, stock_code)
        return results
    
    def generate_validation_report(self, validation_results: Dict[str, Tuple[bool, List[Dict]]]) -> str:
        """Generate a human-readable validation report"""
        report = []
        report.append("Stock Price Data Validation Report")
        report.append("=" * 50)
        report.append(f"Generated at: {datetime.now()}")
        report.append("")
        
        total_stocks = len(validation_results)
        valid_stocks = sum(1 for _, (valid, _) in validation_results.items() if valid)
        
        report.append(f"Total stocks validated: {total_stocks}")
        report.append(f"Valid stocks: {valid_stocks}")
        report.append(f"Invalid stocks: {total_stocks - valid_stocks}")
        report.append("")
        
        # Group issues by severity
        all_issues = []
        for stock_code, (is_valid, issues) in validation_results.items():
            for issue in issues:
                issue['stock_code'] = stock_code
                all_issues.append(issue)
        
        critical_issues = [i for i in all_issues if i.get('severity') == 'critical']
        warning_issues = [i for i in all_issues if i.get('severity') == 'warning']
        info_issues = [i for i in all_issues if i.get('severity') == 'info']
        
        if critical_issues:
            report.append(f"CRITICAL ISSUES ({len(critical_issues)}):")
            report.append("-" * 30)
            for issue in critical_issues[:10]:  # Show first 10
                report.append(f"  - {issue['type']} for {issue['stock_code']}")
            if len(critical_issues) > 10:
                report.append(f"  ... and {len(critical_issues) - 10} more")
            report.append("")
        
        if warning_issues:
            report.append(f"WARNINGS ({len(warning_issues)}):")
            report.append("-" * 30)
            for issue in warning_issues[:10]:
                report.append(f"  - {issue['type']} for {issue['stock_code']}")
            if len(warning_issues) > 10:
                report.append(f"  ... and {len(warning_issues) - 10} more")
            report.append("")
        
        report.append(f"INFO ({len(info_issues)} issues)")
        
        return "\n".join(report)