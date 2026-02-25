#!/usr/bin/env tsx
/**
 * Sync company metadata from PostgreSQL to Algolia
 * 
 * Usage:
 *   npm run algolia:sync
 *   
 * Environment variables required:
 *   - DATABASE_URL: PostgreSQL connection string
 *   - ALGOLIA_APP_ID: Algolia Application ID
 *   - ALGOLIA_ADMIN_KEY: Algolia Admin API Key (write access)
 *   - ALGOLIA_INDEX: Index name (default: "stocks")
 */

import { algoliasearch } from 'algoliasearch';
import pg from 'pg';

const { Pool } = pg;

// Configuration
const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID || process.env.NEXT_PUBLIC_ALGOLIA_APP_ID;
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const ALGOLIA_INDEX = process.env.ALGOLIA_INDEX || 'stocks';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://admin:password@localhost:5438/shorts';

interface StockRecord {
  objectID: string;
  stock_code: string;
  company_name: string;
  industry: string;
  summary: string;
  details: string;
  enhanced_summary: string;
  company_history: string;
  competitive_advantages: string;
  risk_factors: string;
  recent_developments: string;
  tags: string[];
  logo_gcs_url: string;
  percentage_shorted: number;
  website: string;
  address: string;
  market_cap: string;
  // New enriched fields
  key_people_names: string;
  key_people_roles: string[];
  pe_ratio: number | null;
  eps: number | null;
  dividend_yield: number | null;
  market_cap_numeric: number | null;
}

/** Parse human-readable market cap strings like "1.2B", "500M", "12.3T" to numeric */
function parseMarketCap(marketCap: string): number | null {
  if (!marketCap) return null;
  const cleaned = marketCap.trim().toUpperCase();
  const match = cleaned.match(/^[\$]?\s*([\d,.]+)\s*([KMBT])?$/);
  if (!match) {
    // Try parsing as raw number (some DB entries store raw integers)
    const raw = parseFloat(cleaned.replace(/[,$]/g, ''));
    return isNaN(raw) ? null : raw;
  }
  const num = parseFloat(match[1]!.replace(/,/g, ''));
  if (isNaN(num)) return null;
  const multipliers: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return num * (multipliers[match[2] ?? ''] ?? 1);
}

async function fetchStocksFromDatabase(): Promise<StockRecord[]> {
  console.log('📦 Connecting to PostgreSQL...');
  
  const pool = new Pool({
    connectionString: DATABASE_URL,
  });

  try {
    // Join company-metadata with latest shorts data to get percentage_shorted
    // Fetch all rich metadata fields for comprehensive search
    const query = `
      WITH latest_shorts AS (
        SELECT DISTINCT ON ("PRODUCT_CODE")
          "PRODUCT_CODE" as product_code,
          "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as percentage_shorted
        FROM shorts
        ORDER BY "PRODUCT_CODE", "DATE" DESC
      )
      SELECT
        m.stock_code,
        COALESCE(m.company_name, '') as company_name,
        COALESCE(m.industry, '') as industry,
        COALESCE(m.summary, '') as summary,
        COALESCE(m.details, '') as details,
        COALESCE(m.enhanced_summary, '') as enhanced_summary,
        COALESCE(m.company_history, '') as company_history,
        COALESCE(m.competitive_advantages, '') as competitive_advantages,
        COALESCE(m.risk_factors, '') as risk_factors,
        COALESCE(m.recent_developments, '') as recent_developments,
        COALESCE(m.tags, ARRAY[]::text[]) as tags,
        COALESCE(m.logo_gcs_url, '') as logo_gcs_url,
        COALESCE(m.website, '') as website,
        COALESCE(m.address, '') as address,
        COALESCE(m.market_cap, '') as market_cap,
        COALESCE(s.percentage_shorted, 0) as percentage_shorted,
        COALESCE(m.key_people, '[]'::jsonb) as key_people,
        COALESCE(m.key_metrics, '{}'::jsonb) as key_metrics
      FROM "company-metadata" m
      LEFT JOIN latest_shorts s ON m.stock_code = s.product_code
      WHERE m.stock_code IS NOT NULL AND m.stock_code != ''
      ORDER BY s.percentage_shorted DESC NULLS LAST
    `;

    const result = await pool.query(query);
    console.log(`📊 Found ${result.rows.length} stocks in database`);

    return result.rows.map(row => {
      // Parse key_people JSONB — can be an array of {name, role, ...} objects
      const keyPeople: Array<{ name?: string; role?: string }> = Array.isArray(row.key_people)
        ? row.key_people
        : [];

      // Parse key_metrics JSONB — can be { pe_ratio, eps, dividend_yield, ... }
      const keyMetrics = (typeof row.key_metrics === 'object' && row.key_metrics !== null)
        ? row.key_metrics as Record<string, unknown>
        : {};

      const parseMetric = (val: unknown): number | null => {
        if (val === null || val === undefined || val === '') return null;
        const n = parseFloat(String(val));
        return isNaN(n) ? null : n;
      };

      return {
        objectID: row.stock_code,
        stock_code: row.stock_code,
        company_name: row.company_name,
        industry: row.industry,
        summary: row.summary,
        details: row.details,
        enhanced_summary: row.enhanced_summary,
        company_history: row.company_history,
        competitive_advantages: row.competitive_advantages,
        risk_factors: row.risk_factors,
        recent_developments: row.recent_developments,
        tags: row.tags || [],
        logo_gcs_url: row.logo_gcs_url,
        percentage_shorted: parseFloat(row.percentage_shorted) || 0,
        website: row.website,
        address: row.address,
        market_cap: row.market_cap || '',
        // Enriched fields from JSONB
        key_people_names: keyPeople.map(p => p.name).filter(Boolean).join(', '),
        key_people_roles: keyPeople.map(p => `${p.name ?? ''} ${p.role ?? ''}`.trim()).filter(Boolean),
        pe_ratio: parseMetric(keyMetrics.pe_ratio),
        eps: parseMetric(keyMetrics.eps),
        dividend_yield: parseMetric(keyMetrics.dividend_yield),
        market_cap_numeric: parseMarketCap(row.market_cap || ''),
      };
    });
  } finally {
    await pool.end();
  }
}

async function syncToAlgolia(records: StockRecord[]): Promise<void> {
  if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_KEY) {
    throw new Error('Missing Algolia credentials. Set ALGOLIA_APP_ID and ALGOLIA_ADMIN_KEY environment variables.');
  }

  console.log(`🔍 Connecting to Algolia (App ID: ${ALGOLIA_APP_ID})...`);
  
  const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

  console.log(`📤 Uploading ${records.length} records to index "${ALGOLIA_INDEX}"...`);

  // Save objects to Algolia (replaces existing records with same objectID)
  // Batch in chunks of 1000 to avoid API limits
  const BATCH_SIZE = 1000;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    console.log(`   Uploading batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(records.length / BATCH_SIZE)} (${batch.length} records)...`);
    
    const response = await client.saveObjects({
      indexName: ALGOLIA_INDEX,
      objects: batch,
    });
    
    // Wait for each batch to complete if taskID is available
    if (response && Array.isArray(response) && response.length > 0 && response[0].taskID) {
      await client.waitForTask({
        indexName: ALGOLIA_INDEX,
        taskID: response[0].taskID,
      });
    }
  }

  console.log('✅ Indexing complete!');

  // Configure index settings for optimal search
  console.log('⚙️  Configuring index settings...');
  
  await client.setSettings({
    indexName: ALGOLIA_INDEX,
    indexSettings: {
      // Searchable attributes in RANKED order (top = highest priority)
      // This ensures stock_code exact matches rank above body text mentions
      searchableAttributes: [
        'stock_code',                                         // Tier 1: exact code match
        'company_name',                                       // Tier 2: company name
        'unordered(industry, tags)',                           // Tier 3: classification
        'unordered(key_people_names, key_people_roles)',       // Tier 4: people
        'unordered(summary, enhanced_summary)',                // Tier 5: descriptions
        'unordered(company_history, competitive_advantages, risk_factors, recent_developments, details)', // Tier 6: deep content
        'unordered(address)',                                  // Tier 7: location
      ],

      // Attributes to return in search results
      attributesToRetrieve: [
        'objectID',
        'stock_code',
        'company_name',
        'industry',
        'tags',
        'logo_gcs_url',
        'percentage_shorted',
        'summary',
        'market_cap',
        'market_cap_numeric',
        'pe_ratio',
        'dividend_yield',
        'key_people_names',
      ],

      // Faceting — enable filtering by industry, tags, and numeric ranges
      attributesForFaceting: [
        'searchable(industry)',
        'searchable(tags)',
        'filterOnly(percentage_shorted)',
        'filterOnly(market_cap_numeric)',
        'filterOnly(pe_ratio)',
        'filterOnly(dividend_yield)',
      ],
      
      // Custom ranking (most shorted first by default)
      customRanking: [
        'desc(percentage_shorted)',
      ],
      
      // Enable typo tolerance for fuzzy matching
      typoTolerance: true,
      
      // Minimum characters before typo tolerance kicks in
      minWordSizefor1Typo: 3,
      minWordSizefor2Typos: 6,
      
      // Highlight matching text in results
      attributesToHighlight: [
        'stock_code',
        'company_name',
        'industry',
        'tags',
        'summary',
        'key_people_names',
      ],
      
      // Snippet configuration for long text fields
      attributesToSnippet: [
        'summary:50',
        'enhanced_summary:50',
        'company_history:30',
        'details:50',
      ],
      
      // Remove stop words for better matching
      removeStopWords: true,
      
      // Enable query rules for relevance tuning
      enableRules: true,
      
      // Advanced settings for better search
      advancedSyntax: true,
      
      // Disable exact matching on single word queries (more elastic)
      exactOnSingleWordQuery: 'word',
      
      // Alternative corrections: consider alternatives even if exact match exists
      alternativesAsExact: ['ignorePlurals', 'singleWordSynonym'],
      
      // Ranking formula configuration
      ranking: [
        'typo',           // Fewer typos = higher rank
        'geo',            // Proximity (not used but required)
        'words',          // All query words found
        'filters',        // Matching filter score
        'proximity',      // Word proximity
        'attribute',      // Attribute ranking weight
        'exact',          // Exact match bonus
        'custom',         // Custom ranking (percentage_shorted)
      ],
    },
  });

  console.log('✅ Index settings configured!');
  console.log('   - Ranked search: stock_code > company_name > industry/tags > people > descriptions');
  console.log('   - Facets: industry, tags, percentage_shorted, market_cap_numeric, pe_ratio, dividend_yield');
  console.log('   - Typo tolerance enabled');
  console.log('   - Custom ranking by percentage_shorted');

  // Configure synonyms for better matching
  console.log('📚 Configuring synonyms...');
  await configureSynonyms(client);
  console.log('✅ Synonyms configured!');
}

async function configureSynonyms(client: ReturnType<typeof algoliasearch>): Promise<void> {
  const synonyms = [
    // Industry synonyms
    { objectID: 'syn-mining', type: 'synonym' as const, synonyms: ['mining', 'resources', 'metals', 'minerals'] },
    { objectID: 'syn-banking', type: 'synonym' as const, synonyms: ['banking', 'financial services', 'finance', 'bank'] },
    { objectID: 'syn-tech', type: 'synonym' as const, synonyms: ['technology', 'tech', 'software', 'IT'] },
    { objectID: 'syn-property', type: 'synonym' as const, synonyms: ['real estate', 'property', 'REIT'] },
    { objectID: 'syn-energy', type: 'synonym' as const, synonyms: ['energy', 'oil', 'gas', 'petroleum'] },
    { objectID: 'syn-healthcare', type: 'synonym' as const, synonyms: ['healthcare', 'health', 'pharma', 'biotech', 'medical'] },
    { objectID: 'syn-retail', type: 'synonym' as const, synonyms: ['retail', 'consumer', 'shopping'] },
    { objectID: 'syn-telco', type: 'synonym' as const, synonyms: ['telecommunications', 'telco', 'telecom'] },
    // Common abbreviations (one-way: searching the input also matches the synonym)
    { objectID: 'syn-cba', type: 'oneWaySynonym' as const, input: 'commbank', synonyms: ['commonwealth bank'] },
    { objectID: 'syn-asx', type: 'oneWaySynonym' as const, input: 'asx', synonyms: ['australian securities exchange'] },
    { objectID: 'syn-nab', type: 'oneWaySynonym' as const, input: 'nab', synonyms: ['national australia bank'] },
    { objectID: 'syn-anz-alt', type: 'oneWaySynonym' as const, input: 'anz', synonyms: ['australia and new zealand banking'] },
    { objectID: 'syn-westpac', type: 'oneWaySynonym' as const, input: 'westpac', synonyms: ['westpac banking corporation'] },
    { objectID: 'syn-woolies', type: 'oneWaySynonym' as const, input: 'woolies', synonyms: ['woolworths'] },
    { objectID: 'syn-coles', type: 'oneWaySynonym' as const, input: 'coles', synonyms: ['coles group'] },
    { objectID: 'syn-lithium', type: 'synonym' as const, synonyms: ['lithium', 'battery metals', 'EV metals'] },
  ];

  await client.saveSynonyms({
    indexName: ALGOLIA_INDEX,
    synonymHits: synonyms,
    forwardToReplicas: false,
    replaceExistingSynonyms: true,
  });
}

async function main(): Promise<void> {
  console.log('🚀 Starting Algolia sync...\n');

  try {
    // Fetch data from PostgreSQL
    const records = await fetchStocksFromDatabase();

    if (records.length === 0) {
      console.log('⚠️  No records found in database. Nothing to sync.');
      return;
    }

    // Sync to Algolia
    await syncToAlgolia(records);

    console.log('\n🎉 Algolia sync completed successfully!');
    console.log(`   - Index: ${ALGOLIA_INDEX}`);
    console.log(`   - Records: ${records.length}`);
  } catch (error) {
    console.error('\n❌ Sync failed:', error);
    process.exit(1);
  }
}

main();

