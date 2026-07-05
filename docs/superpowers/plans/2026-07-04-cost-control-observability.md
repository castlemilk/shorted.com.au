# Cost Control Observability Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute AI/API cost drivers by feature and add guardrails that reduce chat-driven Gemini and database write spikes.

**Architecture:** Add bounded OpenTelemetry metrics around Gemini token usage, tool calls, and chat persistence. Cap chat prompt/history/output sizes in configuration, prune retained chat messages, and route chat tool calls through the Cloudflare edge cache in production.

**Tech Stack:** Go 1.26, Connect-RPC, Google Gemini Go SDK, OpenTelemetry, Terraform Cloud Run.

---

### Task 1: Chat Cost Helpers

**Files:**
- Create: `services/chat-service/cost_metrics.go`
- Test: `services/chat-service/cost_metrics_test.go`

- [x] Write failing tests for Gemini usage aggregation and billable prompt token derivation.
- [x] Implement the usage accumulator with nil-safe metadata handling.
- [x] Run `go test ./chat-service`.

### Task 2: Chat Runtime Limits

**Files:**
- Modify: `services/chat-service/config.go`
- Create: `services/chat-service/config_test.go`

- [x] Write failing tests for env-driven chat limits and defaults.
- [x] Parse `GEMINI_MAX_OUTPUT_TOKENS`, `CHAT_MAX_INPUT_CHARS`, `CHAT_HISTORY_LIMIT`, and `CHAT_MAX_MESSAGES_PER_CONVERSATION`.
- [x] Run `go test ./chat-service`.

### Task 3: Service Instrumentation And Guardrails

**Files:**
- Modify: `services/pkg/otel/metrics.go`
- Modify: `services/chat-service/main.go`
- Modify: `services/chat-service/llm_client.go`
- Modify: `services/chat-service/service.go`
- Modify: `services/chat-service/conversation_store.go`
- Create: `services/news-aggregator/cost_metrics.go`
- Modify: `services/news-aggregator/sentiment_analyzer.go`
- Modify: `services/news-aggregator/embeddings.go`
- Modify: `services/pkg/enrichment/gemini_client.go`

- [x] Add bounded AI/chat metrics.
- [x] Initialize OpenTelemetry in chat-service and register DB pool gauges.
- [x] Record Gemini request tokens and tool-call counts without user/conversation labels.
- [x] Record news sentiment, news embedding, and enrichment Gemini usage without user/conversation labels.
- [x] Enforce input/history/output limits and prune old chat rows best-effort.
- [x] Run `go test ./chat-service ./pkg/otel`.

### Task 4: Deployment Wiring

**Files:**
- Modify: `terraform/modules/chat-service/main.tf`
- Modify: `terraform/modules/chat-service/variables.tf`
- Modify: `terraform/environments/prod/main.tf`
- Modify: `terraform/modules/cloudflare-edge/main.tf`
- Modify: `terraform/modules/cloudflare-edge/variables.tf`

- [x] Add OTEL env wiring and secret access for chat-service.
- [x] Add chat guardrail env vars.
- [x] Route chat tool calls through `https://api.shorted.com.au` so Cloudflare cache protects hot read tools.
- [x] Add sampled edge cache analytics and fix KV prewarm key mismatch.
- [x] Run `terraform fmt` on changed Terraform files.

### Task 5: Validation

**Commands:**
- `go test ./chat-service ./pkg/otel`
- `go test ./chat-service ./pkg/otel ./news-aggregator ./pkg/enrichment`
- `go test ./chat-service`
- `terraform fmt terraform/modules/chat-service/main.tf terraform/modules/chat-service/variables.tf terraform/environments/prod/main.tf`

### Task 6: Cloudflare RUM/Edge Cost Attribution

**Files:**
- Modify: `services/edge-worker/worker.js`
- Test: `services/edge-worker/analytics.test.mjs`

- [x] Write failing tests for normalized frontend route groups, API families, RPC names, and referer-derived page groups.
- [x] Export pure analytics helper functions from the Worker module without changing request handling.
- [x] Add bounded fields to sampled `edge_request` JSON logs: `route_group`, `referer_group`, `api_family`, `rpc_method`, `cacheable`, `cf_colo`, and `cf_client_bot`.
- [x] Run Worker analytics tests and `node --check services/edge-worker/worker.js`.

### Task 7: Firestore Cost Instrumentation Layer

**Files:**
- Create: `web/src/@/lib/firestore-cost.ts`
- Test: `web/src/@/lib/__tests__/firestore-cost.test.ts`
- Modify: `web/src/@/lib/community/firestore-community.ts`
- Modify: `web/src/app/actions/portfolio.ts`
- Modify: `web/src/app/actions/dashboard.ts`

- [x] Write failing tests for document/read/write bucketing and structured Firestore cost event emission.
- [x] Implement a low-cardinality Firestore instrumentation helper that emits OpenTelemetry metrics and structured JSON logs.
- [x] Wrap Firestore reads/writes in community, portfolio/watchlist, and dashboard actions with feature, collection, operation, status, and count fields.
- [x] Run targeted Jest tests for the new helper and existing community Firestore tests.

### Task 8: Query Guide And Validation

**Files:**
- Create: `docs/observability/cost-attribution.md`

- [x] Document emitted event schemas and safe dimensions.
- [x] Add example queries for edge cache miss rate, Firebase read/write load by feature, and cost-per-page-view joins with Cloudflare RUM.
- [x] Run web tests, Worker checks, and TypeScript/static validation where practical.
