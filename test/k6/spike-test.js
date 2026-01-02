import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

// Custom metrics for spike testing
export let errorRate = new Rate('errors');
export let spikeRecoveryTime = new Trend('spike_recovery_time');
export let peakPerformance = new Gauge('peak_performance_rps');
export let spikeRequests = new Counter('spike_requests_total');
export let recoveryRequests = new Counter('recovery_requests_total');

// Endpoint-specific spike metrics
export let topShortsSpike = new Trend('get_top_shorts_spike_duration');
export let stockSpike = new Trend('get_stock_spike_duration');
export let stockDataSpike = new Trend('get_stock_data_spike_duration');
export let treeMapSpike = new Trend('get_industry_treemap_spike_duration');

// Performance degradation tracking
export let preSpikePerformance = new Trend('pre_spike_performance');
export let peakSpikePerformance = new Trend('peak_spike_performance');
export let postSpikePerformance = new Trend('post_spike_performance');

// Spike test configuration - sudden traffic increases to test system resilience
export let options = {
  stages: [
    // Baseline load
    { duration: '5m', target: 50 },    // Establish baseline performance
    { duration: '2m', target: 50 },    // Maintain baseline
    
    // First spike - moderate
    { duration: '30s', target: 200 },  // Sudden spike to 200 users
    { duration: '2m', target: 200 },   // Hold spike
    { duration: '1m', target: 50 },    // Drop back to baseline
    { duration: '2m', target: 50 },    // Recovery period
    
    // Second spike - high
    { duration: '30s', target: 400 },  // Sudden spike to 400 users
    { duration: '3m', target: 400 },   // Hold spike
    { duration: '1m', target: 50 },    // Drop back to baseline
    { duration: '3m', target: 50 },    // Recovery period
    
    // Third spike - extreme
    { duration: '20s', target: 800 },  // Very sudden spike to 800 users
    { duration: '2m', target: 800 },   // Hold extreme spike
    { duration: '1m', target: 100 },   // Gradual recovery
    { duration: '2m', target: 50 },    // Return to baseline
    { duration: '3m', target: 50 },    // Final recovery assessment
    
    // Cleanup
    { duration: '1m', target: 0 },     // Ramp down
  ],
  thresholds: {
    // Spike-specific thresholds (more lenient during spikes)
    http_req_duration: ['p(90) < 8000', 'p(95) < 15000', 'p(99) < 30000'],
    http_req_failed: ['rate < 0.25'], // Allow up to 25% failures during spikes
    errors: ['rate < 0.25'],
    
    // Recovery thresholds (system should recover after spike)
    'http_req_duration{scenario:recovery}': ['p(95) < 2000'],
    'http_req_failed{scenario:recovery}': ['rate < 0.05'],
    
    // Baseline performance should remain stable
    'http_req_duration{scenario:baseline}': ['p(95) < 1000'],
    'http_req_failed{scenario:baseline}': ['rate < 0.02'],
  },
  // Aggressive connection settings for spike testing
  batch: 20,
  batchPerHost: 10,
  noConnectionReuse: false,
  userAgent: 'K6SpikeTest/1.0',
};

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:9091';
const CONTENT_TYPE = 'application/json';

// Test phase detection based on VU count
function getCurrentPhase() {
  const currentVUs = __VU;
  if (currentVUs <= 50) {
    return 'baseline';
  } else if (currentVUs <= 200) {
    return 'spike_1';
  } else if (currentVUs <= 400) {
    return 'spike_2';
  } else {
    return 'spike_3';
  }
}

// Test data
const STOCK_CODES = [
  'CBA', 'BHP', 'ANZ', 'WBC', 'NAB', 'CSL', 'WOW', 'TLS', 'RIO', 'WES',
  'MQG', 'TCL', 'STO', 'QBE', 'WPL', 'ALL', 'JHX', 'COL', 'ILU', 'REA'
];
const PERIODS = ['1w', '1m', '3m', '6m', '1y'];
const LIMITS = [5, 10, 25, 50];
const VIEW_MODES = ['CURRENT_CHANGE', 'PERCENTAGE_CHANGE'];

// Enhanced request function with spike-specific handling
function makeSpikeRequest(endpoint, payload, metricTrend, retryOnSpike = true) {
  const phase = getCurrentPhase();
  const isSpike = phase.startsWith('spike_');
  
  const params = {
    headers: {
      'Content-Type': CONTENT_TYPE,
      'User-Agent': 'K6SpikeTest/1.0',
      'X-Test-Phase': phase,
    },
    timeout: isSpike ? '60s' : '30s', // Longer timeout during spikes
    tags: {
      scenario: phase,
    },
  };
  
  const startTime = Date.now();
  let response;
  let attempt = 0;
  const maxRetries = isSpike && retryOnSpike ? 3 : 1;
  
  do {
    attempt++;
    response = http.post(`${BASE_URL}${endpoint}`, JSON.stringify(payload), params);
    
    // Record spike-specific requests
    if (isSpike) {
      spikeRequests.add(1);
    } else if (phase === 'baseline') {
      // Track recovery performance
      const recoveryTime = Date.now() - startTime;
      spikeRecoveryTime.add(recoveryTime);
      recoveryRequests.add(1);
    }
    
    // Retry logic for spikes
    if (response.status >= 500 && attempt < maxRetries && isSpike) {
      console.log(`Spike retry ${attempt}: Status ${response.status}, VUs: ${__VU}`);
      sleep(Math.random() * 1); // Jittered delay
      continue;
    }
    break;
  } while (attempt < maxRetries);
  
  // Record metrics based on phase
  const duration = response.timings.duration;
  if (metricTrend) {
    metricTrend.add(duration);
  }
  
  // Phase-specific performance tracking
  switch (phase) {
    case 'baseline':
      preSpikePerformance.add(duration);
      postSpikePerformance.add(duration); // Also track as recovery
      break;
    case 'spike_1':
    case 'spike_2':
    case 'spike_3':
      peakSpikePerformance.add(duration);
      break;
  }
  
  // Spike-specific checks
  const success = check(response, {
    'spike: not server error': (r) => r.status < 500,
    'spike: response exists': (r) => r.body !== null && r.body !== undefined,
    'spike: within timeout': (r) => r.timings.duration < (isSpike ? 60000 : 30000),
    'spike: acceptable status': (r) => r.status < 400 || r.status === 429 || r.status === 503, // Allow rate limiting and service unavailable
  }, {
    scenario: phase,
    endpoint: endpoint.split('/').pop(),
  });
  
  if (!success) {
    errorRate.add(1);
    console.log(`Spike test failure - Phase: ${phase}, VU: ${__VU}, ` +
               `Status: ${response.status}, Duration: ${duration}ms, ` +
               `Body: ${response.body ? response.body.substring(0, 100) : 'null'}`);
  }
  
  return response;
}

// Main spike test function
export default function() {
  const phase = getCurrentPhase();
  const isSpike = phase.startsWith('spike_');
  
  // Adjust behavior based on current phase
  let thinkTime;
  if (isSpike) {
    // During spikes, users are more aggressive
    thinkTime = Math.random() * 0.5; // 0-0.5 seconds
  } else {
    // During baseline, normal user behavior
    thinkTime = Math.random() * 2 + 1; // 1-3 seconds
  }
  
  // Weighted scenario selection based on phase
  const scenario = Math.random();
  
  if (scenario < 0.4) {
    // 40% - GetTopShorts (most likely to be cached)
    testGetTopShortsSpike();
  } else if (scenario < 0.7) {
    // 30% - GetStock (individual stock lookup)
    testGetStockSpike();
  } else if (scenario < 0.85) {
    // 15% - GetStockData (more resource intensive)
    testGetStockDataSpike();
  } else if (scenario < 0.95) {
    // 10% - GetStockDetails
    testGetStockDetailsSpike();
  } else {
    // 5% - GetIndustryTreeMap (most resource intensive)
    testGetIndustryTreeMapSpike();
  }
  
  sleep(thinkTime);
}

function testGetTopShortsSpike() {
  group('GetTopShorts Spike Test', () => {
    const phase = getCurrentPhase();
    
    // Vary parameters based on phase
    let period, limit, offset;
    if (phase === 'baseline') {
      period = PERIODS[Math.floor(Math.random() * 3)]; // Shorter periods
      limit = LIMITS[Math.floor(Math.random() * 3)]; // Smaller limits
      offset = Math.floor(Math.random() * 10);
    } else {
      // During spikes, mix of heavy and light requests
      period = PERIODS[Math.floor(Math.random() * PERIODS.length)];
      limit = LIMITS[Math.floor(Math.random() * LIMITS.length)];
      offset = Math.floor(Math.random() * 20);
    }
    
    const payload = {
      period: period,
      limit: limit,
      offset: offset,
    };
    
    const response = makeSpikeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetTopShorts',
      payload,
      topShortsSpike
    );
    
    // Phase-specific validation
    if (response.status === 200) {
      check(response, {
        'GetTopShorts spike: valid data structure': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body && body.timeSeries !== undefined;
          } catch (e) {
            return false;
          }
        },
      }, { scenario: phase });
    }
  });
}

function testGetStockSpike() {
  group('GetStock Spike Test', () => {
    const phase = getCurrentPhase();
    
    // During spikes, bias toward popular stocks (better cache hit rate)
    let stockCode;
    if (phase.startsWith('spike_')) {
      stockCode = STOCK_CODES[Math.floor(Math.random() * 10)]; // Top 10 stocks
    } else {
      stockCode = STOCK_CODES[Math.floor(Math.random() * STOCK_CODES.length)];
    }
    
    const payload = {
      productCode: stockCode,
    };
    
    const response = makeSpikeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetStock',
      payload,
      stockSpike
    );
    
    if (response.status === 200) {
      check(response, {
        'GetStock spike: correct product code': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body && body.productCode === stockCode;
          } catch (e) {
            return false;
          }
        },
      }, { scenario: phase });
    }
  });
}

function testGetStockDataSpike() {
  group('GetStockData Spike Test', () => {
    const phase = getCurrentPhase();
    
    // During spikes, prefer shorter periods to reduce load
    let period;
    if (phase.startsWith('spike_')) {
      period = PERIODS[Math.floor(Math.random() * 3)]; // 1w, 1m, 3m only
    } else {
      period = PERIODS[Math.floor(Math.random() * PERIODS.length)];
    }
    
    const stockCode = STOCK_CODES[Math.floor(Math.random() * 15)]; // Popular stocks
    
    const payload = {
      productCode: stockCode,
      period: period,
    };
    
    const response = makeSpikeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetStockData',
      payload,
      stockDataSpike
    );
    
    if (response.status === 200) {
      check(response, {
        'GetStockData spike: has data points': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body && body.points !== undefined;
          } catch (e) {
            return false;
          }
        },
      }, { scenario: phase });
    }
  });
}

function testGetStockDetailsSpike() {
  group('GetStockDetails Spike Test', () => {
    const stockCode = STOCK_CODES[Math.floor(Math.random() * STOCK_CODES.length)];
    const phase = getCurrentPhase();
    
    const payload = {
      productCode: stockCode,
    };
    
    const response = makeSpikeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetStockDetails',
      payload,
      new Trend('get_stock_details_spike_duration')
    );
    
    if (response.status === 200) {
      check(response, {
        'GetStockDetails spike: valid response': (r) => r.body && r.body.length > 0,
      }, { scenario: phase });
    }
  });
}

function testGetIndustryTreeMapSpike() {
  group('GetIndustryTreeMap Spike Test', () => {
    const phase = getCurrentPhase();
    
    // During spikes, use smaller limits
    let limit;
    if (phase.startsWith('spike_')) {
      limit = LIMITS[Math.floor(Math.random() * 2)]; // 5 or 10 only
    } else {
      limit = LIMITS[Math.floor(Math.random() * LIMITS.length)];
    }
    
    const payload = {
      period: PERIODS[Math.floor(Math.random() * 3)], // Shorter periods during spikes
      limit: limit,
      viewMode: VIEW_MODES[Math.floor(Math.random() * VIEW_MODES.length)],
    };
    
    const response = makeSpikeRequest(
      '/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap',
      payload,
      treeMapSpike
    );
    
    if (response.status === 200) {
      check(response, {
        'GetIndustryTreeMap spike: has industry data': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body !== null;
          } catch (e) {
            return false;
          }
        },
      }, { scenario: phase });
    }
  });
}

// Spike-specific test scenarios
export function testRapidFireRequests() {
  group('Rapid Fire Test', () => {
    // Simulate user rapidly clicking/refreshing
    for (let i = 0; i < 5; i++) {
      testGetTopShortsSpike();
      sleep(0.1); // Very short delay
    }
  });
}

export function testCacheInvalidationSpike() {
  group('Cache Invalidation Spike', () => {
    // Test different parameters to potentially invalidate cache
    const periods = ['1w', '1m', '3m'];
    const limits = [5, 10, 25];
    
    for (let period of periods) {
      for (let limit of limits) {
        const payload = { period, limit, offset: 0 };
        makeSpikeRequest(
          '/shorts.v1alpha1.ShortedStocksService/GetTopShorts',
          payload,
          topShortsSpike
        );
        sleep(0.05);
      }
    }
  });
}

// Enhanced summary with spike analysis
export function handleSummary(data) {
  const summary = {
    "spike-test-results.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    "spike-test-summary.json": JSON.stringify(data, null, 2),
  };
  
  // Spike-specific analysis
  const spikeAnalysis = {
    timestamp: new Date().toISOString(),
    test_type: 'spike_test',
    test_phases: {
      baseline_users: 50,
      spike_1_users: 200,
      spike_2_users: 400,
      spike_3_users: 800,
    },
    performance_analysis: {
      baseline_p95: data.metrics.pre_spike_performance ? data.metrics.pre_spike_performance.values['p(95)'] : null,
      peak_spike_p95: data.metrics.peak_spike_performance ? data.metrics.peak_spike_performance.values['p(95)'] : null,
      recovery_p95: data.metrics.post_spike_performance ? data.metrics.post_spike_performance.values['p(95)'] : null,
      degradation_factor: null, // Calculate this from the above values
    },
    resilience_metrics: {
      total_spike_requests: data.metrics.spike_requests_total ? data.metrics.spike_requests_total.values.count : 0,
      recovery_requests: data.metrics.recovery_requests_total ? data.metrics.recovery_requests_total.values.count : 0,
      overall_error_rate: data.metrics.errors ? data.metrics.errors.values.rate : 0,
      spike_recovery_time_avg: data.metrics.spike_recovery_time ? data.metrics.spike_recovery_time.values.avg : 0,
    },
    recommendations: [
      "Monitor error rates during each spike phase",
      "Check if system recovered to baseline performance after spikes",
      "Analyze cache effectiveness during traffic spikes",
      "Review database connection pool behavior under sudden load",
      "Consider implementing rate limiting if error rates are high"
    ]
  };
  
  // Calculate degradation factor
  if (spikeAnalysis.performance_analysis.baseline_p95 && spikeAnalysis.performance_analysis.peak_spike_p95) {
    spikeAnalysis.performance_analysis.degradation_factor = 
      spikeAnalysis.performance_analysis.peak_spike_p95 / spikeAnalysis.performance_analysis.baseline_p95;
  }
  
  summary["spike-test-analysis.json"] = JSON.stringify(spikeAnalysis, null, 2);
  
  return summary;
}

// Setup and teardown
export function setup() {
  console.log('Setting up SPIKE test...');
  console.log(`Base URL: ${BASE_URL}`);
  console.log('Test phases:');
  console.log('  - Baseline: 50 users');
  console.log('  - Spike 1: 200 users (moderate)');
  console.log('  - Spike 2: 400 users (high)');
  console.log('  - Spike 3: 800 users (extreme)');
  console.log(`Total test duration: ~30 minutes`);
  
  // Comprehensive warmup
  const warmupRequests = [
    { endpoint: '/shorts.v1alpha1.ShortedStocksService/GetTopShorts', payload: { period: '1m', limit: 10 } },
    { endpoint: '/shorts.v1alpha1.ShortedStocksService/GetStock', payload: { productCode: 'CBA' } },
    { endpoint: '/shorts.v1alpha1.ShortedStocksService/GetStockData', payload: { productCode: 'BHP', period: '1m' } },
    { endpoint: '/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap', payload: { period: '1m', limit: 5, viewMode: 'CURRENT_CHANGE' } },
  ];
  
  console.log('Running warmup requests...');
  for (let req of warmupRequests) {
    const response = http.post(
      `${BASE_URL}${req.endpoint}`,
      JSON.stringify(req.payload),
      { headers: { 'Content-Type': CONTENT_TYPE } }
    );
    console.log(`Warmup ${req.endpoint.split('/').pop()}: ${response.status} (${response.timings.duration}ms)`);
  }
  
  return { 
    baseUrl: BASE_URL,
    startTime: Date.now()
  };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log('Spike test completed.');
  console.log(`Total duration: ${Math.round(duration)} seconds`);
  console.log(`Base URL: ${data.baseUrl}`);
  console.log('Check spike-test-results.html and spike-test-analysis.json for detailed analysis.');
  console.log('Key metrics to review:');
  console.log('  - Performance degradation during spikes');
  console.log('  - System recovery after spikes');
  console.log('  - Error patterns during traffic bursts');
  console.log('  - Cache effectiveness under varying load');
}