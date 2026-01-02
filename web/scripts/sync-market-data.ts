#!/usr/bin/env node

/**
 * Market Data Sync Script
 * Downloads daily stock price data from Yahoo Finance and updates the database
 * This is a TypeScript wrapper around the Python stock-price-ingestion service
 */

import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import { format, subDays, isWeekend } from 'date-fns';
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';
import path from 'path';
import fs from 'fs';

// Load environment variables
dotenv.config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !DATABASE_URL) {
  console.error('❌ Missing required environment variables:');
  console.error('   NEXT_PUBLIC_SUPABASE_URL');
  console.error('   SUPABASE_SERVICE_ROLE_KEY');
  console.error('   DATABASE_URL');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

interface StockMetadata {
  stock_code: string;
  company_name: string;
  industry: string;
}

interface IngestionLog {
  batch_id: string;
  data_source: string;
  start_date: string;
  end_date: string;
  stocks_processed: number;
  records_inserted: number;
  status: string;
}

/**
 * Get list of ASX stock codes from database
 */
async function getStockCodes(): Promise<string[]> {
  const { data, error } = await supabase
    .from('company-metadata')
    .select('stock_code')
    .order('stock_code');
  
  if (error) {
    console.error('❌ Failed to fetch stock codes:', error);
    return [];
  }
  
  // Add .AX suffix for Yahoo Finance (ASX stocks)
  return (data || []).map(d => `${d.stock_code}.AX`);
}

/**
 * Get popular ASX stocks if no metadata exists
 */
function getDefaultStockCodes(): string[] {
  return [
    'CBA.AX', 'BHP.AX', 'CSL.AX', 'NAB.AX', 'WBC.AX',
    'ANZ.AX', 'MQG.AX', 'WES.AX', 'TLS.AX', 'WOW.AX',
    'RIO.AX', 'FMG.AX', 'TCL.AX', 'GMG.AX', 'ALL.AX',
    'RMD.AX', 'NCM.AX', 'WPL.AX', 'SHL.AX', 'APT.AX',
    'XRO.AX', 'REA.AX', 'COH.AX', 'AMC.AX', 'QBE.AX',
    'SUN.AX', 'IAG.AX', 'ORG.AX', 'APA.AX', 'TWE.AX'
  ];
}

/**
 * Run Python ingestion script
 */
async function runPythonIngestion(
  stocks: string[],
  startDate: Date,
  endDate: Date,
  mode: 'update' | 'backfill' = 'update'
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const pythonScriptPath = path.join(
      __dirname,
      '..',
      '..',
      'services',
      'stock-price-ingestion',
      'main.py'
    );
    
    // Check if Python script exists
    if (!fs.existsSync(pythonScriptPath)) {
      console.error(`❌ Python script not found: ${pythonScriptPath}`);
      reject(new Error('Python script not found'));
      return;
    }
    
    const args = [
      pythonScriptPath,
      '--symbols', stocks.join(','),
      '--start-date', format(startDate, 'yyyy-MM-dd'),
      '--end-date', format(endDate, 'yyyy-MM-dd'),
      '--database-url', DATABASE_URL!,
      '--mode', mode,
      '--batch-size', '50',
      '--max-workers', '5'
    ];
    
    console.log('🐍 Running Python ingestion script...');
    console.log(`   Stocks: ${stocks.length} symbols`);
    console.log(`   Period: ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}`);
    
    const python = spawn('python3', args);
    
    python.stdout.on('data', (data) => {
      process.stdout.write(`   ${data}`);
    });
    
    python.stderr.on('data', (data) => {
      process.stderr.write(`   ⚠️  ${data}`);
    });
    
    python.on('close', (code) => {
      if (code === 0) {
        console.log('✅ Python ingestion completed successfully');
        resolve(true);
      } else {
        console.error(`❌ Python script exited with code ${code}`);
        reject(new Error(`Python script failed with code ${code}`));
      }
    });
    
    python.on('error', (err) => {
      console.error('❌ Failed to start Python script:', err);
      reject(err);
    });
  });
}

/**
 * Insert or update stock prices using Supabase
 */
async function upsertStockPrices(data: any[]): Promise<number> {
  const { error } = await supabase
    .from('stock_prices')
    .upsert(data, {
      onConflict: 'stock_code,date',
      ignoreDuplicates: false
    });
  
  if (error) {
    console.error('❌ Failed to upsert stock prices:', error);
    throw error;
  }
  
  return data.length;
}

/**
 * Check last successful sync date
 */
async function getLastSyncDate(): Promise<Date | null> {
  const { data, error } = await supabase
    .from('stock_data_ingestion_log')
    .select('end_date')
    .eq('data_source', 'yfinance')
    .eq('status', 'completed')
    .order('end_date', { ascending: false })
    .limit(1)
    .single();
  
  if (error || !data) {
    return null;
  }
  
  return new Date(data.end_date);
}

/**
 * Main sync function
 */
async function syncMarketData(options: {
  days?: number;
  backfill?: boolean;
  symbols?: string[];
}): Promise<void> {
  console.log('📈 Market Data Sync');
  console.log('==================\n');
  
  const { days = 1, backfill = false, symbols } = options;
  
  try {
    // Get stock codes
    let stockCodes = symbols || await getStockCodes();
    if (stockCodes.length === 0) {
      console.log('⚠️  No stocks in database, using default list');
      stockCodes = getDefaultStockCodes();
    }
    
    console.log(`📊 Syncing ${stockCodes.length} stocks`);
    
    // Determine date range
    let startDate: Date;
    let endDate = new Date();
    
    if (backfill) {
      // Backfill mode: go back specified days
      startDate = subDays(endDate, days);
    } else {
      // Update mode: sync from last successful sync or specified days
      const lastSync = await getLastSyncDate();
      if (lastSync) {
        startDate = subDays(lastSync, 1); // Overlap by 1 day
        console.log(`📅 Last sync: ${format(lastSync, 'yyyy-MM-dd')}`);
      } else {
        startDate = subDays(endDate, days);
      }
    }
    
    // Skip if trying to sync weekend data only
    if (!backfill && days === 1 && isWeekend(endDate)) {
      console.log('⚠️  Today is weekend, skipping (markets closed)');
      return;
    }
    
    // Run Python ingestion
    const success = await runPythonIngestion(
      stockCodes,
      startDate,
      endDate,
      backfill ? 'backfill' : 'update'
    );
    
    if (success) {
      // Verify data was inserted
      const { count } = await supabase
        .from('stock_prices')
        .select('*', { count: 'exact', head: true })
        .gte('date', format(startDate, 'yyyy-MM-dd'))
        .lte('date', format(endDate, 'yyyy-MM-dd'));
      
      console.log(`\n📊 Sync Summary:`);
      console.log(`   Period: ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}`);
      console.log(`   Stocks: ${stockCodes.length}`);
      console.log(`   Records in period: ${count || 0}`);
    }
    
  } catch (error) {
    console.error('❌ Sync failed:', error);
    throw error;
  }
}

/**
 * Alternative: Direct Yahoo Finance sync (without Python)
 * This is a fallback if Python service is not available
 */
async function directYahooSync(
  symbol: string,
  startDate: Date,
  endDate: Date
): Promise<any[]> {
  // This would require implementing Yahoo Finance API calls directly in Node.js
  // For now, we rely on the Python service which is more robust
  console.warn('⚠️  Direct Yahoo sync not implemented, use Python service');
  return [];
}

// Parse command line arguments
const args = process.argv.slice(2);
const options: any = {};

// Parse --days flag
if (args.includes('--days')) {
  const daysIndex = args.indexOf('--days');
  options.days = parseInt(args[daysIndex + 1]) || 1;
}

// Parse --backfill flag
if (args.includes('--backfill')) {
  options.backfill = true;
}

// Parse --symbols flag
if (args.includes('--symbols')) {
  const symbolsIndex = args.indexOf('--symbols');
  options.symbols = args[symbolsIndex + 1]?.split(',').map(s => s.trim());
}

// Show help
if (args.includes('--help')) {
  console.log(`
Market Data Sync Script

Usage:
  npm run db:sync-market          # Sync last day (update mode)
  npm run db:sync-market:week     # Sync last 7 days
  npm run db:sync-market:month    # Sync last 30 days
  
Options:
  --days <number>      Number of days to sync (default: 1)
  --backfill          Run in backfill mode (re-fetch all data)
  --symbols <list>    Comma-separated list of symbols (e.g., CBA.AX,BHP.AX)
  --help             Show this help message

Examples:
  npm run db:sync-market -- --days 7
  npm run db:sync-market -- --backfill --days 30
  npm run db:sync-market -- --symbols CBA.AX,BHP.AX --days 5
`);
  process.exit(0);
}

// Run the sync
syncMarketData(options)
  .then(() => {
    console.log('\n✅ Market data sync completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Sync failed:', error);
    process.exit(1);
  });