#!/bin/bash

# Integration Test Infrastructure Validation Script
# This script validates that the complete test infrastructure is working properly

set -e

echo "🧪 Validating Integration Test Infrastructure"
echo "=============================================="

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_status() {
    local status=$1
    local message=$2
    if [ "$status" = "success" ]; then
        echo -e "${GREEN}✅ $message${NC}"
    elif [ "$status" = "warning" ]; then
        echo -e "${YELLOW}⚠️  $message${NC}"
    else
        echo -e "${RED}❌ $message${NC}"
    fi
}

# Check prerequisites
echo "📋 Checking Prerequisites..."

# Check Docker
if command -v docker &> /dev/null; then
    if docker info &> /dev/null; then
        print_status "success" "Docker is installed and running"
    else
        print_status "error" "Docker is installed but not running"
        exit 1
    fi
else
    print_status "error" "Docker is not installed"
    exit 1
fi

# Check Go
if command -v go &> /dev/null; then
    GO_VERSION=$(go version | grep -o 'go[0-9]\+\.[0-9]\+')
    print_status "success" "Go is installed ($GO_VERSION)"
else
    print_status "error" "Go is not installed"
    exit 1
fi

# Check Make
if command -v make &> /dev/null; then
    print_status "success" "Make is available"
else
    print_status "warning" "Make is not installed (some commands won't work)"
fi

echo ""
echo "🔍 Validating Go Module Dependencies..."

# Check if go.mod is present and has testcontainers
if grep -q "testcontainers-go" go.mod; then
    print_status "success" "testcontainers-go dependency is present"
else
    print_status "error" "testcontainers-go dependency is missing"
    echo "Run: go mod tidy"
    exit 1
fi

echo ""
echo "📁 Validating Test Infrastructure Files..."

# Check test directory structure
required_files=(
    "test/README.md"
    "test/integration/setup.go" 
    "test/integration/shorts_test.go"
    "test/fixtures/test_data.sql"
    "docker-compose.test.yml"
    "Dockerfile.test"
)

for file in "${required_files[@]}"; do
    if [ -f "$file" ]; then
        print_status "success" "Found: $file"
    else
        print_status "error" "Missing: $file"
        exit 1
    fi
done

echo ""
echo "🧪 Running Test Infrastructure Validation..."

# Test 1: Basic database setup
echo "1. Testing PostgreSQL container setup..."
if go test ./test/integration/... -v -timeout=3m -run TestDatabaseSetup > /tmp/test_db_setup.log 2>&1; then
    print_status "success" "PostgreSQL container setup works"
else
    print_status "error" "PostgreSQL container setup failed"
    echo "Check /tmp/test_db_setup.log for details"
    exit 1
fi

# Test 2: Test data loading
echo "2. Testing test data loading..."
if go test ./test/integration/... -v -timeout=3m -run TestDatabaseOperations > /tmp/test_db_ops.log 2>&1; then
    print_status "success" "Test data loading works"
else
    print_status "error" "Test data loading failed"
    echo "Check /tmp/test_db_ops.log for details"
    exit 1
fi

# Test 3: Data consistency
echo "3. Testing data consistency..."
if go test ./test/integration/... -v -timeout=3m -run TestDataConsistency > /tmp/test_consistency.log 2>&1; then
    print_status "success" "Data consistency validation works"
else
    print_status "error" "Data consistency validation failed"
    echo "Check /tmp/test_consistency.log for details"
    exit 1
fi

# Test 4: Cleanup utilities
echo "4. Testing cleanup utilities..."
if go test ./test/integration/... -v -timeout=3m -run TestCleanup > /tmp/test_cleanup.log 2>&1; then
    print_status "success" "Cleanup utilities work"
else
    print_status "error" "Cleanup utilities failed"
    echo "Check /tmp/test_cleanup.log for details"
    exit 1
fi

echo ""
echo "🐳 Validating Docker Test Environment..."

# Test docker-compose test file
if command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE_CMD="docker-compose"
elif docker compose version &> /dev/null; then
    DOCKER_COMPOSE_CMD="docker compose"
else
    print_status "error" "Neither docker-compose nor docker compose is available"
    exit 1
fi

if $DOCKER_COMPOSE_CMD -f docker-compose.test.yml config > /dev/null 2>&1; then
    print_status "success" "docker-compose.test.yml is valid"
else
    print_status "error" "docker-compose.test.yml has syntax errors"
    exit 1
fi

echo ""
echo "📊 Generating Test Summary..."

# Count test files and test functions
test_files=$(find test -name "*_test.go" | wc -l | tr -d ' ')
test_functions=$(grep -r "^func Test" test/ | wc -l | tr -d ' ')

echo "Test Infrastructure Summary:"
echo "- Test files: $test_files"
echo "- Test functions: $test_functions"
echo "- Sample data records: $(wc -l < test/fixtures/test_data.sql | tr -d ' ') lines in test_data.sql"
echo "- Makefile test targets: $(grep -c "^test" Makefile) targets"

echo ""
print_status "success" "🎉 Integration Test Infrastructure Validation Complete!"

echo ""
echo "📚 Quick Start Commands:"
echo "  make test.integration.local    # Run testcontainer tests"
echo "  make test-stack-up            # Start test environment"  
echo "  make test.integration.docker  # Run Docker-based tests"
echo "  make test-e2e                 # Full end-to-end test"
echo "  make test-clean               # Clean up test artifacts"

echo ""
echo "📖 For detailed documentation, see: test/README.md"