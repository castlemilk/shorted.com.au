// Artillery processor for custom functions and utilities
const crypto = require('crypto');

// Stock codes for random selection
const stockCodes = [
  'CBA', 'BHP', 'ANZ', 'WBC', 'NAB', 'CSL', 'WOW', 'TLS', 'RIO', 'WES',
  'MQG', 'TCL', 'STO', 'QBE', 'WPL', 'ALL', 'JHX', 'COL', 'ILU', 'REA'
];

const periods = ['1w', '1m', '3m', '6m', '1y'];
const limits = [5, 10, 25, 50];
const viewModes = ['CURRENT_CHANGE', 'PERCENTAGE_CHANGE'];

// Endpoints for random selection
const endpoints = [
  {
    name: 'GetTopShorts',
    url: '/shorts.v1alpha1.ShortedStocksService/GetTopShorts',
    weight: 0.4,
    generatePayload: () => ({
      period: randomChoice(periods),
      limit: randomChoice(limits),
      offset: randomNumber(0, 20)
    })
  },
  {
    name: 'GetStock',
    url: '/shorts.v1alpha1.ShortedStocksService/GetStock',
    weight: 0.3,
    generatePayload: () => ({
      productCode: randomChoice(stockCodes)
    })
  },
  {
    name: 'GetStockData', 
    url: '/shorts.v1alpha1.ShortedStocksService/GetStockData',
    weight: 0.2,
    generatePayload: () => ({
      productCode: randomChoice(stockCodes),
      period: randomChoice(periods)
    })
  },
  {
    name: 'GetIndustryTreeMap',
    url: '/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap', 
    weight: 0.1,
    generatePayload: () => ({
      period: randomChoice(periods),
      limit: randomChoice(limits),
      viewMode: randomChoice(viewModes)
    })
  }
];

// Utility functions
function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function randomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function weightedRandomChoice(choices, weights) {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let random = Math.random() * totalWeight;
  
  for (let i = 0; i < choices.length; i++) {
    random -= weights[i];
    if (random <= 0) {
      return choices[i];
    }
  }
  return choices[choices.length - 1];
}

// Generate unique session ID for tracking
function generateSessionId() {
  return crypto.randomBytes(8).toString('hex');
}

// Performance tracking
let requestTimes = [];
let errorCount = 0;
let successCount = 0;

// Custom functions for Artillery scenarios
module.exports = {
  // Random endpoint call with weighted selection
  randomEndpointCall: function(context, events, done) {
    const weights = endpoints.map(e => e.weight);
    const selectedEndpoint = weightedRandomChoice(endpoints, weights);
    
    const payload = selectedEndpoint.generatePayload();
    
    // Set up the request in context
    context.vars.endpointUrl = selectedEndpoint.url;
    context.vars.requestPayload = payload;
    context.vars.endpointName = selectedEndpoint.name;
    
    // Add session tracking
    if (!context.vars.sessionId) {
      context.vars.sessionId = generateSessionId();
    }
    
    return done();
  },

  // Realistic user behavior simulation
  simulateRealisticUser: function(context, events, done) {
    const userType = Math.random();
    
    if (userType < 0.6) {
      // Casual user - quick browse
      context.vars.thinkTime = randomNumber(2, 5);
      context.vars.userType = 'casual';
    } else if (userType < 0.9) {
      // Regular user - moderate usage
      context.vars.thinkTime = randomNumber(1, 3);
      context.vars.userType = 'regular';
    } else {
      // Power user - intensive usage
      context.vars.thinkTime = randomNumber(0.5, 2);
      context.vars.userType = 'power';
    }
    
    return done();
  },

  // Generate realistic stock selection based on popularity
  selectPopularStock: function(context, events, done) {
    const popularStocks = ['CBA', 'BHP', 'ANZ', 'WBC', 'NAB'];
    const allStocks = stockCodes;
    
    // 70% chance to select popular stock, 30% for any stock
    const usePopular = Math.random() < 0.7;
    context.vars.selectedStock = usePopular ? 
      randomChoice(popularStocks) : 
      randomChoice(allStocks);
    
    return done();
  },

  // Generate time-based period selection (users prefer recent data)
  selectPeriod: function(context, events, done) {
    const periodWeights = {
      '1w': 0.1,
      '1m': 0.4,
      '3m': 0.3,
      '6m': 0.15,
      '1y': 0.05
    };
    
    const selectedPeriod = weightedRandomChoice(
      Object.keys(periodWeights),
      Object.values(periodWeights)
    );
    
    context.vars.selectedPeriod = selectedPeriod;
    return done();
  },

  // Error scenario generation
  generateErrorScenario: function(context, events, done) {
    const errorTypes = [
      'invalid_stock',
      'invalid_period', 
      'excessive_limit',
      'negative_offset'
    ];
    
    const errorType = randomChoice(errorTypes);
    
    switch (errorType) {
      case 'invalid_stock':
        context.vars.testStock = 'INVALID_' + Math.random().toString(36).substring(7);
        break;
      case 'invalid_period':
        context.vars.testPeriod = 'invalid_period';
        break;
      case 'excessive_limit':
        context.vars.testLimit = randomNumber(1000, 5000);
        break;
      case 'negative_offset':
        context.vars.testOffset = -randomNumber(1, 100);
        break;
    }
    
    context.vars.errorType = errorType;
    return done();
  },

  // Performance monitoring setup
  setupPerformanceMonitoring: function(context, events, done) {
    context.vars.startTime = Date.now();
    context.vars.testId = generateSessionId();
    
    // Track user journey
    if (!context.vars.userJourney) {
      context.vars.userJourney = [];
    }
    
    return done();
  },

  // Cache behavior simulation
  simulateCacheBehavior: function(context, events, done) {
    // Simulate cache hit scenarios with repeated requests
    const cacheScenarios = [
      'same_request_repeat',
      'similar_parameters',
      'popular_stock_repeat'
    ];
    
    const scenario = randomChoice(cacheScenarios);
    context.vars.cacheScenario = scenario;
    
    switch (scenario) {
      case 'same_request_repeat':
        // Use exactly same parameters for cache hit
        context.vars.cachePeriod = '1m';
        context.vars.cacheLimit = 10;
        context.vars.cacheOffset = 0;
        break;
      case 'similar_parameters':
        // Use similar but not identical parameters
        context.vars.cachePeriod = randomChoice(['1m', '1w']);
        context.vars.cacheLimit = randomChoice([5, 10]);
        context.vars.cacheOffset = randomChoice([0, 5]);
        break;
      case 'popular_stock_repeat':
        context.vars.cacheStock = randomChoice(['CBA', 'BHP', 'ANZ']);
        break;
    }
    
    return done();
  },

  // Database stress scenario
  generateDatabaseStress: function(context, events, done) {
    const stressTypes = [
      'large_dataset',
      'complex_query',
      'historical_data',
      'multiple_joins'
    ];
    
    const stressType = randomChoice(stressTypes);
    
    switch (stressType) {
      case 'large_dataset':
        context.vars.stressPeriod = randomChoice(['6m', '1y']);
        context.vars.stressLimit = randomChoice([50, 100]);
        break;
      case 'complex_query':
        context.vars.stressViewMode = 'PERCENTAGE_CHANGE';
        context.vars.stressPeriod = '6m';
        context.vars.stressLimit = 50;
        break;
      case 'historical_data':
        context.vars.stressStock = randomChoice(stockCodes);
        context.vars.stressPeriod = '1y';
        break;
    }
    
    context.vars.stressType = stressType;
    return done();
  },

  // Request tracking and metrics
  trackRequest: function(context, events, done) {
    const requestInfo = {
      timestamp: Date.now(),
      endpoint: context.vars.endpointName || 'unknown',
      sessionId: context.vars.sessionId,
      userType: context.vars.userType || 'unknown'
    };
    
    if (!context.vars.requestHistory) {
      context.vars.requestHistory = [];
    }
    context.vars.requestHistory.push(requestInfo);
    
    return done();
  },

  // Response validation
  validateResponse: function(context, events, done) {
    // This would be called in a custom expect function
    // For now, just track response time
    if (context.vars.startTime) {
      const responseTime = Date.now() - context.vars.startTime;
      requestTimes.push(responseTime);
      
      // Track success/error rates
      if (context.vars.lastStatusCode && context.vars.lastStatusCode >= 400) {
        errorCount++;
      } else {
        successCount++;
      }
    }
    
    return done();
  },

  // Generate realistic pagination
  generatePagination: function(context, events, done) {
    const pageSize = randomChoice([5, 10, 25]);
    const pageNumber = randomNumber(0, 10);
    
    context.vars.paginationLimit = pageSize;
    context.vars.paginationOffset = pageNumber * pageSize;
    
    return done();
  },

  // Memory intensive payload generation
  generateMemoryIntensivePayload: function(context, events, done) {
    context.vars.memoryTestPeriod = '1y'; // Long period for more data
    context.vars.memoryTestLimit = 100;   // Large limit
    context.vars.memoryTestOffset = 0;
    
    // Add extra metadata for tracking
    context.vars.testType = 'memory_intensive';
    context.vars.expectedDataSize = 'large';
    
    return done();
  },

  // Connection pool stress
  simulateConnectionPoolStress: function(context, events, done) {
    // Rapid fire requests to stress connection pool
    context.vars.rapidFireCount = randomNumber(3, 7);
    context.vars.rapidFireDelay = randomNumber(50, 200); // milliseconds
    
    return done();
  },

  // Generate summary statistics
  generateSummary: function(context, events, done) {
    if (requestTimes.length > 0) {
      const avgResponseTime = requestTimes.reduce((a, b) => a + b, 0) / requestTimes.length;
      const successRate = (successCount / (successCount + errorCount)) * 100;
      
      console.log(`Performance Summary:
        Total Requests: ${requestTimes.length}
        Average Response Time: ${Math.round(avgResponseTime)}ms
        Success Rate: ${successRate.toFixed(2)}%
        Error Count: ${errorCount}
      `);
    }
    
    return done();
  }
};