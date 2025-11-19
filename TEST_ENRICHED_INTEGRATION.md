# Testing Guide: Enriched Data Integration

## Quick Start

### 1. Start the Application

```bash
# Start all services (database, backend, frontend)
make dev
```

This will start:
- **Database**: PostgreSQL on port 5438
- **Backend**: Go service on port 9091  
- **Frontend**: Next.js on port 3020

### 2. Find Enriched Companies

Open your terminal and check which companies have enriched data:

```bash
# Connect to database
docker exec -it shorted_db psql -U admin -d shorts

# Query enriched companies
SELECT 
  stock_code, 
  company_name, 
  enrichment_status,
  array_length(tags, 1) as tag_count,
  CASE 
    WHEN enhanced_summary IS NOT NULL THEN '✓' 
    ELSE '✗' 
  END as has_summary,
  CASE 
    WHEN social_media_links IS NOT NULL THEN '✓' 
    ELSE '✗' 
  END as has_social
FROM "company-metadata"
WHERE enrichment_status = 'completed'
LIMIT 10;
```

### 3. Test the UI

Visit a stock page with enriched data:

```
http://localhost:3020/shorts/BHP
```

## What to Look For

### ✨ Company Profile (Top Left Card)

**Before enrichment:**
```
┌─────────────────────────┐
│ [Logo] BHP              │
│        BHP Group Ltd    │
│        [Mining Badge]   │
│                         │
│ Basic summary text...   │
└─────────────────────────┘
```

**After enrichment:**
```
┌─────────────────────────┐
│ [Logo] BHP ✨           │
│        BHP Group Ltd    │
│        [Mining] [Iron Ore] [Copper] │
│                         │
│ Enhanced AI-generated   │
│ summary with deeper     │
│ insights...             │
└─────────────────────────┘
```

**Look for:**
- ✨ **Sparkle icon** next to stock code (indicates enriched data)
- 🏷️ **Additional badges** showing specialty tags
- 📝 **Enhanced summary** text (more comprehensive than basic summary)

### 📱 Company Info Card (Middle Left)

**New features when enriched:**
```
┌─────────────────────────┐
│ About                   │
├─────────────────────────┤
│ Summary text...         │
├─────────────────────────┤
│ 🌐 Website              │
│ 🏢 Industry             │
│ 📍 Address              │
├─────────────────────────┤
│ Connect                 │
│ [LinkedIn] [Twitter]    │
│ [Facebook] [YouTube]    │
└─────────────────────────┘
```

**Look for:**
- 🔗 **Social media icons** (LinkedIn, Twitter, Facebook, YouTube)
- 🎨 **Hover effects** on social links
- 📱 **"Connect" section** at the bottom

### 💰 Key Metrics Card (New!)

**Only appears for enriched companies:**
```
┌─────────────────────────┐
│ 📊 Key Metrics          │
├─────────────────────────┤
│ 💰 Market Cap: $123.4B  │
│ 💵 Price: $45.67       │
│ 📈 P/E Ratio: 12.34    │
│ 💹 EPS: $3.45          │
│ 💸 Dividend: 4.5%      │
│ 👥 Employees: 80,000   │
└─────────────────────────┘
```

**Look for:**
- 💰 **Formatted currency** (B/M/K notation)
- 📊 **Financial metrics** from Yahoo Finance
- 👥 **Employee count** with thousands separator

### 📊 Enriched Company Insights (Main Content)

**Bottom of the page (full width section):**
```
┌───────────────────────────────────────┐
│ Industry & Focus                      │
│ [Badge1] [Badge2] [Badge3] [Badge4]   │
├───────────────────────────────────────┤
│ Company Overview                      │
│ Comprehensive AI-generated summary... │
├───────────────────────────────────────┤
│ Company History                       │
│ Historical timeline and milestones... │
├───────────────────────────────────────┤
│ 💪 Competitive Advantages             │
│ Unique strengths...                   │
├───────────────────────────────────────┤
│ ⚠️  Risk Factors                      │
│ • Risk 1                              │
│ • Risk 2                              │
├───────────────────────────────────────┤
│ 📰 Recent Developments                │
│ Latest news and announcements...      │
├───────────────────────────────────────┤
│ 👥 Key People                         │
│ [CEO Name & Bio]                      │
│ [CFO Name & Bio]                      │
├───────────────────────────────────────┤
│ 📄 Financial Reports                  │
│ • Annual Report 2023                  │
│ • Quarterly Report Q2 2024            │
└───────────────────────────────────────┘
```

**Look for:**
- 🏷️ **All industry tags** (not just first 2)
- 📚 **Complete company history**
- 💪 **Green border** on competitive advantages card
- ⚠️  **Amber border** on risk factors card
- 📰 **Blue border** on recent developments card
- 👥 **Leadership team** with bios
- 📄 **Clickable report links**

## Testing Scenarios

### Scenario 1: Non-Enriched Company

1. Find a non-enriched company:
```sql
SELECT stock_code FROM "company-metadata" 
WHERE enrichment_status != 'completed' 
LIMIT 1;
```

2. Visit the stock page
3. **Expected:**
   - ❌ No sparkle icon
   - ❌ No specialty tags (only industry badge)
   - ❌ No social media links
   - ❌ No "Key Metrics" card
   - ❌ "Company Insights" shows "not available yet" message

### Scenario 2: Enriched Company

1. Find an enriched company (e.g., BHP)
2. Visit the stock page
3. **Expected:**
   - ✅ Sparkle icon visible
   - ✅ 2-3 specialty tags shown
   - ✅ Social media icons (if available)
   - ✅ "Key Metrics" card with financial data
   - ✅ Full "Company Insights" section with all data

### Scenario 3: Responsive Design

Test on different screen sizes:

**Desktop (1920px+):**
- Sidebar: 1/3 width
- Main content: 2/3 width
- All cards visible side-by-side

**Tablet (768px - 1024px):**
- Sidebar: Full width stacked
- Main content: Full width below
- Cards stack vertically

**Mobile (< 768px):**
- All cards full width
- Social media icons in row
- Tags wrap to multiple lines

## Browser Console Checks

Open browser DevTools (F12) and check:

### No Console Errors
```javascript
// Should be clean, no errors related to:
// - Missing social media links
// - Undefined financial data
// - Failed component renders
```

### Network Tab
```
✅ StockDetails API call returns enrichment fields
✅ Response includes tags[], enhanced_summary, etc.
```

### React DevTools
```
✅ CompanyProfile receives enrichmentStatus='completed'
✅ CompanyInfo receives socialMediaLinks object
✅ CompanyFinancials receives financialStatements.info
```

## Database Verification

### Check Enrichment Status

```sql
-- Count by status
SELECT 
  enrichment_status, 
  COUNT(*) as count
FROM "company-metadata"
GROUP BY enrichment_status;

-- Expected output:
-- enrichment_status | count
-- ------------------+-------
-- completed         |   4+
-- pending           |   1996-
```

### Check Enriched Data Quality

```sql
-- Verify enriched fields are populated
SELECT 
  stock_code,
  company_name,
  CASE WHEN tags IS NOT NULL THEN array_length(tags, 1) ELSE 0 END as tag_count,
  CASE WHEN enhanced_summary IS NOT NULL THEN length(enhanced_summary) ELSE 0 END as summary_length,
  CASE WHEN key_people IS NOT NULL THEN jsonb_array_length(key_people) ELSE 0 END as people_count,
  CASE WHEN financial_reports IS NOT NULL THEN jsonb_array_length(financial_reports) ELSE 0 END as report_count
FROM "company-metadata"
WHERE enrichment_status = 'completed'
LIMIT 5;
```

## Performance Testing

### Page Load Time

```bash
# Use curl to test API response time
time curl http://localhost:9091/api/v1/stocks/BHP/details

# Should be < 500ms
```

### Component Rendering

```javascript
// In browser console
console.time('CompanyProfile');
// Navigate to stock page
console.timeEnd('CompanyProfile');

// Should be < 100ms for client-side hydration
```

## Common Issues & Solutions

### Issue: No sparkle icon shows

**Check:**
```javascript
// In browser DevTools
stockDetails.enrichmentStatus === 'completed'  // Should be true
```

**Solution:** Verify database has `enrichment_status = 'completed'`

### Issue: Social media links not showing

**Check:**
```javascript
// In browser DevTools
stockDetails.socialMediaLinks  // Should be an object
```

**Solution:** Verify database has `social_media_links` JSONB populated

### Issue: Key Metrics card missing

**Check:**
```javascript
// In browser DevTools
stockDetails.financialStatements?.info  // Should have data
```

**Solution:** Verify database has `financial_statements` JSONB with `info` key

### Issue: Tags not displaying

**Check:**
```javascript
// In browser DevTools
stockDetails.tags  // Should be an array
```

**Solution:** Verify database has `tags` TEXT[] array populated

## Screenshots to Take

For documentation/verification:

1. **Before/After Comparison**
   - Screenshot of non-enriched company
   - Screenshot of enriched company
   - Side-by-side comparison

2. **Key Features**
   - Sparkle icon close-up
   - Tags badges close-up
   - Social media links section
   - Key Metrics card
   - Full Company Insights section

3. **Responsive Views**
   - Desktop view (full layout)
   - Tablet view (stacked)
   - Mobile view (compact)

## Success Criteria

✅ All enriched features display correctly
✅ No console errors or warnings
✅ Graceful fallback for non-enriched companies
✅ Social media links are clickable
✅ Financial metrics format correctly
✅ Page loads in < 3 seconds (First Contentful Paint)
✅ Responsive on all screen sizes
✅ SEO meta tags include enriched data
✅ Structured data includes enhanced information

## Next Steps After Testing

If everything works:
1. ✅ Mark this task complete
2. 📝 Update project README with enriched features
3. 🎨 Consider additional UI polish (animations, transitions)
4. 📊 Set up monitoring for enrichment pipeline
5. 🔄 Plan batch enrichment of remaining companies

If issues found:
1. 🐛 Document the bug with screenshots
2. 🔍 Check browser console for errors
3. 🗄️ Verify database data integrity
4. 🔧 Debug component props and state
5. 💬 Report findings for fix


