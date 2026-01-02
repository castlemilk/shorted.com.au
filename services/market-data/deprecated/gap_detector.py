import pandas as pd
from datetime import date, timedelta
from typing import List, Tuple, Optional
import logging

logger = logging.getLogger(__name__)

# Minimum gap size to consider (number of consecutive missing business days)
# This accounts for public holidays that aren't in our list
# A single missing day is usually a holiday, 3+ consecutive days indicates a real gap
MIN_GAP_DAYS = 3

def get_expected_trading_days(start_date: date, end_date: date) -> pd.DatetimeIndex:
    """Get expected trading days for ASX (weekdays only, holidays not filtered)."""
    # Generate all business days (weekdays)
    all_b_days = pd.bdate_range(start=start_date, end=end_date)
    return all_b_days

def find_gaps(actual_dates: List[date], start_date: Optional[date] = None, end_date: Optional[date] = None) -> List[Tuple[date, date]]:
    """
    Find significant gaps in a list of trading dates.
    Returns a list of (gap_start, gap_end) tuples.
    
    Small gaps (< MIN_GAP_DAYS consecutive business days) are ignored as they're
    likely public holidays rather than missing data.
    """
    if not actual_dates:
        if start_date and end_date:
            return [(start_date, end_date)]
        return []
    
    # Ensure dates are sorted
    sorted_dates = sorted(pd.to_datetime(actual_dates))
    
    # Use provided range or determine from data
    if not start_date:
        start_date = sorted_dates[0].date()
    if not end_date:
        end_date = sorted_dates[-1].date()
        
    expected_days = get_expected_trading_days(start_date, end_date)
    actual_set = set(pd.to_datetime(actual_dates))
    
    missing_days = expected_days[~expected_days.isin(actual_set)]
    
    if missing_days.empty:
        return []
    
    # Group missing days into continuous ranges (gaps)
    raw_gaps = []
    if not missing_days.empty:
        gap_start = missing_days[0]
        prev_day = missing_days[0]
        
        for current_day in missing_days[1:]:
            # Check if this day is the next expected trading day
            idx_prev = expected_days.get_loc(prev_day)
            idx_curr = expected_days.get_loc(current_day)
            
            if idx_curr == idx_prev + 1:
                # Contiguous gap
                prev_day = current_day
            else:
                # End of one gap, start of another
                raw_gaps.append((gap_start.date(), prev_day.date()))
                gap_start = current_day
                prev_day = current_day
        
        # Add the last gap
        raw_gaps.append((gap_start.date(), prev_day.date()))
    
    # Filter out small gaps (likely just public holidays)
    significant_gaps = []
    for gap_start, gap_end in raw_gaps:
        # Count the number of business days in this gap
        gap_b_days = len(pd.bdate_range(start=gap_start, end=gap_end))
        if gap_b_days >= MIN_GAP_DAYS:
            significant_gaps.append((gap_start, gap_end))
            logger.debug(f"Significant gap found: {gap_start} to {gap_end} ({gap_b_days} business days)")
        else:
            logger.debug(f"Ignoring small gap (likely holiday): {gap_start} to {gap_end} ({gap_b_days} business days)")
    
    return significant_gaps

