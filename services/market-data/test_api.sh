#!/bin/bash

echo "Testing Market Data API"
echo "====================="

# Start server in background
echo "Starting server..."
go run simple_server.go &
SERVER_PID=$!

# Wait for server to start
sleep 3

echo -e "\n1. Testing single stock (XRO):"
curl -X POST -H "Content-Type: application/json" \
  -d '{"stock_codes":["XRO"]}' \
  http://localhost:8090/api/stocks/multiple 2>/dev/null | jq .

echo -e "\n2. Testing multiple stocks:"
curl -X POST -H "Content-Type: application/json" \
  -d '{"stock_codes":["CBA","BHP","CSL"]}' \
  http://localhost:8090/api/stocks/multiple 2>/dev/null | jq .

echo -e "\n3. Testing health endpoint:"
curl http://localhost:8090/health 2>/dev/null | jq .

# Kill server
echo -e "\nStopping server..."
kill $SERVER_PID 2>/dev/null

echo "Test complete"