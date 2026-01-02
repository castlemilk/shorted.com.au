# Deprecated Python Scripts

The daily sync logic in this directory has been migrated to the unified Go-based `market-data-sync` service.

### Replacement
- **Market Data Sync**: `services/market-data-sync/`
- **ASX Discovery**: `services/asx-discovery/`

These new services provide better observability (via checkpoint tracking in the Admin UI) and higher resiliency through Go's concurrency model and standard project patterns.
