#!/usr/bin/env node

/**
 * ASIC Data Sync Script
 * Downloads daily short position data from ASIC and updates the database
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { parse } from 'csv-parse';
import { format, subDays } from 'date-fns';
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';

// Load environment variables
dotenv.config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// ASIC data URL pattern
const ASIC_BASE_URL = 'https://download.asic.gov.au/';
const ASIC_DATA_PATH = 'daily_short_positions/';

interface ShortPosition {
  DATE: string;
  PRODUCT: string;
  PRODUCT_CODE: string;
  REPORTED_SHORT_POSITIONS: number;
  TOTAL_PRODUCT_IN_ISSUE: number;
  PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS: number;
}

/**
 * Generate ASIC filename for a given date
 */
function getASICFilename(date: Date): string {
  const dateStr = format(date, 'yyyyMMdd');
  return `RR${dateStr}-001-SSDailyAggShortPos.csv`;
}

/**
 * Download CSV data from ASIC
 */
async function downloadASICData(date: Date): Promise<string | null> {
  const filename = getASICFilename(date);
  const url = `${ASIC_BASE_URL}${ASIC_DATA_PATH}${filename}`;
  
  try {
    console.log(`📥 Downloading: ${filename}`);
    const response = await axios.get(url, {
      responseType: 'text',
      timeout: 30000,
    });
    
    if (response.status === 200) {
      console.log(`✅ Downloaded: ${filename}`);
      return response.data;
    }
  } catch (error: any) {
    if (error.response?.status === 404) {
      console.log(`⚠️  No data available for ${format(date, 'yyyy-MM-dd')} (weekend/holiday)`);
    } else {
      console.error(`❌ Failed to download ${filename}:`, error.message);
    }
  }
  
  return null;
}

/**
 * Parse CSV data into structured format
 */
async function parseCSVData(csvData: string): Promise<ShortPosition[]> {
  return new Promise((resolve, reject) => {
    const records: ShortPosition[] = [];
    
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    
    parser.on('readable', function() {
      let record;
      while ((record = parser.read()) !== null) {
        // Convert date format from DD/MM/YYYY to ISO
        const [day, month, year] = record['Date'].split('/');
        const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        
        records.push({
          DATE: isoDate,
          PRODUCT: record['Product'],
          PRODUCT_CODE: record['Product Code'],
          REPORTED_SHORT_POSITIONS: parseFloat(record['Reported Short Positions'] || '0'),
          TOTAL_PRODUCT_IN_ISSUE: parseFloat(record['Total Product in Issue'] || '0'),
          PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS: 
            parseFloat(record['% of Total Product in Issue Reported as Short Positions'] || '0'),
        });
      }
    });
    
    parser.on('error', reject);
    parser.on('end', () => resolve(records));
    
    parser.write(csvData);
    parser.end();
  });
}

/**
 * Insert data into Supabase
 */
async function insertData(records: ShortPosition[]): Promise<void> {
  const progressBar = new cliProgress.SingleBar({
    format: 'Inserting |{bar}| {percentage}% | {value}/{total} records',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
  });
  
  progressBar.start(records.length, 0);
  
  // Insert in batches of 500
  const batchSize = 500;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    
    const { error } = await supabase
      .from('shorts')
      .upsert(batch, {
        onConflict: 'PRODUCT_CODE,DATE',
        ignoreDuplicates: false,
      });
    
    if (error) {
      console.error('\n❌ Insert error:', error);
      throw error;
    }
    
    progressBar.update(Math.min(i + batchSize, records.length));
  }
  
  progressBar.stop();
  console.log(`✅ Inserted ${records.length} records`);
}

/**
 * Log ingestion details
 */
async function logIngestion(
  date: Date,
  recordCount: number,
  status: 'completed' | 'failed',
  error?: string
): Promise<void> {
  await supabase.from('stock_data_ingestion_log').insert({
    data_source: 'ASIC',
    start_date: format(date, 'yyyy-MM-dd'),
    end_date: format(date, 'yyyy-MM-dd'),
    stocks_processed: recordCount > 0 ? Math.floor(recordCount / 10) : 0, // Estimate
    records_inserted: recordCount,
    status,
    error_details: error ? { message: error } : null,
    completed_at: new Date().toISOString(),
  });
}

/**
 * Main sync function
 */
async function syncASICData(daysBack: number = 7): Promise<void> {
  console.log('🚀 ASIC Data Sync');
  console.log('=================\n');
  
  const today = new Date();
  let totalRecords = 0;
  let successDays = 0;
  let failedDays = 0;
  
  for (let i = 0; i < daysBack; i++) {
    const date = subDays(today, i);
    console.log(`\n📅 Processing ${format(date, 'yyyy-MM-dd')}`);
    
    try {
      // Download CSV
      const csvData = await downloadASICData(date);
      
      if (!csvData) {
        failedDays++;
        continue;
      }
      
      // Parse CSV
      const records = await parseCSVData(csvData);
      console.log(`📊 Parsed ${records.length} records`);
      
      // Insert into database
      await insertData(records);
      
      // Log success
      await logIngestion(date, records.length, 'completed');
      
      totalRecords += records.length;
      successDays++;
      
    } catch (error: any) {
      console.error(`❌ Failed to process ${format(date, 'yyyy-MM-dd')}:`, error.message);
      await logIngestion(date, 0, 'failed', error.message);
      failedDays++;
    }
  }
  
  console.log('\n📊 Sync Summary:');
  console.log(`   Days processed: ${daysBack}`);
  console.log(`   Successful: ${successDays}`);
  console.log(`   Failed/Skipped: ${failedDays}`);
  console.log(`   Total records: ${totalRecords}`);
}

// Parse command line arguments
const args = process.argv.slice(2);
const daysBack = args.includes('--days') 
  ? parseInt(args[args.indexOf('--days') + 1]) || 7
  : 7;

// Run the sync
syncASICData(daysBack)
  .then(() => {
    console.log('\n✅ ASIC data sync completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Sync failed:', error);
    process.exit(1);
  });