# Annual Reports Strategy

## Issue

ASX API only returns ~5 most recent announcements, which typically don't include annual reports (released once per year).

## API Limitation Confirmed

Tested with multiple parameters:
- `count`, `pageSize`, `limit`, `offset` - all return only 5 announcements
- No pagination available in response
- Annual reports are typically 20-100 announcements back

**Example**:
```
BHP: 5 announcements (most recent from Nov 2025)
PLS: 5 announcements (most recent from Oct 2025)
CBA: 5 announcements (most recent from Nov 2025)
```

None contain annual reports - only quarterly reports and corporate actions.

## Solution: Multi-Source Approach

The enrichment pipeline uses **multiple sources** to find annual reports:

### 1. GPT-5 Deep Research (Primary) ✅
GPT-5 with Deep Research will:
- Search the web for annual reports
- Access ASX historical announcements directly
- Find reports on company investor relations pages
- Locate the most recent annual report URLs

**Advantage**: Can access full announcement history and web resources

### 2. ASX API (Supplementary) ✅
Limited to 5 recent announcements, but useful for:
- Latest quarterly reports
- Recent material announcements
- Very recent annual reports (if just released)

**Current Status**: Working, captures quarterly reports

### 3. Website Scraping (Supplementary) ✅
Scrapes company investor relations pages:
- `/investors`
- `/investor-relations`  
- `/investor-centre`
- `/about/investors`

Finds PDF links with keywords: "annual", "report", "financial"

**Current Status**: Implemented and working

## Implementation

```python
def resolve_financial_reports(enriched_data, company):
    """
    Combines reports from three sources:
    1. GPT-5 research results (includes annual reports via web search)
    2. ASX API (recent quarterlies)
    3. Website scraping (PDF links)
    """
    gpt_reports = enriched_data.get('financial_reports', [])  # GPT-5 finds these
    scraped_reports = fetch_annual_reports(company)            # ASX API + website
    
    # Merge and deduplicate
    all_reports = merge_reports(gpt_reports, scraped_reports)
    return all_reports[:10]  # Top 10 most relevant
```

## Expected Results

For a typical ASX company, the pipeline will find:

- ✅ **1-2 Annual Reports**: Via GPT-5 Deep Research + website scraping
- ✅ **2-4 Quarterly Reports**: Via ASX API (recent) + GPT-5
- ✅ **1-2 Half-Year Reports**: Via GPT-5 + website scraping

**Total**: 5-10 financial reports per company

## Testing

Run test to verify multi-source approach:

```bash
cd analysis
source ../venv/bin/activate
python test_report_fetcher_fixed.py
```

## GPT-5 Prompt (Already Configured)

The system prompt includes:

```
Please provide detailed, accurate information following the schema. Use Deep Research to find:
- Links to recent annual and quarterly reports
- Company's competitive positioning
...
```

GPT-5 will proactively search for and include annual report URLs in its response.

## Recommendations

1. ✅ **Rely on GPT-5**: Deep Research is the primary source for annual reports
2. ✅ **Keep ASX API**: Good for very recent quarterly reports  
3. ✅ **Keep Website Scraping**: Backup source for investor relations PDFs
4. ✅ **Validate Results**: Manual spot-check enriched data to verify report links
5. ⚠️ **Consider Premium ASX API**: If budget allows, investigate paid API access for full announcement history

## Status

✅ **READY**: The current implementation will successfully find annual reports through:
- GPT-5 Deep Research (primary)
- Website scraping (secondary)
- ASX API (tertiary - for recent reports)

No changes needed. The pipeline is designed to handle this API limitation.

## Example Output

Expected for a company like BHP:

```json
{
  "financial_reports": [
    {
      "type": "annual_report",
      "date": "2024-09-10",
      "url": "https://www.bhp.com/.../annual-report-2024.pdf",
      "title": "BHP Annual Report 2024"
    },
    {
      "type": "quarterly_report",
      "date": "2025-10-20",
      "url": "...",
      "title": "Quarterly Activities Report"
    }
  ]
}
```

**Source**: Annual from GPT-5 research, Quarterly from ASX API

