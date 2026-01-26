import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

// Custom metrics
export let errorRate = new Rate('errors');
export let getTrendsTopShorts = new Trend('get_top_shorts_duration');
export let getTrendsStock = new Trend('get_stock_duration');
export let getTrendsStockData = new Trend('get_stock_data_duration');
export let getTrendsTreeMap = new Trend('get_industry_treemap_duration');
export let apiCallsCounter = new Counter('api_calls_total');

// Test configuration
export let options = {
  stages: [
    // Ramp-up
    { duration: '2m', target: 10 },   // Ramp up to 10 users over 2 minutes
    { duration: '5m', target: 10 },   // Stay at 10 users for 5 minutes
    { duration: '2m', target: 50 },   // Ramp up to 50 users over 2 minutes
    { duration: '5m', target: 50 },   // Stay at 50 users for 5 minutes
    { duration: '2m', target: 100 },  // Ramp up to 100 users over 2 minutes
    { duration: '10m', target: 100 }, // Stay at 100 users for 10 minutes
    { duration: '5m', target: 0 },    // Ramp down to 0 users over 5 minutes
  ],
  thresholds: {
    // Performance thresholds
    http_req_duration: ['p(90) < 2000', 'p(95) < 3000', 'p(99) < 5000'],
    http_req_failed: ['rate < 0.05'], // Error rate should be less than 5%
    errors: ['rate < 0.05'],
    
    // Endpoint-specific thresholds
    get_top_shorts_duration: ['p(95) < 1000'],
    get_stock_duration: ['p(95) < 500'],
    get_stock_data_duration: ['p(95) < 2000'],
    get_industry_treemap_duration: ['p(95) < 3000'],
  },
};

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:9091';
const CONTENT_TYPE = 'application/json';

// Test data
const STOCK_CODES = ['CBA', 'BHP', 'ANZ', 'WBC', 'NAB', 'CSL', 'WOW', 'TLS', 'RIO', 'WES', 
                     'MQG', 'TCL', 'STO', 'QBE', 'WPL', 'ALL', 'JHX', 'COL', 'ILU', 'REA'];
const PERIODS = ['1w', '1m', '3m', '6m', '1y'];
const LIMITS = [5, 10, 25, 50];
const VIEW_MODES = ['CURRENT_CHANGE', 'PERCENTAGE_CHANGE'];

// Helper function to get random element from array
function getRandomElement(array) {
  return array[Math.floor(Math.random() * array.length)];
}

// Helper function to make API requests
function makeRequest(endpoint, payload, metricTrend) {
  const params = {
    headers: {
      'Content-Type': CONTENT_TYPE,
    },
    timeout: '30s',
  };
  
  const response = http.post(`${BASE_URL}${endpoint}`, JSON.stringify(payload), params);
  
  // Record custom metrics
  apiCallsCounter.add(1);
  if (metricTrend) {
    metricTrend.add(response.timings.duration);
  }
  
  // Check response
  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 30s': (r) => r.timings.duration < 30000,
    'response has body': (r) => r.body && r.body.length > 0,
  });
  
  if (!success) {
    errorRate.add(1);
    console.log(`Request failed: ${endpoint}, Status: ${response.status}, Body: ${response.body}`);
  }
  
  return response;
}

// Test scenarios
export default function() {
  // Simulate realistic user behavior with weighted endpoint usage
  const scenario = Math.random();
  
  if (scenario < 0.4) {
    // 40% - Browse top shorts (most common action)
    testGetTopShorts();
  } else if (scenario < 0.7) {
    // 30% - Look at specific stock
    testGetStock();
  } else if (scenario < 0.85) {
    // 15% - View stock historical data
    testGetStockData();
  } else if (scenario < 0.95) {
    // 10% - View stock details
    testGetStockDetails();
  } else {
    // 5% - View industry treemap
    testGetIndustryTreeMap();
  }
  
  // Think time between requests (1-3 seconds)
  sleep(Math.random() * 2 + 1);
}

function testGetTopShorts() {
  group('GetTopShorts API', () => {
    const period = getRandomElement(PERIODS);
    const limit = getRandomElement(LIMITS);
    const offset = Math.floor(Math.random() * 20); // Random offset 0-19
    
    const payload = {
      period: period,
      limit: limit,
      offset: offset,
    };
    
    const response = makeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetTopShorts',
      payload,
      getTrendsTopShorts
    );
    
    // Additional checks specific to GetTopShorts
    check(response, {
      'GetTopShorts: has time series data': (r) => {
        const body = JSON.parse(r.body);
        return body.timeSeries && Array.isArray(body.timeSeries);
      },
      'GetTopShorts: response size reasonable': (r) => r.body.length < 1024 * 1024, // Less than 1MB
    });
  });
}

function testGetStock() {
  group('GetStock API', () => {
    const stockCode = getRandomElement(STOCK_CODES);
    
    const payload = {
      productCode: stockCode,
    };
    
    const response = makeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetStock',
      payload,
      getTrendsStock
    );
    
    // Additional checks specific to GetStock
    check(response, {
      'GetStock: has product code': (r) => {
        const body = JSON.parse(r.body);
        return body.productCode === stockCode;
      },
      'GetStock: has product name': (r) => {
        const body = JSON.parse(r.body);
        return body.productName && body.productName.length > 0;
      },
    });
  });
}

function testGetStockData() {
  group('GetStockData API', () => {
    const stockCode = getRandomElement(STOCK_CODES);
    const period = getRandomElement(PERIODS);
    
    const payload = {
      productCode: stockCode,
      period: period,
    };
    
    const response = makeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetStockData',
      payload,
      getTrendsStockData
    );
    
    // Additional checks specific to GetStockData
    check(response, {
      'GetStockData: has data points': (r) => {
        const body = JSON.parse(r.body);
        return body.points && Array.isArray(body.points);
      },
      'GetStockData: product code matches': (r) => {
        const body = JSON.parse(r.body);
        return body.productCode === stockCode;
      },
    });
  });
}

function testGetStockDetails() {
  group('GetStockDetails API', () => {
    const stockCode = getRandomElement(STOCK_CODES);
    
    const payload = {
      productCode: stockCode,
    };
    
    const response = makeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetStockDetails',
      payload,
      new Trend('get_stock_details_duration')
    );
    
    // Additional checks specific to GetStockDetails
    check(response, {
      'GetStockDetails: has detailed info': (r) => {
        const body = JSON.parse(r.body);
        return body.productCode === stockCode;
      },
    });
  });
}

function testGetIndustryTreeMap() {
  group('GetIndustryTreeMap API', () => {
    const period = getRandomElement(PERIODS);
    const limit = getRandomElement(LIMITS);
    const viewMode = getRandomElement(VIEW_MODES);
    
    const payload = {
      period: period,
      limit: limit,
      viewMode: viewMode,
    };
    
    const response = makeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap',
      payload,
      getTrendsTreeMap
    );
    
    // Additional checks specific to GetIndustryTreeMap
    check(response, {
      'GetIndustryTreeMap: has industry data': (r) => {
        const body = JSON.parse(r.body);
        return body.industries && Array.isArray(body.industries);
      },
      'GetIndustryTreeMap: response not empty': (r) => r.body.length > 100,
    });
  });
}

// Data for specific test scenarios
export function testHighVolumeStock() {
  group('High Volume Stock Test', () => {
    // Test with most popular stocks that likely have more data
    const popularStocks = ['CBA', 'BHP', 'CSL', 'WBC', 'ANZ'];
    
    for (let stock of popularStocks) {
      const payload = { productCode: stock };
      makeRequest('/shorts.v1alpha1.ShortedStocksService/GetStock', payload, getTrendsStock);
      sleep(0.5); // Small delay between requests
    }
  });
}

export function testLargeDatasets() {
  group('Large Dataset Test', () => {
    // Test with larger limits and longer periods
    const payload = {
      period: '1y',
      limit: 50,
      offset: 0,
    };
    
    const response = makeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetTopShorts',
      payload,
      getTrendsTopShorts
    );
    
    check(response, {
      'Large dataset: completes within timeout': (r) => r.timings.duration < 10000,
      'Large dataset: returns substantial data': (r) => r.body.length > 1000,
    });
  });
}

export function testCacheEffectiveness() {
  group('Cache Effectiveness Test', () => {
    const payload = {
      period: '1m',
      limit: 10,
      offset: 0,
    };
    
    // First request (cache miss)
    const firstResponse = makeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetTopShorts',
      payload,
      getTrendsTopShorts
    );
    
    sleep(1); // Small delay
    
    // Second request (should hit cache)
    const secondResponse = makeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetTopShorts',
      payload,
      getTrendsTopShorts
    );
    
    check(secondResponse, {
      'Cached response: faster than first request': () => {
        return secondResponse.timings.duration <= firstResponse.timings.duration;
      },
      'Cached response: same data': () => {
        return firstResponse.body === secondResponse.body;
      },
    });
  });
}

// Custom summary with detailed reporting
export function handleSummary(data) {
  return {
    "load-test-results.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    "load-test-summary.json": JSON.stringify(data, null, 2),
  };
}

// Lifecycle hooks
export function setup() {
  console.log('Setting up load test...');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test duration: ~31 minutes`);
  console.log(`Max concurrent users: 100`);
  
  // Warm up the service
  const warmupPayload = { period: '1m', limit: 5, offset: 0 };
  const warmupResponse = http.post(
    `${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts`,
    JSON.stringify(warmupPayload),
    { headers: { 'Content-Type': CONTENT_TYPE } }
  );
  
  console.log(`Warmup response status: ${warmupResponse.status}`);
  
  return { baseUrl: BASE_URL };
}

export function teardown(data) {
  console.log('Load test completed.');
  console.log(`Base URL used: ${data.baseUrl}`);
  console.log('Check load-test-results.html for detailed results.');
}