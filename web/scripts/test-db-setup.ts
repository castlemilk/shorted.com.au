#!/usr/bin/env tsx
/**
 * Test Database Setup Script
 * Creates test data for E2E testing
 */

import { createClient } from '@supabase/supabase-js';
import { format, subDays } from 'date-fns';

// Test database connection (can be overridden with env vars)
const supabaseUrl = process.env.SUPABASE_URL || 'https://vfzzkelbpyjdvuujyrpu.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'your-anon-key';

// Test stocks to seed
const TEST_STOCKS = [
  { code: 'CBA', name: 'Commonwealth Bank', industry: 'Financials' },
  { code: 'BHP', name: 'BHP Group', industry: 'Materials' },
  { code: 'CSL', name: 'CSL Limited', industry: 'Healthcare' },
  { code: 'WOW', name: 'Woolworths', industry: 'Consumer Staples' },
  { code: 'RIO', name: 'Rio Tinto', industry: 'Materials' },
];

// Generate mock price data
function generatePriceData(stockCode: string, days: number = 365) {
  const data = [];
  const basePrice = Math.random() * 50 + 30; // Random base between 30-80
  
  for (let i = 0; i < days; i++) {
    const date = subDays(new Date(), i);
    const volatility = (Math.random() - 0.5) * 5; // +/- 2.5%
    const price = basePrice * (1 + volatility / 100);
    const volume = Math.floor(Math.random() * 10000000) + 1000000;
    
    data.push({
      stock_code: stockCode,
      date: format(date, 'yyyy-MM-dd'),
      open: +(price * (1 + (Math.random() - 0.5) * 0.02)).toFixed(2),
      high: +(price * (1 + Math.random() * 0.02)).toFixed(2),
      low: +(price * (1 - Math.random() * 0.02)).toFixed(2),
      close: +price.toFixed(2),
      adjusted_close: +price.toFixed(2),
      volume: volume,
    });
  }
  
  return data;
}

// Generate mock short position data
function generateShortData(stockCode: string, days: number = 365) {
  const data = [];
  const baseShortPercent = Math.random() * 10 + 2; // 2-12% short interest
  
  for (let i = 0; i < days; i++) {
    const date = subDays(new Date(), i);
    const variation = (Math.random() - 0.5) * 2; // +/- 1%
    const shortPercent = Math.max(0, baseShortPercent + variation);
    
    data.push({
      Date: format(date, 'yyyy-MM-dd'),
      'Product Code': stockCode,
      'Product Name': TEST_STOCKS.find(s => s.code === stockCode)?.name || stockCode,
      'Total Short Positions': Math.floor(Math.random() * 100000000),
      'Total Product Issued': Math.floor(Math.random() * 1000000000),
      'Reported Gross Short Sales': shortPercent,
      'Percentage of Total Product Issued': shortPercent,
    });
  }
  
  return data;
}

async function setupTestDatabase() {
  console.log('🚀 Setting up test database...\n');
  
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  try {
    // Clear existing test data
    console.log('🗑️  Clearing existing test data...');
    
    // Clear stock prices for test stocks
    for (const stock of TEST_STOCKS) {
      const { error: deleteError } = await supabase
        .from('stock_prices')
        .delete()
        .eq('stock_code', stock.code);
      
      if (deleteError) {
        console.error(`Error clearing ${stock.code}:`, deleteError);
      }
    }
    
    // Clear shorts data for test stocks
    for (const stock of TEST_STOCKS) {
      const { error: deleteError } = await supabase
        .from('shorts')
        .delete()
        .eq('Product Code', stock.code);
      
      if (deleteError) {
        console.error(`Error clearing shorts for ${stock.code}:`, deleteError);
      }
    }
    
    console.log('✅ Cleared existing test data\n');
    
    // Insert test data
    console.log('📊 Inserting test data...');
    
    for (const stock of TEST_STOCKS) {
      console.log(`  Processing ${stock.code}...`);
      
      // Insert price data
      const priceData = generatePriceData(stock.code, 365);
      const { error: priceError } = await supabase
        .from('stock_prices')
        .insert(priceData);
      
      if (priceError) {
        console.error(`    ❌ Error inserting prices for ${stock.code}:`, priceError);
      } else {
        console.log(`    ✅ Inserted ${priceData.length} price records`);
      }
      
      // Insert shorts data
      const shortData = generateShortData(stock.code, 365);
      const { error: shortError } = await supabase
        .from('shorts')
        .insert(shortData);
      
      if (shortError) {
        console.error(`    ❌ Error inserting shorts for ${stock.code}:`, shortError);
      } else {
        console.log(`    ✅ Inserted ${shortData.length} short position records`);
      }
      
      // Insert company metadata
      const { error: metaError } = await supabase
        .from('company-metadata')
        .upsert({
          stock_code: stock.code,
          company_name: stock.name,
          industry: stock.industry,
          market_cap: Math.floor(Math.random() * 100000000000) + 1000000000,
          description: `${stock.name} is a leading company in the ${stock.industry} sector.`,
        });
      
      if (metaError) {
        console.error(`    ❌ Error inserting metadata for ${stock.code}:`, metaError);
      } else {
        console.log(`    ✅ Inserted company metadata`);
      }
    }
    
    console.log('\n🎉 Test database setup complete!');
    
    // Verify data
    console.log('\n📈 Verifying data...');
    
    for (const stock of TEST_STOCKS) {
      const { data: prices, error: priceError } = await supabase
        .from('stock_prices')
        .select('count')
        .eq('stock_code', stock.code);
      
      const { data: shorts, error: shortError } = await supabase
        .from('shorts')
        .select('count')
        .eq('Product Code', stock.code);
      
      console.log(`  ${stock.code}: ${prices?.[0]?.count || 0} prices, ${shorts?.[0]?.count || 0} shorts`);
    }
    
  } catch (error) {
    console.error('❌ Setup failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  setupTestDatabase()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { setupTestDatabase, TEST_STOCKS };