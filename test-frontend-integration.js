const fetch = require('node-fetch');

async function testFrontendIntegration() {
  try {
    console.log('Testing frontend market data integration...');
    
    // Test the frontend stock data service through the API
    const response = await fetch('http://localhost:3020/api/stocks/CBA', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log('Response status:', response.status);
    if (response.status !== 200) {
      console.log('Response headers:', Object.fromEntries(response.headers));
      const errorText = await response.text();
      console.log('Error response:', errorText);
    } else {
      const data = await response.json();
      console.log('Success! Stock data received:', JSON.stringify(data, null, 2));
    }
    
  } catch (error) {
    console.error('Frontend integration test failed:', error.message);
  }
}

testFrontendIntegration();