# Documentation

## Features

| Document | Description |
| --- | --- |
| [Strategies](feature/strategies/README.md) | The stock picker, signals, backtests, saved strategies: pieces, data, jobs, landmines |
| [Stock page](feature/stock-page/README.md) | One route per tab: chrome, charts, the readout, indicators, landmines |
| [Ownership](feature/ownership/README.md) | Who holds ASX stocks: the explorer, the desk, the workspace, landmines |
| [Housing](feature/housing/README.md) | Tracker, suburb explorer, listings crawl, price-drops |
| [Economy](economy-architecture.md) | Map explorer, state pages, the economic series platform |
| [Politicians](feature/politicians/README.md) | The register of interests |
| [MCP server](mcp-server.md) | OAuth 2.1, the public tools, the rules and landmines; [admin server](mcp-admin.md) |
| [Share & embed](share-embed.md) | The chart share page, the card, landscape mode, indicators |
| [Discord bot](discord-bot.md) | Slash commands, live charts, the Activity |
| [Alerts](alerts-runbook.md) | Short-interest alerts: the job and its runbook |
| [Rate limiting](rate-limiting.md) | Operator reference; [design record](rate-limiting-design.md) |
| [React 19 / Next 15](web-react19-next15.md) | The web app upgrade: what changed and what it pins |

## Deployment

| Document                                          | Description                                |
| ------------------------------------------------- | ------------------------------------------ |
| [Production Deployment](PRODUCTION_DEPLOYMENT.md) | Complete guide for deploying to production |
| [Preview Deployments](PREVIEW_DEPLOYMENTS.md)     | How PR preview environments work           |

## Infrastructure

| Document                                             | Description                          |
| ---------------------------------------------------- | ------------------------------------ |
| [Terraform Guide](../terraform/README.md)            | Infrastructure as code documentation |
| [Terraform Quick Start](../terraform/QUICK_START.md) | 5-minute Terraform setup             |
| [Architecture](../terraform/ARCHITECTURE.md)         | System architecture overview         |

## Services

| Document                                                                           | Description                 |
| ---------------------------------------------------------------------------------- | --------------------------- |
| [Jobs monolith](../services/jobs/README.md)                                        | Scheduled jobs, incl. ASIC data sync |
| [Enrichment Processor](../services/enrichment-processor/README.md)                 | Company metadata enrichment |
| [Market Data](../services/market-data/README.md)                                   | Historical stock price data |
| [Stock Price Ingestion](../services/stock-price-ingestion/README.md)               | Stock price data ingestion  |
| [Market Data Sync](../services/market-data-sync/cmd/historical-backfill/README.md) | Historical data backfill    |

## Frontend

| Document                                  | Description                     |
| ----------------------------------------- | ------------------------------- |
| [Testing Guide](../web/TESTING_GUIDE.md)  | Frontend testing documentation  |
| [Vercel Setup](../web/VERCEL_SETUP.md)    | Vercel deployment configuration |
| [LLM SEO](../web/LLM_SEO_OPTIMIZATION.md) | LLM/AI search optimization      |

## Analysis & Data

| Document                                           | Description                   |
| -------------------------------------------------- | ----------------------------- |
| [Analysis Setup](../analysis/README.md)            | Data analysis environment     |
| [Analysis Quick Start](../analysis/QUICK_START.md) | Getting started with analysis |

## API

| Document                                             | Description                 |
| ---------------------------------------------------- | --------------------------- |
| [API Reference](../web/public/docs/api-reference.md) | Public API documentation    |
| [LLM Context](../web/public/docs/llm-context.md)     | LLM-optimized documentation |

## Testing

| Document                                                       | Description               |
| -------------------------------------------------------------- | ------------------------- |
| [Integration Tests](../test/integration/README.md)             | Integration testing guide |
| [Performance Tests](../test/PERFORMANCE_TESTING.md)            | Performance testing guide |
| [Services Integration](../services/test/integration/README.md) | Backend integration tests |
