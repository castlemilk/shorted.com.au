# Shorted.com.au

A comprehensive platform for tracking short selling positions in the Australian stock market.

## Services Overview

The application consists of three main services:

| Service             | Port | Purpose                     | Command                |
| ------------------- | ---- | --------------------------- | ---------------------- |
| Frontend            | 3020 | Next.js web application     | `make dev-frontend`    |
| Shorts Service      | 9091 | Short position data API     | `make dev-backend`     |
| Market Data Service | 8090 | Historical stock prices API | `make dev-market-data` |
| Database            | 5438 | PostgreSQL database         | `make dev-db`          |

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Go 1.21+
- Docker and Docker Compose

### Development Setup

1. **Install dependencies:**

```bash
make install
```

2. **Start development environment:**

```bash
make dev
```

This will start:

- PostgreSQL database at localhost:5432
- Frontend at http://localhost:3020
- Backend at http://localhost:9091

Press `Ctrl+C` to stop all services.

### Individual Services

You can also start services individually:

```bash
make dev-db         # Start database only
make dev-frontend   # Start frontend only (requires database)
make dev-backend    # Start backend only (requires database)
make dev-stop       # Stop all services
```

### Database Setup

The PostgreSQL database is automatically initialized with:

- Required table schemas (`shorts`, `company-metadata`, `subscriptions`)
- Performance indexes
- Sample data for development

Database credentials:

- Host: localhost:5438
- Database: shorts
- Username: admin
- Password: password

## Testing

```bash
make test              # Run all tests
make test-frontend     # Frontend tests only
make test-backend      # Backend tests only
make test-integration  # Full-stack integration tests
```

## Architecture

- **Frontend**: Next.js with TypeScript, TailwindCSS
- **Backend**: Go with gRPC/Connect-RPC
- **Database**: PostgreSQL
- **Data Source**: ASIC daily CSV files

## Contributing

1. Run tests: `make test`
2. Check formatting: `make lint`
3. Pre-commit checks: `make pre-commit`

## Overview

Basic dashboarding platform for viewing short positions on ASX.

### Other Commands

```bash
# Run all tests
make test

# Run frontend only
make dev-frontend

# Run backend only
make dev-backend

# Build the application
make build

# Run linting
make lint

# Format code
make format
```

### MVP

[x] sync data to local machine

[x] basic notebook for exploring data

[x] normalise appropriately and index into blob store (S3, cloud storage)

[x] investigate options for serving time series data

[x] sync data from s3 into hot store

[x] backend to serve hot store data

[x] api for top 10 shorts

[x] investigate process for fetching ABN metadata ( at least top ten)

[x] frontend to render top 10 shorts

[x] CI/CD pipeline for build and deployment to cloud run and whatever FE hosting (next?)

[x] db hosting (looking at superbase LGTM)

# week 1

[x] cron-job to pull latest shorts

[x] chart styling x,y axis

[x] more company info/metadata rendered

[x] set max to do the longest window of timeseries data possible

# week 2

[ ] company image on dark mode

[x] query maths for top x tuned - show more sensible values for larger windows

[x] default logo when no image found

[ ] show company directors

1.  add company leaders to metadata API
2.  render in about section

# week 3

[ ] company summary/description tuning

[ ] show company references

[ ] loading & data fetch optmisations/caching

[ ] loading animations & lazy loading / suspense for concurrent fetches

# week 4

[ ] security (anon auth/ratelimiting)

- https://cloud.google.com/iam/docs/create-short-lived-credentials-direct
- https://developers.google.com/identity/protocols/oauth2/service-account#jwt-auth
- https://cloud.google.com/run/docs/authenticating/service-to-service
- https://cloud.google.com/run/docs/authenticating/service-to-service#use_a_downloaded_service_account_key_from_outside
- https://github.com/nextauthjs/next-auth/issues/6649

[x] fix top navbar on wide screen to float max right/left

[ ] update period title value dynamically based off selected value

[ ] time series rollup algoritm

# week 5

[ ] gamify sentiment view somehow? poo vs rocket, gague view etc

[ ] add additional items here as working...

# new items

[x] fix chart resize/shrinking on topShort view - seems to be an issue with parent div? https://github.com/airbnb/visx/issues/1014

[ ] fix media upload in payloadCMS when fix released in https://github.com/payloadcms/payload/issues/4422 or https://github.com/payloadcms/payload/issues/4421#issuecomment-1864867979 or https://github.com/payloadcms/payload/issues/5159

[ ] company image tuning - will push out to manual data entry job with payloadCMS fix above

[ ] industry/sector treemap - https://airbnb.io/visx/treemap

[ ] more mobile friendly top short view (show min/max next to current?)

## data entry pipeline

[ ] deploy playloadCMS

[ ] add valid user/login

[ ] test integration with supabase as backend

[ ] test integration with GCP as backend store

[ ] validate data entry flow ASX Code --> edit image --> add links (socials, investory page) --> get ChatGPT description and add to details

[ ] collect company socials (twitter, instagram, linkedin etc.)
[ ] add social section and also link to google finance/yahoo finance

### Milestone 1

[x] company metadata ingestion and real-time sentiment analysis API + view

[x] company index

[x] scraping service

[ ] sentiment engine

[ ] company metadata collector (financial reports, company announcements, )

[ ] social engagement via twitter for new short positions

[ ] automated alerts for short positions?

[ ] auth/login

[ ] commentary and/or forum support

[ ] stock data ingestion? yahoo finance? historical data?

[ ] stocks enriched with additional tags for rendering

### Milsstone 2

[ ] notification subscriptions

[ ] API as a service

[ ] news aggregation view

[ ] more advanced dynamic content collection per-stock (likely focus on top-x) gathering things like financial reports etc

[ ] further enhanced content management solution (payloadCMS) deploy & monitise somehow?

[ ] shorted bot - RAG + LLM wrapper around stocks

[ ] elastic search for stocks

[ ] user customised dashboard (my stocks, favourites etc.)

[ ] enhanced comments/forum solution

## Tech Stack

This is a T3 Stack project bootstrapped with create-t3-app.

If you are not familiar with the different technologies used in this project, please refer to the respective docs. If you still are in the wind, please join our [Discord](https://t3.gg/discord) and ask for help.

- [Next.js](https://nextjs.org)
- [NextAuth.js](https://next-auth.js.org)
- [Prisma](https://prisma.io)
- [Tailwind CSS](https://tailwindcss.com)
- [tRPC](https://trpc.io)

## Learn More

To learn more about the [T3 Stack](https://create.t3.gg/), take a look at the following resources:

- [Documentation](https://create.t3.gg/)
- [Learn the T3 Stack](https://create.t3.gg/en/faq#what-learning-resources-are-currently-available) — Check out these awesome tutorials

You can check out the [create-t3-app GitHub repository](https://github.com/t3-oss/create-t3-app) — your feedback and contributions are welcome!

### References

[1] nextjs + connect-query + connect-web - https://github.com/connectrpc/examples-es/tree/main/nextjs
[1.1] https://connectrpc.com/docs/web/ssr

# Force CI run
