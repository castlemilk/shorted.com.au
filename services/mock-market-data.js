#!/usr/bin/env node

// Simple mock market data service for testing
const http = require('http');
const url = require('url');

const port = 8090;

// Mock stock data
const mockStockData = {
  'CBA': { price: 97.50, change: 2.00, changePercent: 2.09, previousClose: 95.50, volume: 1234567 },
  'BHP': { price: 44.30, change: 2.00, changePercent: 4.73, previousClose: 42.30, volume: 2345678 },
  'CSL': { price: 285.00, change: 5.00, changePercent: 1.79, previousClose: 280.00, volume: 345678 },
  'WBC': { price: 24.10, change: 2.00, changePercent: 9.05, previousClose: 22.10, volume: 1456789 },
  'ANZ': { price: 28.50, change: -0.50, changePercent: -1.72, previousClose: 29.00, volume: 987654 },
  'NAB': { price: 38.20, change: 1.20, changePercent: 3.24, previousClose: 37.00, volume: 654321 },
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Health check endpoint
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', service: 'mock-market-data' }));
    return;
  }
  
  // Multiple stock prices endpoint (for portfolio and watchlist)
  if (pathname === '/api/stocks/quotes' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const { stockCodes } = JSON.parse(body);
        const result = [];
        
        stockCodes.forEach(code => {
          const stock = mockStockData[code.toUpperCase()];
          if (stock) {
            result.push({
              symbol: code,
              price: stock.price,
              change: stock.change,
              changePercent: stock.changePercent,
              previousClose: stock.previousClose,
              volume: stock.volume,
              high: stock.price + Math.random() * 2,
              low: stock.price - Math.random() * 2,
              open: stock.previousClose + Math.random() * (stock.change * 2)
            });
          }
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }
  
  // Single stock endpoint
  if (pathname.startsWith('/api/stocks/') && req.method === 'GET') {
    const stockCode = pathname.split('/')[3]?.toUpperCase();
    const stock = mockStockData[stockCode];
    
    if (stock) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: {
          symbol: stockCode,
          ...stock,
          high: stock.price + Math.random() * 2,
          low: stock.price - Math.random() * 2,
          open: stock.previousClose + Math.random() * (stock.change * 2)
        }
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Stock not found' }));
    }
    return;
  }
  
  // Historical data endpoint
  if (pathname === '/api/stocks/historical' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const { stockCode, period } = JSON.parse(body);
        const stock = mockStockData[stockCode.toUpperCase()];
        
        if (!stock) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Stock not found' }));
          return;
        }
        
        // Generate mock historical data
        const days = period === '1w' ? 7 : period === '1m' ? 30 : period === '3m' ? 90 : 30;
        const data = [];
        let currentPrice = stock.previousClose;
        
        for (let i = days; i >= 0; i--) {
          const date = new Date();
          date.setDate(date.getDate() - i);
          
          const change = (Math.random() - 0.5) * 4; // Random change between -2 and +2
          currentPrice = Math.max(currentPrice + change, 1); // Ensure price doesn't go negative
          
          data.push({
            date: date.toISOString().split('T')[0],
            open: currentPrice + (Math.random() - 0.5) * 2,
            high: currentPrice + Math.random() * 3,
            low: currentPrice - Math.random() * 3,
            close: currentPrice,
            volume: Math.floor(Math.random() * 1000000) + 100000,
            adjustedClose: currentPrice
          });
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }
  
  // Default 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(port, () => {
  console.log(`🚀 Mock Market Data API running on port ${port}`);
  console.log(`📊 Health check: http://localhost:${port}/health`);
  console.log(`📈 Available stocks: ${Object.keys(mockStockData).join(', ')}`);
});