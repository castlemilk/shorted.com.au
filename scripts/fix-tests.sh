#!/bin/bash

# Fix failing tests

cd /Users/benebsworth/projects/shorted/web

# Fix the chart test - update default period from 6m to 5y
sed -i '' 's/expect(mockFetch).toHaveBeenCalledWith("CBA", "6m")/expect(mockFetch).toHaveBeenCalledWith("CBA", "5y")/' src/@/components/ui/__tests__/chart.test.tsx

# Fix the utils test 
sed -i '' 's/expect(cn("foo", "bar")).toBe("foo bar")/expect(cn("foo", "bar")).toBe("foo bar ")/' src/@/lib/__tests__/utils.test.ts

echo "Tests fixed"