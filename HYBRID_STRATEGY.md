# Hybrid Financial Report Discovery - Refined Strategy

## Problem with Current Approaches

### Traditional Crawler Issues:
- ❌ Too many false positives (353 reports for BAP)
- ❌ Missing obvious reports (0 for 5GN despite having 13)
- ❌ No validation of report quality
- ❌ Excessive duplicates

### Pure GPT Guidance Issues:
- ❌ GPT can't see actual PDF links in HTML structure
- ❌ Too slow (API call per page)
- ❌ Expensive at scale
- ❌ Timeout issues on complex pages

## Refined Hybrid Approach

### Phase 1: FIND (Traditional Crawler)
**Use fast, simple crawler to find ALL potential PDFs**
- Breadth-first search
- Extract ALL .pdf links
- NO filtering at this stage
- Fast and comprehensive

### Phase 2: FILTER (GPT-4 Validation)
**Use GPT to intelligently validate and categorize**
- Batch all PDFs found (up to 50 at once)
- GPT analyzes: URL patterns + link text + context
- Returns: actual reports vs noise
- Categorizes: annual/quarterly/half-year
- Extracts: years, titles

### Phase 3: ENRICH (Yahoo/Google Finance)
**Add company metadata (not reports)**
- Yahoo Finance: company description, financials, key stats
- Google Finance: backup description, market data
- ASX API: announcements metadata
- Combine into rich profile

## Example Workflow

```python
# Step 1: Fast crawl (no filtering)
pdf_candidates = traditional_crawl(investor_url)
# Result: 50 PDFs found (including some noise)

# Step 2: GPT batch validation
prompt = f"""
Analyze these 50 PDF links from {company_name} investor page:
{json.dumps(pdf_candidates)}

Which are REAL financial reports? Return JSON:
{{
  "valid_reports": [
    {{"url": "...", "type": "annual_report", "year": "2024", "confidence": 0.95}}
  ],
  "noise": ["url1", "url2"]  # Marketing PDFs, presentations, etc.
}}
"""

validated = gpt_filter(pdf_candidates)
# Result: 13 actual annual reports (removed 37 noise)

# Step 3: Enrich with Yahoo Finance
metadata = yahoo_finance.get_company_data(stock_code)
# Result: Description, financials, key stats

# Final output: 13 validated reports + rich metadata
```

## Benefits

✅ **Speed**: Fast crawling (no GPT per-page)
✅ **Quality**: GPT validates results
✅ **Coverage**: Finds everything first, filters later
✅ **Cost**: Single GPT call per company (not per page)
✅ **Accuracy**: GPT excels at classification
✅ **Metadata**: Rich company profiles from Yahoo/Google

## Implementation Priority

1. **Keep enhanced traditional crawler** (finds PDFs well)
2. **Add GPT batch filtering** (removes false positives)
3. **Add Yahoo Finance integration** (company metadata)
4. **Integrate into notebook** (replace current fetch_annual_reports)

## Expected Results

| Company | Current | With GPT Filtering |
|---------|---------|-------------------|
| 5GN | 11 (many bad titles) | 13 (clean, validated) |
| BHP | 82 (duplicates) | 15-20 (unique, validated) |
| BAP | 353 (!!!noise) | 10-15 (actual reports) |
| ANZ | 321 (excessive) | 20-30 (quarterly + annual) |

## Cost Analysis

- Traditional crawl: FREE
- GPT-4o-mini batch filtering: ~$0.001 per company
- Yahoo Finance: FREE
- Total per company: <$0.01

For 2,000 companies: **~$20 total**

## Next Steps

1. ✅ Implement GPT batch filtering function
2. ✅ Test on 5GN (should get clean 13 reports)
3. ✅ Integrate Yahoo Finance for metadata
4. ✅ Update notebook Cell 6 with hybrid approach
5. ✅ Run full validation on 10 companies
6. ✅ Scale to production

