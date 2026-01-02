# Deprecated Python Scripts

The Python scripts in this directory have been replaced by the Go-based `market-data-sync` service located in `services/market-data-sync/`.

### Reason for Deprecation
- **Type Safety**: Go provides better compile-time checks.
- **Authoritative Stock List**: The new service uses the ASX Company Directory (via `asx-discovery` service) as the source of truth, solving the "chicken and egg" problem.
- **Consistency**: Aligning with the rest of the backend tech stack (Go).
- **Performance**: Improved concurrency and lower resource footprint.

### Replacement Service
- Source: `services/market-data-sync/`
- Infrastructure: Cloud Run Job (see `terraform/asx-discovery.tf`)
- Frequency: Daily (Monday-Friday 8PM AEST)

### Cleanup
The core Python scripts have been moved to the `deprecated/` directory for historical reference and will eventually be removed.
