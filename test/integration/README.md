# Full-Stack Integration Testing

This directory contains integration tests that validate the entire application stack working together.

## Test Categories

### 1. Health Check Tests
- Basic connectivity tests
- Service startup validation
- Database connectivity

### 2. API Integration Tests
- Full request/response cycle testing
- Data pipeline validation
- Authentication flow testing

### 3. End-to-End User Flows
- Complete user journeys
- Cross-service interaction testing
- Data consistency validation

## Running Tests

```bash
# Start test environment
make test-stack-up

# Run integration tests
make test-integration

# Clean up test environment  
make test-stack-down
```

## Test Environment

Integration tests use:
- Docker Compose for service orchestration
- Test database with isolated data
- Mock external services where needed
- Real service instances for internal APIs

## Prerequisites

- Docker and Docker Compose
- Go 1.23+
- Node.js 18+
- PostgreSQL test database