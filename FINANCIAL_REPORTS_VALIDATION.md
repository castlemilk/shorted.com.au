# Financial Reports Validation Cells

## Overview
Added 6 validation cells to verify the quality and accuracy of financial reports fetching.

## Validation Cells Added

### Cell 14: Coverage Statistics
**Purpose**: Overall coverage analysis
- Total companies with/without reports
- Report count distribution
- Average, min, max reports per company
- Visual distribution chart

**Key Metrics**:
- Coverage percentage
- Report count histogram

### Cell 15: Sample Reports Inspection
**Purpose**: Manual quality inspection
- Shows first 5 companies with reports
- Full details of each report (type, title, date, URL)
- Allows manual verification of data quality

**What to Look For**:
- Are titles descriptive?
- Are dates recent?
- Are URLs valid?

### Cell 16: Report Type Breakdown
**Purpose**: Analyze types of reports found
- Annual reports vs quarterly vs half-year
- Distribution of report types
- Visual breakdown chart

**Expected Types**:
- `annual_report`
- `quarterly_report`
- `half_year_report`

### Cell 17: Missing Reports Analysis
**Purpose**: Identify companies without reports
- Lists companies with no financial reports
- Shows stock code, name, and website
- Helps identify potential issues

**Action Items**:
- Check if these companies are small/new
- Verify if GPT-5 mentions reports in other fields
- Consider manual website scraping

### Cell 18: Date Range Analysis
**Purpose**: Validate report recency
- Oldest and newest report dates
- Year-by-year distribution
- Invalid date detection

**Quality Checks**:
- Are reports recent (2023-2024)?
- Are dates in valid format?
- Any suspicious old dates?

### Cell 19: URL Validation
**Purpose**: Validate report URLs
- Source breakdown (ASX API vs company websites)
- Missing URL detection
- Duplicate URL detection

**Quality Checks**:
- ASX API URLs should contain 'asx.com.au'
- Company URLs should be valid domains
- No duplicate URLs across companies

## Usage

Run these cells after the main enrichment pipeline completes:

```python
# After Cell 12 (Execute Pipeline) completes, run:
# - Cell 14: Coverage Statistics
# - Cell 15: Sample Inspection
# - Cell 16: Type Breakdown
# - Cell 17: Missing Reports
# - Cell 18: Date Analysis
# - Cell 19: URL Validation
```

## Expected Outcomes

### Good Results 👍
- 60-80%+ coverage (some small companies may not have public reports)
- 1-3 reports per company average
- Mix of annual and quarterly reports
- Dates from 2023-2024
- Valid ASX and company URLs
- No duplicate URLs

### Warning Signs ⚠️
- <50% coverage
- Many invalid dates
- High number of missing URLs
- Many duplicates
- All reports from same source

## Limitations

### ASX API Limitation
The ASX announcements API only returns ~5 recent announcements per company. This is supplemented by:
1. **Website Scraping**: Checks company investor relations pages
2. **GPT-5 Deep Research**: Can find reports from various sources
3. **Enhanced Summary**: May reference reports even if direct links aren't found

### Why Some Companies May Have No Reports
- Small/new companies
- Private companies
- Companies in administration
- Technical issues (website down, blocked scraping)
- Not required to file publicly

## Next Steps

1. **Run validation cells on test data** (3-5 companies)
2. **Review output for quality**
3. **Adjust thresholds if needed**
4. **Run on larger batch** (50-100 companies)
5. **Final validation before full run** (~2000 companies)

## Quality Metrics to Track

| Metric | Target | Acceptable | Poor |
|--------|--------|------------|------|
| Coverage | >80% | 60-80% | <60% |
| Avg Reports | 2-3 | 1-2 | <1 |
| Recent Reports | >80% from 2023+ | 50-80% | <50% |
| Valid URLs | >95% | 85-95% | <85% |
| Duplicate URLs | 0 | <5 | >5 |

