import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

// Custom metrics for stress testing
export let errorRate = new Rate('errors');
export let stressTestDuration = new Trend('stress_test_duration');
export let activeUsers = new Gauge('active_users');
export let failedRequests = new Counter('failed_requests_total');
export let successfulRequests = new Counter('successful_requests_total');

// Endpoint-specific metrics
export let topShortsStress = new Trend('get_top_shorts_stress_duration');
export let stockStress = new Trend('get_stock_stress_duration');
export let stockDataStress = new Trend('get_stock_data_stress_duration');
export let treeMapStress = new Trend('get_industry_treemap_stress_duration');

// Stress test configuration - aggressive ramp up to find breaking point
export let options = {
  stages: [
    // Gradual ramp up
    { duration: '3m', target: 50 },    // Warm up to 50 users
    { duration: '2m', target: 100 },   // Ramp to 100 users
    { duration: '2m', target: 200 },   // Ramp to 200 users
    { duration: '3m', target: 300 },   // Ramp to 300 users
    { duration: '3m', target: 500 },   // Ramp to 500 users (stress level)
    { duration: '5m', target: 750 },   // Ramp to 750 users (high stress)
    { duration: '5m', target: 1000 },  // Ramp to 1000 users (breaking point test)
    { duration: '10m', target: 1000 }, // Sustain 1000 users
    { duration: '5m', target: 500 },   // Scale back down
    { duration: '3m', target: 100 },   // Further scale down
    { duration: '2m', target: 0 },     // Complete ramp down
  ],
  thresholds: {
    // More lenient thresholds for stress testing
    http_req_duration: ['p(90) < 5000', 'p(95) < 10000', 'p(99) < 15000'],
    http_req_failed: ['rate < 0.15'], // Allow up to 15% failures under stress
    errors: ['rate < 0.15'],
    
    // Endpoint-specific stress thresholds
    get_top_shorts_stress_duration: ['p(95) < 3000'],
    get_stock_stress_duration: ['p(95) < 2000'],
    get_stock_data_stress_duration: ['p(95) < 5000'],
    get_industry_treemap_stress_duration: ['p(95) < 8000'],
  },
  // Resource monitoring
  noConnectionReuse: false,
  userAgent: 'K6StressTest/1.0',
};

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:9091';
const CONTENT_TYPE = 'application/json';
const STRESS_THRESHOLD = 500; // User count where we consider it "stress"

// Test data - more comprehensive for stress testing
const STOCK_CODES = [
  'CBA', 'BHP', 'ANZ', 'WBC', 'NAB', 'CSL', 'WOW', 'TLS', 'RIO', 'WES',
  'MQG', 'TCL', 'STO', 'QBE', 'WPL', 'ALL', 'JHX', 'COL', 'ILU', 'REA',
  'FMG', 'S32', 'COH', 'WOR', 'GMG', 'ASX', 'XRO', 'APT', 'AFG', 'AMP',
  'IAG', 'MIN', 'BOQ', 'BSL', 'CPU', 'DXS', 'EVN', 'FBU', 'GPT', 'HVN'
];

const PERIODS = ['1w', '1m', '3m', '6m', '1y', '2y'];
const LIMITS = [5, 10, 25, 50, 100];
const VIEW_MODES = ['CURRENT_CHANGE', 'PERCENTAGE_CHANGE'];

// Advanced request maker with retry logic and error handling
function makeStressRequest(endpoint, payload, metricTrend, retries = 2) {
  const params = {
    headers: {
      'Content-Type': CONTENT_TYPE,
      'User-Agent': 'K6StressTest/1.0',
    },
    timeout: '45s', // Longer timeout for stress conditions
  };
  
  let response;
  let attempt = 0;
  
  do {
    attempt++;
    response = http.post(`${BASE_URL}${endpoint}`, JSON.stringify(payload), params);
    
    // Record active users metric
    activeUsers.add(__VU);
    
    // Check if we should retry
    if (response.status >= 500 && attempt <= retries) {
      console.log(`Attempt ${attempt} failed with status ${response.status}, retrying...`);
      sleep(0.5); // Brief delay before retry
      continue;
    }
    break;
  } while (attempt <= retries);
  
  // Record metrics
  if (metricTrend) {
    metricTrend.add(response.timings.duration);
  }
  stressTestDuration.add(response.timings.duration);
  
  // Enhanced error checking for stress conditions
  const success = check(response, {
    'status is not 5xx': (r) => r.status < 500,
    'status is success or acceptable error': (r) => r.status < 400 || r.status === 429, // Allow rate limiting
    'response time < 45s': (r) => r.timings.duration < 45000,
    'response exists': (r) => r.body !== null,
  });
  
  if (success) {
    successfulRequests.add(1);
  } else {
    failedRequests.add(1);
    errorRate.add(1);
    
    // Log detailed error information for analysis
    console.log(`Stress test error - VU: ${__VU}, Iteration: ${__ITER}, ` +
               `Endpoint: ${endpoint}, Status: ${response.status}, ` +
               `Duration: ${response.timings.duration}ms, Body: ${response.body.substring(0, 200)}`);
  }
  
  return response;
}

// Get random element with weighted distribution
function getWeightedRandomElement(array, weights) {
  if (!weights) {
    return array[Math.floor(Math.random() * array.length)];
  }
  
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let random = Math.random() * totalWeight;
  
  for (let i = 0; i < array.length; i++) {
    random -= weights[i];
    if (random <= 0) {
      return array[i];
    }
  }
  return array[array.length - 1];
}

// Main stress test function
export default function() {
  // Determine current stress level based on virtual users
  const currentVUs = __VU;
  const isHighStress = currentVUs > STRESS_THRESHOLD;
  
  // Adjust behavior based on stress level
  const thinkTime = isHighStress ? Math.random() * 0.5 : Math.random() * 2 + 0.5;
  
  // Weighted scenario selection (more realistic under stress)
  const scenario = Math.random();
  
  if (scenario < 0.35) {
    // 35% - Most common endpoint
    testGetTopShortsStress();
  } else if (scenario < 0.65) {
    // 30% - Individual stock lookup
    testGetStockStress();
  } else if (scenario < 0.80) {
    // 15% - Historical data (resource intensive)
    testGetStockDataStress();
  } else if (scenario < 0.92) {
    // 12% - Stock details
    testGetStockDetailsStress();
  } else {
    // 8% - Tree map (most resource intensive)
    testGetIndustryTreeMapStress();
  }
  
  sleep(thinkTime);
}

function testGetTopShortsStress() {
  group('GetTopShorts Stress Test', () => {
    // Use weighted selection for more realistic load patterns
    const period = getWeightedRandomElement(PERIODS, [0.4, 0.3, 0.15, 0.1, 0.04, 0.01]);
    const limit = getWeightedRandomElement(LIMITS, [0.1, 0.4, 0.3, 0.15, 0.05]);
    const offset = Math.floor(Math.random() * 50);
    
    const payload = {
      period: period,
      limit: limit,
      offset: offset,
    };
    
    const response = makeStressRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetTopShorts',
      payload,
      topShortsStress
    );
    
    // Stress-specific validations
    check(response, {
      'GetTopShorts stress: data structure intact': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body && (body.timeSeries !== undefined);
        } catch (e) {
          return false;
        }
      },
      'GetTopShorts stress: reasonable response size': (r) => r.body.length < 2 * 1024 * 1024, // 2MB limit
    });
  });
}

function testGetStockStress() {
  group('GetStock Stress Test', () => {
    // Bias toward popular stocks for more realistic cache behavior
    const popularStocks = STOCK_CODES.slice(0, 10);
    const allStocks = STOCK_CODES;
    const stockCode = Math.random() < 0.7 ? 
      getWeightedRandomElement(popularStocks) : 
      getWeightedRandomElement(allStocks);
    
    const payload = {
      productCode: stockCode,
    };
    
    const response = makeStressRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetStock',
      payload,
      stockStress
    );
    
    check(response, {
      'GetStock stress: has valid structure': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body && body.productCode;
        } catch (e) {
          return false;
        }
      },
    });
  });
}

function testGetStockDataStress() {
  group('GetStockData Stress Test', () => {
    const stockCode = getWeightedRandomElement(STOCK_CODES.slice(0, 15)); // Popular stocks
    const period = getWeightedRandomElement(PERIODS, [0.3, 0.4, 0.2, 0.07, 0.02, 0.01]);
    
    const payload = {
      productCode: stockCode,
      period: period,
    };
    
    const response = makeStressRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetStockData',
      payload,
      stockDataStress
    );
    
    check(response, {
      'GetStockData stress: data points exist': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body && (body.points !== undefined);
        } catch (e) {
          return false;
        }
      },
      'GetStockData stress: not too large': (r) => r.body.length < 5 * 1024 * 1024, // 5MB limit
    });
  });
}

function testGetStockDetailsStress() {
  group('GetStockDetails Stress Test', () => {
    const stockCode = getWeightedRandomElement(STOCK_CODES);
    
    const payload = {
      productCode: stockCode,
    };
    
    const response = makeStressRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetStockDetails',
      payload,
      new Trend('get_stock_details_stress_duration')
    );
    
    check(response, {
      'GetStockDetails stress: valid response': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body !== null;
        } catch (e) {
          return false;
        }
      },
    });
  });
}

function testGetIndustryTreeMapStress() {
  group('GetIndustryTreeMap Stress Test', () => {
    const period = getWeightedRandomElement(PERIODS, [0.2, 0.5, 0.2, 0.07, 0.02, 0.01]);
    const limit = getWeightedRandomElement(LIMITS.slice(0, 3), [0.3, 0.5, 0.2]); // Smaller limits under stress
    const viewMode = getWeightedRandomElement(VIEW_MODES);
    
    const payload = {
      period: period,
      limit: limit,
      viewMode: viewMode,
    };
    
    const response = makeStressRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap',
      payload,
      treeMapStress
    );
    
    check(response, {
      'GetIndustryTreeMap stress: has structure': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body !== null;
        } catch (e) {
          return false;
        }
      },
      'GetIndustryTreeMap stress: reasonable size': (r) => r.body.length < 3 * 1024 * 1024, // 3MB limit
    });
  });
}

// Stress test specific scenarios
export function testDatabaseConnectionStress() {
  group('Database Connection Pool Stress', () => {
    // Rapidly hit different endpoints to stress connection pool
    const endpoints = [
      () => testGetTopShortsStress(),
      () => testGetStockStress(),
      () => testGetStockDataStress(),
    ];
    
    for (let i = 0; i < 5; i++) {
      const endpoint = endpoints[i % endpoints.length];
      endpoint();
      sleep(0.1); // Minimal delay to stress connections
    }
  });
}

export function testMemoryStress() {
  group('Memory Stress Test', () => {
    // Request large datasets to stress memory
    const largePayloads = [
      { period: '1y', limit: 100, offset: 0 },
      { period: '2y', limit: 50, offset: 0 },
      { period: '6m', limit: 100, offset: 0 },
    ];
    
    for (let payload of largePayloads) {
      makeStressRequest(
        '/shorts.v1alpha1.ShortedStocksService/GetTopShorts',
        payload,
        topShortsStress
      );
      sleep(0.2);
    }
  });
}

// Enhanced summary for stress testing
export function handleSummary(data) {
  const summary = {
    "stress-test-results.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    "stress-test-summary.json": JSON.stringify(data, null, 2),
  };
  
  // Add stress-specific analysis
  const stressAnalysis = {
    timestamp: new Date().toISOString(),
    test_type: 'stress_test',
    max_virtual_users: 1000,
    stress_threshold: STRESS_THRESHOLD,
    metrics: {
      total_requests: data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0,
      failed_requests: data.metrics.failed_requests_total ? data.metrics.failed_requests_total.values.count : 0,
      successful_requests: data.metrics.successful_requests_total ? data.metrics.successful_requests_total.values.count : 0,
      error_rate: data.metrics.errors ? data.metrics.errors.values.rate : 0,
      avg_response_time: data.metrics.http_req_duration ? data.metrics.http_req_duration.values.avg : 0,
      p95_response_time: data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(95)'] : 0,
      p99_response_time: data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(99)'] : 0,
    },
    breaking_point_analysis: {
      // Add analysis based on when error rates spiked
      max_sustainable_users: 'To be determined from test results',
      degradation_point: 'Check error rate trends in detailed results',
      recovery_observed: 'Check if system recovered during ramp down',
    }
  };
  
  summary["stress-test-analysis.json"] = JSON.stringify(stressAnalysis, null, 2);
  
  return summary;
}

// Setup and teardown for stress testing
export function setup() {
  console.log('Setting up STRESS test...');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Max concurrent users: 1000`);
  console.log(`Stress threshold: ${STRESS_THRESHOLD} users`);
  console.log(`Test duration: ~42 minutes`);
  console.log('WARNING: This test will push the system to its limits');
  
  // Extended warmup for stress testing
  const warmupRequests = [
    { endpoint: '/shorts.v1alpha1.ShortedStocksService/GetTopShorts', payload: { period: '1m', limit: 10 } },
    { endpoint: '/shorts.v1alpha1.ShortedStocksService/GetStock', payload: { productCode: 'CBA' } },
    { endpoint: '/shorts.v1alpha1.ShortedStocksService/GetStockData', payload: { productCode: 'BHP', period: '1m' } },
  ];
  
  for (let req of warmupRequests) {
    const response = http.post(
      `${BASE_URL}${req.endpoint}`,
      JSON.stringify(req.payload),
      { headers: { 'Content-Type': CONTENT_TYPE } }
    );
    console.log(`Warmup ${req.endpoint}: ${response.status}`);
  }
  
  return { 
    baseUrl: BASE_URL,
    stressThreshold: STRESS_THRESHOLD,
    startTime: Date.now()
  };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log('Stress test completed.');
  console.log(`Total duration: ${Math.round(duration)} seconds`);
  console.log(`Base URL: ${data.baseUrl}`);
  console.log(`Stress threshold was: ${data.stressThreshold} users`);
  console.log('Check stress-test-results.html and stress-test-analysis.json for detailed analysis.');
  console.log('Look for degradation patterns and breaking points in the results.');
}