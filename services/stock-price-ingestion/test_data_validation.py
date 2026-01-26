"""
Tests for data validation functions
"""
import pytest
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from data_validation import DataValidator


class TestDataValidator:
    
    @pytest.fixture
    def validator(self):
        return DataValidator()
    
    @pytest.fixture
    def valid_data(self):
        """Create valid stock price data"""
        dates = pd.date_range(start='2024-01-01', end='2024-01-10', freq='B')  # Business days
        data = {
            'date': dates,
            'open': [100.0, 101.0, 99.5, 102.0, 103.0, 101.5, 104.0, 105.0],
            'high': [101.0, 102.5, 101.0, 103.0, 104.0, 103.0, 105.0, 106.0],
            'low': [99.0, 100.0, 99.0, 101.0, 102.0, 101.0, 103.5, 104.0],
            'close': [100.5, 101.5, 100.0, 102.5, 103.5, 102.0, 104.5, 105.5],
            'volume': [1000000, 1200000, 900000, 1100000, 1300000, 950000, 1150000, 1050000],
        }
        return pd.DataFrame(data)
    
    def test_valid_data_passes(self, validator, valid_data):
        """Test that valid data passes validation"""
        is_valid, issues = validator.validate_price_data(valid_data, 'TEST')
        assert is_valid
        assert len(issues) == 0
    
    def test_empty_dataframe_is_valid(self, validator):
        """Test that empty DataFrame is considered valid"""
        df = pd.DataFrame()
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert is_valid
        assert len(issues) == 0
    
    def test_missing_required_columns(self, validator):
        """Test detection of missing required columns"""
        df = pd.DataFrame({
            'open': [100.0],
            'high': [101.0],
            # Missing 'date' and 'close'
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert not is_valid
        assert any(issue['type'] == 'missing_columns' for issue in issues)
    
    def test_duplicate_dates(self, validator):
        """Test detection of duplicate dates"""
        df = pd.DataFrame({
            'date': pd.to_datetime(['2024-01-01', '2024-01-01', '2024-01-02']),
            'close': [100.0, 101.0, 102.0]
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert not is_valid
        assert any(issue['type'] == 'duplicate_dates' for issue in issues)
    
    def test_future_dates(self, validator):
        """Test detection of future dates"""
        future_date = datetime.now() + timedelta(days=30)
        df = pd.DataFrame({
            'date': pd.to_datetime([datetime.now() - timedelta(days=1), future_date]),
            'close': [100.0, 101.0]
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert not is_valid
        assert any(issue['type'] == 'future_dates' for issue in issues)
    
    def test_negative_prices(self, validator):
        """Test detection of negative prices"""
        df = pd.DataFrame({
            'date': pd.date_range(start='2024-01-01', periods=3),
            'close': [100.0, -50.0, 102.0],
            'open': [99.0, -45.0, 101.0]
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert not is_valid
        assert any(issue['type'] == 'negative_prices' for issue in issues)
    
    def test_zero_close_price(self, validator):
        """Test detection of zero close prices"""
        df = pd.DataFrame({
            'date': pd.date_range(start='2024-01-01', periods=3),
            'close': [100.0, 0.0, 102.0]
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert is_valid  # Zero prices are warnings, not critical
        assert any(issue['type'] == 'zero_prices' for issue in issues)
    
    def test_excessive_prices(self, validator):
        """Test detection of excessively high prices"""
        df = pd.DataFrame({
            'date': pd.date_range(start='2024-01-01', periods=3),
            'close': [100.0, 150000.0, 102.0]  # Exceeds MAX_PRICE
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert is_valid  # Excessive prices are warnings
        assert any(issue['type'] == 'excessive_prices' for issue in issues)
    
    def test_negative_volume(self, validator):
        """Test detection of negative volume"""
        df = pd.DataFrame({
            'date': pd.date_range(start='2024-01-01', periods=3),
            'close': [100.0, 101.0, 102.0],
            'volume': [1000000, -500000, 1100000]
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert not is_valid
        assert any(issue['type'] == 'negative_volume' for issue in issues)
    
    def test_invalid_ohlc_relationships(self, validator):
        """Test detection of invalid OHLC relationships"""
        df = pd.DataFrame({
            'date': pd.date_range(start='2024-01-01', periods=3),
            'open': [100.0, 101.0, 102.0],
            'high': [99.0, 102.0, 105.0],  # First high < open
            'low': [98.0, 100.0, 101.0],
            'close': [99.5, 101.5, 104.0]
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert not is_valid
        assert any(issue['type'] == 'invalid_high_price' for issue in issues)
    
    def test_extreme_price_movements(self, validator):
        """Test detection of extreme price movements"""
        df = pd.DataFrame({
            'date': pd.date_range(start='2024-01-01', periods=3),
            'close': [100.0, 200.0, 150.0]  # 100% increase
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert is_valid  # Extreme movements are warnings
        assert any(issue['type'] == 'extreme_price_movement' for issue in issues)
    
    def test_weekend_dates(self, validator):
        """Test detection of weekend dates"""
        # Create dates including a weekend
        dates = pd.to_datetime(['2024-01-05', '2024-01-06', '2024-01-07'])  # Fri, Sat, Sun
        df = pd.DataFrame({
            'date': dates,
            'close': [100.0, 101.0, 102.0]
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert is_valid  # Weekend dates are info level
        assert any(issue['type'] == 'weekend_dates' for issue in issues)
    
    def test_missing_data_detection(self, validator):
        """Test detection of missing trading days"""
        # Create data with gaps
        dates = pd.to_datetime(['2024-01-01', '2024-01-02', '2024-01-10'])  # Gap in middle
        df = pd.DataFrame({
            'date': dates,
            'close': [100.0, 101.0, 105.0]
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert is_valid  # Missing data is a warning
        assert any(issue['type'] == 'missing_data' for issue in issues)
    
    def test_batch_validation(self, validator, valid_data):
        """Test batch validation of multiple stocks"""
        invalid_data = pd.DataFrame({
            'date': pd.date_range(start='2024-01-01', periods=3),
            'close': [100.0, -50.0, 102.0]  # Negative price
        })
        
        batch_data = {
            'VALID': valid_data,
            'INVALID': invalid_data
        }
        
        results = validator.validate_batch(batch_data)
        
        assert 'VALID' in results
        assert 'INVALID' in results
        assert results['VALID'][0] == True  # Valid data
        assert results['INVALID'][0] == False  # Invalid data
    
    def test_validation_report_generation(self, validator):
        """Test validation report generation"""
        results = {
            'STOCK1': (True, []),
            'STOCK2': (False, [
                {'type': 'negative_prices', 'severity': 'critical'},
                {'type': 'missing_data', 'severity': 'warning'}
            ]),
            'STOCK3': (True, [
                {'type': 'weekend_dates', 'severity': 'info'}
            ])
        }
        
        report = validator.generate_validation_report(results)
        
        assert 'Stock Price Data Validation Report' in report
        assert 'Total stocks validated: 3' in report
        assert 'Valid stocks: 2' in report
        assert 'Invalid stocks: 1' in report
        assert 'CRITICAL ISSUES' in report
        assert 'WARNINGS' in report
    
    def test_dates_not_ordered(self, validator):
        """Test detection of unordered dates"""
        df = pd.DataFrame({
            'date': pd.to_datetime(['2024-01-03', '2024-01-01', '2024-01-02']),
            'close': [100.0, 101.0, 102.0]
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert is_valid  # Unordered dates are warnings
        assert any(issue['type'] == 'dates_not_ordered' for issue in issues)
    
    def test_zero_volume_with_price_change(self, validator):
        """Test detection of zero volume with price changes"""
        df = pd.DataFrame({
            'date': pd.date_range(start='2024-01-01', periods=3),
            'close': [100.0, 105.0, 102.0],
            'volume': [1000000, 0, 1100000]  # Zero volume on day 2
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert is_valid  # This is info level
        assert any(issue['type'] == 'zero_volume_price_change' for issue in issues)
    
    def test_missing_close_price_is_critical(self, validator):
        """Test that missing close prices are critical errors"""
        df = pd.DataFrame({
            'date': pd.date_range(start='2024-01-01', periods=3),
            'open': [100.0, 101.0, 102.0],
            'close': [100.0, np.nan, 102.0]  # Missing close price
        })
        is_valid, issues = validator.validate_price_data(df, 'TEST')
        assert not is_valid
        critical_issues = [i for i in issues if i['severity'] == 'critical']
        assert any(issue['type'] == 'missing_close_prices' for issue in critical_issues)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])