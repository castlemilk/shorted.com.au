#!/usr/bin/env node

/**
 * Test script to verify market data service integration
 * Run with: node test-market-data-integration.js
 */

const http = require('http');

const MARKET_DATA_API_URL = 'http://localhost:8090';

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    };

    const req = http.request(url, requestOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = {
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            data: data ? JSON.parse(data) : null
          };
          resolve(response);
        } catch (error) {
          reject(new Error(`JSON parse error: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
    
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    
    req.end();
  });
}

async function testHealthCheck() {
  console.log('🏥 Testing Health Check...');
  try {
    const response = await makeRequest(`${MARKET_DATA_API_URL}/health`);
    if (response.ok) {
      console.log('  ✅ Health check passed:', response.data.status);
      return true;
    } else {
      console.log('  ❌ Health check failed:', response.status);
      return false;
    }
  } catch (error) {
    console.log('  ❌ Health check error:', error.message);
    return false;
  }
}

async function testMultipleStockQuotes() {
  console.log('📈 Testing Multiple Stock Quotes...');
  try {
    const response = await makeRequest(`${MARKET_DATA_API_URL}/marketdata.v1.MarketDataService/GetMultipleStockPrices`, {
      method: 'POST',
      body: { stockCodes: ['CBA', 'BHP', 'ANZ'] }
    });
    
    if (response.ok && response.data.prices) {
      const stockCount = Object.keys(response.data.prices).length;
      console.log(`  ✅ Got ${stockCount} stock quotes`);
      
      // Verify data structure matches frontend expectations
      const firstStock = Object.entries(response.data.prices)[0];
      const [symbol, price] = firstStock;
      console.log(`  📊 Sample: ${symbol} = $${price.close} (${price.changePercent > 0 ? '+' : ''}${price.changePercent.toFixed(2)}%)`);
      
      // Check required fields
      const requiredFields = ['stockCode', 'date', 'open', 'high', 'low', 'close', 'volume', 'adjustedClose'];
      const hasAllFields = requiredFields.every(field => price[field] !== undefined);
      
      if (hasAllFields) {
        console.log('  ✅ All required fields present');
        return true;
      } else {
        console.log('  ❌ Missing required fields');
        return false;
      }
    } else {
      console.log('  ❌ Invalid response format');
      return false;
    }
  } catch (error) {
    console.log('  ❌ Multiple stocks error:', error.message);
    return false;
  }
}

async function testHistoricalData() {
  console.log('📊 Testing Historical Data...');
  try {
    const response = await makeRequest(`${MARKET_DATA_API_URL}/marketdata.v1.MarketDataService/GetHistoricalPrices`, {
      method: 'POST',
      body: { stockCode: 'CBA', period: '1w' }
    });
    
    if (response.ok && response.data.prices) {
      const dataPoints = response.data.prices.length;
      console.log(`  ✅ Got ${dataPoints} historical data points`);
      
      if (dataPoints > 0) {
        const firstPoint = response.data.prices[0];
        const lastPoint = response.data.prices[dataPoints - 1];
        
        console.log(`  📅 Date range: ${firstPoint.date.split('T')[0]} to ${lastPoint.date.split('T')[0]}`);
        console.log(`  💰 Price range: $${firstPoint.close} to $${lastPoint.close}`);
        
        // Check chronological order (should be ascending)
        const dates = response.data.prices.map(p => new Date(p.date));
        const isChronological = dates.every((date, i) => i === 0 || date >= dates[i - 1]);
        
        if (isChronological) {
          console.log('  ✅ Data is chronologically ordered');
          return true;
        } else {
          console.log('  ❌ Data is not chronologically ordered');
          return false;
        }
      } else {
        console.log('  ⚠️  No historical data points (might be expected for short periods)');
        return true;
      }
    } else {
      console.log('  ❌ Invalid historical data response format');
      return false;
    }
  } catch (error) {
    console.log('  ❌ Historical data error:', error.message);
    return false;
  }
}

async function testCorrelations() {
  console.log('🔗 Testing Stock Correlations...');
  try {
    const response = await makeRequest(`${MARKET_DATA_API_URL}/marketdata.v1.MarketDataService/GetStockCorrelations`, {
      method: 'POST',
      body: { stockCodes: ['CBA', 'BHP'], period: '1m' }
    });
    
    if (response.ok && response.data.correlations) {
      const stocks = Object.keys(response.data.correlations);
      console.log(`  ✅ Got correlations for ${stocks.length} stocks`);
      
      // Check correlation matrix properties
      const cbaCorrelations = response.data.correlations.CBA?.correlations;
      if (cbaCorrelations) {
        console.log(`  🔢 CBA self-correlation: ${cbaCorrelations.CBA} (should be 1.0)`);
        console.log(`  🔢 CBA-BHP correlation: ${cbaCorrelations.BHP?.toFixed(3)}`);
        console.log(`  📊 Data points: ${response.data.dataPoints}`);
        return true;
      } else {
        console.log('  ❌ Missing correlation data structure');
        return false;
      }
    } else {
      console.log('  ❌ Invalid correlation response format');
      return false;
    }
  } catch (error) {
    console.log('  ❌ Correlation error:', error.message);
    return false;
  }
}

async function runAllTests() {
  console.log('🧪 Market Data Service Integration Test');
  console.log('=====================================\n');
  
  const results = {
    health: await testHealthCheck(),
    quotes: false,
    historical: false,
    correlations: false
  };
  
  if (results.health) {
    results.quotes = await testMultipleStockQuotes();
    results.historical = await testHistoricalData();
    results.correlations = await testCorrelations();
  } else {
    console.log('🚫 Skipping other tests due to health check failure');
  }
  
  console.log('\n📋 Test Results Summary:');
  console.log('========================');
  console.log(`Health Check:      ${results.health ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Multiple Quotes:   ${results.quotes ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Historical Data:   ${results.historical ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Stock Correlations: ${results.correlations ? '✅ PASS' : '❌ FAIL'}`);
  
  const allPassed = Object.values(results).every(result => result === true);
  console.log(`\n🎯 Overall Result: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  
  if (allPassed) {
    console.log('\n🎉 Frontend integration is working correctly!');
    console.log('   The Connect RPC market data service is properly integrated.');
  } else {
    console.log('\n⚠️  Some integration issues detected.');
    console.log('   Check the failed tests above for details.');
  }
  
  process.exit(allPassed ? 0 : 1);
}

// Run the tests
runAllTests().catch((error) => {
  console.error('💥 Test runner crashed:', error);
  process.exit(1);
});