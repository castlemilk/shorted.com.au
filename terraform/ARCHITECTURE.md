# Terraform Infrastructure Architecture

## Overview

All services are deployed to Google Cloud Platform using Terraform for infrastructure as code.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    Google Cloud Platform                         │
│                   (shorted-dev-aba5688f)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │              Artifact Registry                          │    │
│  │  australia-southeast2-docker.pkg.dev/shorted/          │    │
│  │  - stock-price-ingestion:latest                        │    │
│  │  - short-data-sync:latest                              │    │
│  │  - shorts:latest                                       │    │
│  │  - cms:latest                                          │    │
│  └────────────────────────────────────────────────────────┘    │
│                           │                                      │
│                           │ pulls images                         │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │               Cloud Run Services & Jobs                   │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────┐         │  │
│  │  │  Stock Price Ingestion Service               │         │  │
│  │  │  - Type: Cloud Run Service                   │         │  │
│  │  │  - Port: 8080                                │         │  │
│  │  │  - Scaling: 0-10 instances                   │         │  │
│  │  │  - Endpoints: /sync-all, /sync, /health      │         │  │
│  │  └─────────────────────────────────────────────┘         │  │
│  │           │                                               │  │
│  │           │ triggers                                      │  │
│  │           ▼                                               │  │
│  │  ┌─────────────────────────────────────────────┐         │  │
│  │  │  Cloud Scheduler Jobs                        │         │  │
│  │  │  ├─ Daily Sync (0 8 * * 1-5)                │         │  │
│  │  │  └─ Weekly Backfill (0 10 * * 0)            │         │  │
│  │  └─────────────────────────────────────────────┘         │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────┐         │  │
│  │  │  Short Data Sync Job                         │         │  │
│  │  │  - Type: Cloud Run Job                       │         │  │
│  │  │  - Execution: On-demand + Scheduled          │         │  │
│  │  │  - Resources: 2 CPU, 4Gi RAM                 │         │  │
│  │  │  - Timeout: 1 hour                           │         │  │
│  │  └─────────────────────────────────────────────┘         │  │
│  │           │                                               │  │
│  │           │ triggered by                                  │  │
│  │           ▼                                               │  │
│  │  ┌─────────────────────────────────────────────┐         │  │
│  │  │  Cloud Scheduler Job                         │         │  │
│  │  │  └─ Daily Sync (0 10 * * *)                 │         │  │
│  │  └─────────────────────────────────────────────┘         │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────┐         │  │
│  │  │  Shorts API Service                          │         │  │
│  │  │  - Type: Cloud Run Service                   │         │  │
│  │  │  - Port: 8080                                │         │  │
│  │  │  - Scaling: 1-100 instances (always-on)      │         │  │
│  │  │  - Protocol: gRPC/Connect RPC                │         │  │
│  │  │  - Public: Yes                               │         │  │
│  │  └─────────────────────────────────────────────┘         │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────┐         │  │
│  │  │  CMS Service (Payload)                       │         │  │
│  │  │  - Type: Cloud Run Service                   │         │  │
│  │  │  - Port: 3000                                │         │  │
│  │  │  - Scaling: 0-10 instances                   │         │  │
│  │  │  - Endpoints: /admin, /api/*                 │         │  │
│  │  └─────────────────────────────────────────────┘         │  │
│  │                                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │              Cloud Storage (GCS)                        │    │
│  │  shorted-dev-aba5688f-short-selling-data               │    │
│  │  - Stores ASIC short selling CSV files                 │    │
│  │  - Versioning enabled                                  │    │
│  │  - 1 year retention                                    │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │              Secret Manager                             │    │
│  │  - ALPHA_VANTAGE_API_KEY                               │    │
│  │  - DATABASE_URL                                        │    │
│  │  - APP_STORE_POSTGRES_PASSWORD                         │    │
│  │  - MONGODB_URI (optional)                              │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │              Service Accounts                           │    │
│  │  - stock-price-ingestion@...                           │    │
│  │  - short-data-sync@...                                 │    │
│  │  - shorts@...                                          │    │
│  │  - cms@...                                             │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ connects to
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  External Dependencies                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────┐            │
│  │   Supabase          │  │   ASIC API          │            │
│  │   PostgreSQL        │  │   (Short Data)      │            │
│  │   (Database)        │  │                     │            │
│  └──────────────────────┘  └──────────────────────┘            │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────┐            │
│  │  Alpha Vantage API  │  │  Yahoo Finance API  │            │
│  │  (Primary)          │  │  (Fallback)         │            │
│  └──────────────────────┘  └──────────────────────┘            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Stock Price Ingestion Flow

```
Cloud Scheduler (Daily 6 PM AEST)
    │
    ▼
Stock Price Ingestion Service
    │
    ├─> Alpha Vantage API (Primary)
    │       │
    │       ├─> Success ──> Store in PostgreSQL
    │       │
    │       └─> Failure ──> Yahoo Finance API (Fallback)
    │                           │
    │                           └─> Store in PostgreSQL
    │
    └─> Weekly Backfill (Sundays 8 PM AEST)
            └─> 7-day historical data sync
```

### Short Data Sync Flow

```
Cloud Scheduler (Daily 8 PM AEST)
    │
    ▼
Short Data Sync Job Triggered
    │
    ├─> Fetch available files list from ASIC API
    │
    ├─> Check index in GCS (what's already downloaded)
    │
    ├─> Download new CSV files to GCS
    │
    ├─> Process files with Dask (parallel)
    │
    ├─> Normalize data schema
    │
    ├─> Load into PostgreSQL (shorts table)
    │
    └─> Update index file in GCS
```

### Shorts API Flow

```
Client Request
    │
    ▼
Shorts API Service (gRPC/Connect RPC)
    │
    ├─> Query PostgreSQL (Supabase)
    │
    └─> Return response to client
```

## IAM & Security

### Service Account Permissions

| Service               | Service Account           | Permissions                                               |
| --------------------- | ------------------------- | --------------------------------------------------------- |
| stock-price-ingestion | stock-price-ingestion@... | Secret Manager (ALPHA_VANTAGE_API_KEY, DATABASE_URL)      |
| short-data-sync       | short-data-sync@...       | Secret Manager (DATABASE_URL), Storage Admin (GCS bucket) |
| shorts                | shorts@...                | Secret Manager (APP_STORE_POSTGRES_PASSWORD)              |
| cms                   | cms@...                   | Secret Manager (MONGODB_URI, optional)                    |

### Secret Access Pattern

```
Cloud Run Service
    │
    ├─> Mounts secret as environment variable
    │   (via Secret Manager API)
    │
    └─> Service Account has secretAccessor role
```

## Networking

### Ingress/Egress

- **Ingress**: All services accept HTTPS traffic (Cloud Run provides TLS)
- **Egress**: Services can make outbound calls to:
  - External APIs (Alpha Vantage, Yahoo Finance, ASIC)
  - Supabase PostgreSQL
  - GCS buckets
  - Secret Manager

### Public Access

- ✅ **Shorts API**: Public (allUsers can invoke)
- ✅ **CMS**: Public (allUsers can invoke)
- ✅ **Stock Price Ingestion**: Public (for scheduler + manual triggers)
- 🔒 **Short Data Sync**: Private (only scheduler can invoke)

## Scaling Configuration

| Service               | Min | Max | Scaling Trigger             |
| --------------------- | --- | --- | --------------------------- |
| stock-price-ingestion | 0   | 10  | HTTP requests               |
| short-data-sync       | -   | -   | Job execution only          |
| shorts                | 1   | 100 | HTTP requests (low latency) |
| cms                   | 0   | 10  | HTTP requests               |

## Cost Optimization

### Always-On Services

- **Shorts API**: Min 1 instance for low latency (justified by user experience)

### Scale-to-Zero Services

- **Stock Price Ingestion**: Scales to 0 when not in use
- **CMS**: Scales to 0 (admin tool, low usage)

### Batch Processing

- **Short Data Sync**: Cloud Run Job (pay per execution)

## Deployment Flow

```
Developer
    │
    ├─> Builds Docker image locally
    │   docker build -t service:tag .
    │
    ├─> Authenticates with Artifact Registry
    │   gcloud auth configure-docker
    │
    ├─> Pushes image
    │   docker push australia-southeast2-docker.pkg.dev/.../service:tag
    │
    └─> Applies Terraform
        terraform apply
            │
            ├─> Creates/Updates Cloud Run service with new image
            │
            ├─> Updates IAM bindings
            │
            ├─> Updates scheduler jobs
            │
            └─> Service becomes available at *.run.app URL
```

## Monitoring & Observability

### Logs

All services send logs to Cloud Logging:

```bash
# View logs by service type
gcloud logging read "resource.type=cloud_run_revision"
gcloud logging read "resource.type=cloud_run_job"
gcloud logging read "resource.type=cloud_scheduler_job"

# Filter by service name
gcloud logging read "resource.labels.service_name=shorts"
```

### Metrics

Cloud Run provides built-in metrics:

- Request count
- Request latency
- Instance count
- CPU/Memory utilization
- Error rates

Access via Cloud Console or Cloud Monitoring API.

### Health Checks

| Service               | Health Endpoint | Probe Config                |
| --------------------- | --------------- | --------------------------- |
| stock-price-ingestion | GET /health     | Startup: 10s, Liveness: 30s |
| shorts                | GET /health     | Startup: 5s, Liveness: 30s  |
| cms                   | GET /api/health | Startup: 10s, Liveness: 30s |

## Disaster Recovery

### State Management

- **Current**: Local Terraform state
- **Recommended**: Remote state in GCS with versioning

### Rollback Strategy

```bash
# Rollback to previous image
cd terraform/environments/dev
# Edit terraform.tfvars to use previous image tag
terraform apply

# Or revert git commit and reapply
git revert HEAD
terraform apply
```

### Data Backups

- **GCS Bucket**: Versioning enabled (can recover deleted files)
- **PostgreSQL**: Managed by Supabase (automated backups)
- **Terraform State**: Should be backed up (use GCS backend)

## Future Enhancements

### Short-term

- [ ] Remote state in GCS
- [ ] Staging environment
- [ ] Monitoring dashboards
- [ ] Alerting rules

### Long-term

- [ ] Multi-region deployment
- [ ] Production environment with separate project
- [ ] CI/CD integration (GitHub Actions)
- [ ] Infrastructure tests
- [ ] Cost optimization automation
- [ ] Service mesh for inter-service communication

## References

- [Terraform Google Provider](https://registry.terraform.io/providers/hashicorp/google/latest/docs)
- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [Cloud Scheduler Documentation](https://cloud.google.com/scheduler/docs)
- [Artifact Registry Documentation](https://cloud.google.com/artifact-registry/docs)
