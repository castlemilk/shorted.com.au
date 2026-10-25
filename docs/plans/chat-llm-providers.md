# Pluggable LLM providers for Shorted AI chat

Status: plan, 2026-10-24. Phases ship as separate PRs (§8). Vendor facts were
read on 2026-10-24 and must be re-checked before any activation.

> **Update, 2026-10-25: Flaggr chooses the model per user (§12).** The
> `chat-model` flag replaces the database routing table and the admin UI for
> model selection. Those parts are marked "superseded" below: §4's
> `chat_model_routing` table and its reading and writing rules, the
> `ActivateModel` and `RollbackModel` RPCs, the `activate_chat_model` and
> `rollback_chat_model` MCP tools, the §7 routing card and activation dialog,
> and the model-selection parts of P3a, P4 and P5. The ledger, the usage
> columns, the eval and gate, the catalog and the usage views stay as written.

## 0. What the research established

1. **DeepSeek's model lineup has changed.**
   - The API now names `deepseek-flash` (served by DeepSeek-V4.1-Flash-1017) and `deepseek-v4-pro`.
   - Legacy names (`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`) are still accepted, but they are silently served by V4.1-Flash and billed at the Flash price.
   - So catalog model IDs must be re-verified before activation.
2. **DeepSeek thinking mode is on by default, and it breaks our loop.**
   - `required` and named `tool_choice` return 400 in thinking mode.
   - With tools present, `reasoning_content` must be sent back on every later request, which our text-only history cannot do.
   - So the DeepSeek adapter ALWAYS sends `"thinking":{"type":"disabled"}`, and a test pins it. With thinking disabled, `tool_choice: "required"` works. That is the equivalent of Gemini's `FunctionCallingAny`.
3. **OpenRouter can silently drop forced tool choice.**
   - For `deepseek/deepseek-v4-flash`, only 4 of 15 endpoints (DeepInfra, Azure, Cloudflare, Wafer) honour `required`. `qwen/qwen3.8-flash` honours only `none` and `auto`.
   - Without `require_parameters`, providers ignore parameters they do not support. That is the #759 regression (the model invents figures without data), arriving silently.
   - So always send `provider.require_parameters=true` and a pinned `only` list, and check server-side that the first reply really called a tool.
4. **The Gemini SDK is end-of-life.**
   - `github.com/google/generative-ai-go` was archived on 2026-10-12, and support ended 2025-11-30.
   - v0.20.1 has no thought-signature field, and Gemini 3.x in stateless mode needs signatures resent. So no Gemini 3.x model is activatable until chat moves to `google.golang.org/genai` (P1b, decided 2026-10-24).
   - On Go 1.27 the legacy SDK's stream works only with gax-go ≥ v2.26.1.
5. **The savings are modest, so grounding should drive the choice.**
   - The table assumes about 10k input and 300 output tokens per data turn, over 2 model calls. That is an estimate, not a measurement.

     | Model | Cost per 1k turns |
     |---|---|
     | gemini-2.5-flash (prod) | $3.75 |
     | gemini-2.5-flash-lite | $1.12 |
     | deepseek-flash, peak, no cache | $3.36 |
     | deepseek-flash, off-peak or good cache hits | $0.80 to $1.70 |
     | gpt-5-mini | $3.10 |
     | qwen3.8-flash (cannot force tools) | $1.64 |
     | deepseek-v4-flash via OpenRouter on DeepInfra | $0.95 |

   - The cheapest low-risk move is `gemini-2.5-flash-lite`: same vendor and key, gated by the same eval.
6. **Prod today.**
   - Chat runs `gemini-2.5-flash` (the `config.go` default) with secret `GEMINI_API_KEY_CHAT` and 1024 max output tokens.
   - `OPENROUTER_API_KEY` exists in prod Secret Manager. It was hand-created and is used by the report extractor.

### Sources (all fetched 2026-10-24)

| Source | What it established |
|---|---|
| api-docs.deepseek.com/quick_start/pricing | Models and per-1M prices. Off-peak is 50%, and peak is 01–04 and 06–10 UTC, Mon–Fri. Concurrency is 2500 (flash) and 500 (pro). |
| api-docs.deepseek.com/api/create-chat-completion | `tool_choice` modes and the thinking-mode 400. `stream_options.include_usage`. The usage fields `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `reasoning_tokens`. The tool-call delta format: the first chunk carries id, type and name, and later chunks carry only arguments. |
| api-docs.deepseek.com/guides/thinking_mode | Thinking is on by default. The `reasoning_content` send-back rule. |
| api-docs.deepseek.com/guides/tool_calls | Strict mode needs `/beta` (we do not use it). Tool calls cannot be inserted mid-conversation. |
| api-docs.deepseek.com/quick_start/rate_limit | Account concurrency, with 429 when exceeded. SSE `: keep-alive` comments while a request is queued, for up to 10 minutes. `user_id` for cache isolation, with no personal data. |
| api-docs.deepseek.com/quick_start/error_codes | 400 / 401 / 402 (balance) / 422 / 429 / 500 / 503 |
| ai.google.dev/gemini-api/docs/pricing | 2.5 Flash $0.30 / $2.50 per 1M (in/out). 2.5 Flash-Lite $0.10 / $0.40. 3.1 Flash-Lite $0.25 / $1.50. |
| ai.google.dev/gemini-api/docs/thinking | Stateless mode must resend all thought blocks. |
| openrouter.ai/docs/features/provider-routing | `require_parameters`, `only`, `data_collection`, `zdr` |
| openrouter.ai/docs/use-cases/usage-accounting | Usage arrives in the last SSE chunk, with `usage.cost` and `prompt_tokens_details.cached_tokens`. |
| openrouter.ai/api/v1/models/…/endpoints | The live per-endpoint `tool_choice` support quoted above. |

## 1. Architecture

```
 web /api/chat (proxy) ──X-Internal-Secret, X-User-Id──► chat-service  chat.v1.ChatService/SendMessage
 web /admin/chat (server actions, requireAdmin) ─┐               │
 shorts /mcp/admin (chat:admin tools) ───────────┤               ▼
     X-Internal-Secret + X-Admin-Actor           │   ChatServiceHandler (limits, ledger, persistence: unchanged)
                                                 │               │ RunTurn(userID, input, onChunk)
                                                 ▼               ▼
                       chatadmin.v1.ChatAdminService ─► ModelRouter ── TTL cache (30s) ─► routing_store (Postgres)
                       (state, eval, activate,           │  resolve: candidate (rollout) | stable | env default
                        rollback, history, usage)        │  fallback: config.fallback | env Gemini; breaker per model
                                │                        ▼
                                └──► evalRunner ──► TurnEngine (owns: first-call policy, rounds, budgets, cap,
                                                     │           tool execution, notices, usage, cost, timeouts)
                                                     │ ChatProvider.NewSession → ModelSession.Send (one model call)
                         ┌───────────────────────────┼────────────────────────────┐
                 geminiProvider              openAICompatProvider (raw net/http + SSE)
                 (generative-ai-go → P6 genai)   deepseek | openrouter | groq | together | mistral | dashscope | moonshot
```

The rules that hold it together:

- **A provider makes exactly one model call per `Send`.** The engine owns everything else.
- **Each session keeps its own provider-native transcript.** For Gemini this is the same `genai.ChatSession` used today, which is what makes P1 byte-identical. Falling back to another provider therefore restarts the turn; it never splices transcripts.
- **API keys exist only in chat-service's environment.** The DB names providers, which are registry keys. Admins see whether a key is present, plus an 8-hex SHA-256 fingerprint, never the key.

## 2. Go interfaces and key types (`services/chat-service/provider.go`)

```go
// ChatProvider is one LLM backend. It knows its wire protocol and nothing about
// what tools mean, budgets, fallback or persistence: TurnEngine owns those.
type ChatProvider interface {
	Name() string // catalog key: "gemini", "deepseek", "openrouter", ...
	// NewSession starts one turn. It makes no network call.
	NewSession(cfg SessionConfig) (ModelSession, error)
	Close() error
}

// SessionConfig is fixed for one turn.
type SessionConfig struct {
	Model           string
	System          string
	History         []Message        // stored user/assistant text, as buildGeminiHistory reads today
	Tools           []ToolDefinition // GetToolDefinitions() + answerWithoutDataDefinition()
	MaxOutputTokens int32
	Params          ModelParams
	EndUser         string // pseudonymous: "u_"+hex(sha256("shorted-chat:"+uid))[:24]; never a raw uid/email
}

// ModelParams is the CLOSED set of knobs an admin may set. Nothing free-form
// reaches a request body.
type ModelParams struct {
	Temperature    *float64 // nil = provider default (today: unset)
	OpenRouterOnly []string // openrouter only; slugs matching ^[a-z0-9-]{1,40}$
}

// ModelSession is one turn's conversation. Each Send is exactly one model call.
// The session appends the input and the model's reply to its native transcript,
// including anything that must be replayed verbatim (Gemini merged Content,
// reasoning_content), so the engine never sees provider types.
type ModelSession interface {
	Send(ctx context.Context, in SendInput, choice ToolChoice, emit func(ModelEvent)) (ModelReply, error)
}

// SendInput is what the model reads next: the user's message on the first call,
// then a result for EVERY call of the previous reply, in the same order.
type SendInput struct {
	UserText    string
	ToolResults []ToolResult
}

type ToolChoice int

const (
	ToolChoiceAuto     ToolChoice = iota // Gemini: nil ToolConfig (exactly as today); OpenAI: "auto"
	ToolChoiceRequired                   // Gemini: FunctionCallingAny; OpenAI: "required"
	ToolChoiceNone                       // Gemini: FunctionCallingNone; OpenAI: "none"
)

type ToolCall struct {
	ID        string         // provider id; "call_<seq>" when the provider has none (Gemini legacy)
	Name      string
	Args      map[string]any // nil when ArgsError != ""
	ArgsError string         // the model's argument JSON did not parse
}

type ToolResult struct {
	CallID string
	Name   string
	JSON   string // the exact text the model reads (tool output, "Error: ...", or a notice)
}

type ModelEventKind int

const (
	EventTextDelta       ModelEventKind = iota
	EventToolCallStarted                // name known, args still streaming (engine ignores it in P1-P5)
)

type ModelEvent struct {
	Kind     ModelEventKind
	Text     string
	ToolName string
	ToolID   string
}

type FinishReason string

const (
	FinishStop      FinishReason = "stop"
	FinishToolCalls FinishReason = "tool_calls"
	FinishLength    FinishReason = "length"
	FinishFiltered  FinishReason = "content_filter"
	FinishOther     FinishReason = "other"
)

type ModelReply struct {
	Text      string     // all text this call produced (already emitted as deltas)
	ToolCalls []ToolCall // complete, in model order
	Usage     TokenUsage
	Finish    FinishReason
	FirstByte time.Duration
}

// TokenUsage replaces GeminiUsage (cost_metrics.go).
type TokenUsage struct {
	PromptTokens, CachedPromptTokens, CandidateTokens, ReasoningTokens, TotalTokens int64
	ReportedCostUSD *float64 // OpenRouter usage.cost; nil elsewhere
}

// ProviderError is the only error type a Send returns. Err is already redacted
// (built with providerError).
type ProviderError struct {
	Provider  string
	Reached   bool // at least one response chunk arrived (billed): feeds turnError.ModelReached
	Retryable bool // 429, 500, 502, 503, 504, finish insufficient_system_resource, network error before any chunk
	Status    int
	Err       error
}
```

Catalog and routing types live in `provider_catalog.go` and `model_router.go`:

```go
type ProviderKind string // "gemini" | "openai_compat"

type ProviderSpec struct {
	Name    string
	Kind    ProviderKind
	BaseURL string // openai_compat: "https://api.deepseek.com", "https://openrouter.ai/api/v1", ...
	KeyEnv  string // "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY_CHAT", ...
	Dialect OpenAIDialect
	Models  []ModelSpec
}

type OpenAIDialect struct {
	DisableThinking bool   // DeepSeek: always send "thinking":{"type":"disabled"}
	EndUserField    string // "user_id" (DeepSeek) | "user" (OpenAI/OpenRouter) | ""
	OpenRouterPrefs bool   // send "provider":{"require_parameters":true,"only":[...],"data_collection":"deny"}
	RequiredChoice  string // usually "required"
}

type ModelSpec struct {
	ID          string
	Label       string
	Caps        ModelCapabilities
	Price       Pricing
	Activatable bool // false: test-only (e.g. gemini-3.x before P6)
	Notes       string
}

type ModelCapabilities struct {
	ForcedToolChoice  bool // honours "required"; false → verify policy (§3)
	NoneToolChoice    bool
	ParallelToolCalls bool
	MaxOutputTokens   int32
}

type Pricing struct { // USD per 1M tokens at the standard/peak rate
	Input, CachedInput, Output float64
	OffPeakFactor              float64              // 0.5 DeepSeek, 1 elsewhere
	IsOffPeak                  func(time.Time) bool // nil = never
	AsOf, SourceURL            string
}

// ModelRef is what a config row and an admin request name.
type ModelRef struct {
	Provider        string
	Model           string
	MaxOutputTokens int32
	Params          ModelParams
}

type TurnRoute struct {
	Label    string // "stable" | "candidate" | "fallback" | "env_default" | "eval"
	ConfigID int64  // 0 for env default / eval
	Provider ChatProvider
	Ref      ModelRef
	Spec     ModelSpec
}
```

`LLMResponse` gains these fields: `Provider`, `Model`, `Route`, `ConfigID`, `FirstCallViolation bool`, `FirstTextMs`, `TotalMs` and `EstCostMicroUSD int64`.

`ChatServiceHandler` replaces `llmClient *LLMClient` with:

```go
type turnRunner interface {
	RunTurn(ctx context.Context, userID string, in TurnInput, onChunk func(string)) (*LLMResponse, error)
	Ready() bool
}
```

Titles are a truncation today (`conversationTitle`), not a model call, so nothing changes there.

## 3. Engine rules (`turn_engine.go`)

1. **First-call policy.** It comes from `Spec.Caps`, and an admin cannot change it.
   - **Forced** (`ForcedToolChoice`): the first `Send` uses `ToolChoiceRequired`. This is today's behaviour.
   - **Verify** (the model cannot be forced): the first `Send` uses `Auto`, and one sentence is appended to the system prompt: "Before you answer, call a tool: a data tool, or answer_without_data when no data is needed." First-call text is buffered, not streamed. Under ANY today the first call never streams text, so nothing visible changes.
2. **Violation check (P2+, both policies).** A first reply with zero tool calls increments `chat_first_call_violation_total{provider,model}`. The turn is then retried once on a fresh session with the nudge sentence. If the retry still calls no tool, its text is flushed, `FirstCallViolation=true` is set, and the usage row records it. The eval gate requires zero violations on data turns.
3. **Rounds and budgets keep today's semantics.**
   - `maxToolRounds=5` and `maxToolCallsPerRound=4`.
   - `planRoundCalls` is unchanged except that it now takes `[]ToolCall`.
   - `answer_without_data` takes no cap slot and is never recorded.
   - The request that carries round r's results uses `Auto` if `roundHasBudget(r)`, otherwise `None`.
   - Every call gets a result. From P2, a call with `ArgsError != ""` takes a cap slot and gets this notice: `{"error":"The arguments for this call were not valid JSON, so it did not run. Call it again with valid JSON arguments."}`
4. **Fallback (P2+).** All three conditions are required:
   - `ctx.Err()==nil` (a client cancel never falls back, and the partial reply is kept as today);
   - no text chunk has reached `onChunk`;
   - the error is a `ProviderError`.

   When they hold, log the structured ERROR line `chat_provider_fallback`, then rerun the whole turn on the fallback route. Tools re-execute, and the failed attempt's tool records are discarded.

   Before falling back, retry the same provider once if `Retryable && !Reached`, after 300–800ms of jitter.
5. **Circuit breaker.** It is kept per (provider, model) and per instance, in memory. Five consecutive failures before any text open it for 60s; while open, the route goes straight to fallback, and then it is half-open.
6. **Timeouts (P2+; none in P1).**
   - First data byte per `Send`: 15s. SSE `:` comments do not count.
   - Idle between chunks: 20s.
   - Whole turn: 50s. This sits under the web proxy's `maxDuration = 60` and the probe's 35s turn budget.
7. **Metrics.** `recordGeminiRequest` becomes `recordModelRequest(ctx, provider, model, phase, status, usage)`. It emits `event_type:"gemini_request"` for Gemini (the queries in `docs/observability/cost-attribution.md` filter on that) and `"llm_request"` otherwise, and always adds `provider` and `est_cost_micro_usd`. Eval turns log `feature:"chat_eval"`.
8. **Cost.** `EstimateCostMicroUSD(spec.Price, usage, turnStart)` = `(prompt-cached)*Input + cached*CachedInput + candidate*Output`, multiplied by `OffPeakFactor` when off-peak. Prefer `ReportedCostUSD` when present.

## 4. Data model (P3a)

> **Superseded for model selection by §12.** The `chat_model_routing` table and
> its reading and writing rules below are not built, and the flag replaces them.
> The `chat_model_configs`, `chat_model_eval_runs` and `chat_usage_events`
> columns are kept.

Number the migrations at PR time and re-check origin/main. Both are allowlisted in `terraform-deploy.yml`, after 000147 and before 000138, with comment blocks like 000145's.

- **`chat_model_configs`**: id, created_at, created_by (`oauth:<uid>` | `web:<uid>`), provider, model, max_output_tokens (64–8192), temperature, params JSONB (the closed set), params_hash (sha256 of the canonical ref), fallback_provider, fallback_model. CHECKs on the provider slug and the model length.
- **`chat_model_eval_runs`**: one row per smoke or gate run, holding the suite, ref, status (`running|passed|failed|errored`), counts (turns, data_turns, correct, grounded, errored, no_data_chosen, first_call_violations), p50/p90, tokens, est cost, failures JSONB and results JSONB (fixed prompts only). Indexed on (provider, model, params_hash, finished_at DESC).
- **`chat_model_routing`** (superseded by §12): an append-only snapshot log. The newest row is the live state, so the table is also the audit log. Columns: actor, action (`activate|stage|promote|rollback|reset`), stable_config_id (NULL = env default), candidate_config_id, rollout_mode (`off|users|percent`), rollout_percent, rollout_user_ids JSONB, eval_run_id, eval_bypassed, restored_from_id, reason. A CHECK ties the candidate to the rollout mode.
- **`chat_usage_events`** gains nullable columns: provider, config_id, route, cached_input_tokens, est_cost_micro_usd, first_text_ms, total_ms, first_call_violation. They are added by one ALTER behind a `pg_attribute` guard, so a replay takes no lock on this hot table (000146's reasoning).

Every statement is IF NOT EXISTS or catalog-guarded, runs under `SET LOCAL lock_timeout = '15s'`, and touches no row.

How the router reads and writes this state:

- **Reading.** The router reads the latest routing row joined to both configs. It caches the result for `CHAT_MODEL_CONFIG_TTL` (30s), with a single-flight refresh and a 500ms timeout.
  - On a DB error it uses the last known good state, and with none it uses the env default.
  - `42P01` (table missing) sets `config_status="table_missing"` and uses the env default.
  - A config that fails validation logs `chat_model_config_invalid` and uses the env default.
- **Rollout matching.** The `users` mode matches the uid against the list. The `percent` mode matches when `fnv32a(uid+":"+candidate_config_id) % 100 < percent`, which is stable per user.
- **Writing** happens in one transaction:
  1. Take `pg_advisory_xact_lock(hashtext('chat_model_routing'))`. Only transaction-scoped locks are safe, because the pooler runs pgx in simple-protocol mode.
  2. Check `expected_snapshot_id`; a mismatch returns `FailedPrecondition`.
  3. Insert the config, then the snapshot.
  4. Invalidate the cache.

  JSONB is passed as strings with `$n::jsonb`.
- **`CompleteSend`** writes the new columns. On `42703` (column missing) it retries the old UPDATE.

## 5. Admin API: `chatadmin.v1.ChatAdminService`, served by chat-service

Why it lives in chat-service:

- Only chat-service holds the provider keys, so only it can report key presence truthfully.
- Tests and evals must run the real TurnEngine, ToolExecutor and provider.
- Its callers, the shorts admin MCP and web server actions, already hold `INTERNAL_SERVICE_SECRET` and do their own admin check first.

It gets its own proto package because the edge worker routes `/chat.v1.` paths to chat-service on `api.shorted.com.au`. `/chatadmin.v1.` does not match that rule, so the admin surface is reachable only on the run.app URL.

Auth works like this:

- The internal secret is required.
- `X-Admin-Actor` is required and must match `^(oauth|web):[A-Za-z0-9._-]{1,128}$`.
- `X-Admin-Email` is optional and used for display only.

RPCs: `GetModelState`, `RunModelEval` (suite smoke | gate), `ActivateModel` (stage | activate | promote), `RollbackModel` (never gated), `ListRoutingHistory`, `GetModelUsage`.

Superseded by §12: `ActivateModel`, `RollbackModel` and `ListRoutingHistory`, which choose the model for real users, and the routing fields of `GetModelState`. `RunModelEval` and `GetModelUsage` stay.

Activation rules:

1. **Validation.**
   - The provider must be in the catalog and its key must be present.
   - The model must be in the catalog with `Activatable=true`.
   - `max_output_tokens` must be 256–4096 and `temperature` 0–1.5.
   - `openrouter_only` is accepted only for openrouter, as slugs.
   - The fallback ref gets the same checks.
2. **Gate.**
   - Moving to STABLE, or to a percent rollout, needs a gate run with status `passed`, for the same params_hash, from the last 7 days.
   - Ungated staging is allowed only as a candidate with a `users` rollout whose list is exactly the actor's uid (admin self-preview), recorded as `eval_bypassed=true`.
   - A model that cannot force tool choice can only be self-previewed until a gate passes.
3. **Promote** moves the candidate to stable and clears it.
4. **Rollback** re-appends an earlier snapshot. **Reset** writes stable=NULL and candidate=NULL. Neither is gated.

## 6. Admin MCP tools (`/mcp/admin`, new scope `chat:admin`)

`RequireAdmin` asks for at least one admin scope, never all of them, and each tool checks its own scope. Appending `chat:admin` therefore keeps existing connectors working; the five new tools return a "reconnect to grant chat:admin" error until the connector reconnects.

Two edits are required:

- Append to `AdminScopes`.
- Add a line to `scopeDescriptions` in `oauth/consent.go`. `DescribeScopes` drops unknown scopes, so without this line the consent screen would not show the new scope.

| Tool | Calls | Bound |
|---|---|---|
| `chat_model_status` | state + 24h usage + last 5 snapshots | 20s |
| `test_chat_model` | smoke suite: 4 fixed prompts (BHP short %, most shorted, "hi", "What does T+4 mean?") | 60s |
| `evaluate_chat_model` | gate suite, returns `eval_run_id` | 85s (under the 90s `StreamLifetime`) |
| `activate_chat_model` | superseded by §12 | 20s |
| `rollback_chat_model` | superseded by §12 | 20s |

## 7. Admin web UI (`/admin/chat`)

> **Superseded for model selection by §12.** The routing card, the Activate
> dialog and Rollback/Reset are not needed once Flaggr chooses the model. The
> Test, Run gate, Providers, Catalog and Records sections stay.

The page is a server component that runs `requireAdmin()`, with `dynamic = "force-dynamic"` and `maxDuration = 120`. The client console uses server actions only and imports no Connect code. Each action runs `requireAdmin()` and calls chat-service at `CHAT_SERVICE_ADMIN_URL` (the run.app origin) with the internal secret and `X-Admin-Actor: web:<uid>`.

Sections:

- **Routing card:** stable, candidate and rollout, env default, `source` / `config_status`.
- **Providers:** whether each key is present, its fingerprint, the base URL host.
- **Catalog:** the forced-tool badge (red "verify policy" when the model cannot be forced), prices with their as-of date and source.
- **Actions:**
  - Test and Run gate, each with a results table.
  - An Activate dialog. Percent and all are disabled until a passed gate exists for the exact ref, and a reason is required.
  - Rollback and Reset.
- **Records:** the history (audit) and 7-day usage by model (sends, error %, tokens, cost, cost per send, p50, violations, fallbacks).

## 8. Phases (one PR each)

### P1: interface, Gemini adapter and engine, with zero behaviour change

New files:

- **`provider.go`** holds the §2 types.
- **`provider_gemini.go`** holds `geminiProvider` and `geminiSession`, which wraps one `genai.GenerativeModel` and its `ChatSession`. Move `newModel`, `buildGeminiTools`, `buildGeminiHistory`, `extractFunctionCalls`, `extractTextContent` and `geminiUsageFromResponse` here. `Send` does four things:
  1. Sets `ToolConfig` from the choice: Auto → **nil**, Required → `FunctionCallingAny`, None → `FunctionCallingNone`.
  2. Sends `genai.Text` on the first call. After that it sends one `FunctionResponse` per result, parsed exactly as today: the JSON object, or `{"result": text}`.
  3. Streams as today. Usage comes from the last chunk carrying tokens, and call IDs are synthesised as `call_<seq>`.
  4. Returns a `ProviderError` with `Reached` set when at least one chunk arrived.
- **`turn_engine.go`** is today's `ChatStream` loop, line for line, over the session. It takes over `maxToolRounds`, `maxToolCallsPerRound`, `roundHasBudget`, `planToolCalls`, `planRoundCalls` (now over `[]ToolCall`), `toolCallNotice`, `isDataTool`, `recordToolRun`, `turnError`, `modelAnswered`, `LLMResponse`, `ToolCallRecord` and `Citation`. The first call uses `ToolChoiceRequired`. There is no violation check and no timeout. Logs and phase labels stay as they are.
- **`turn_engine_test.go`** scripts replies with a fake provider. It covers:
  - Required on the first call, then Auto, then None when the budget is spent;
  - 6 calls give 4 executed plus 2 over-cap notices;
  - round 5 answers every call with the no-budget notice and ends;
  - `answer_without_data` is never recorded and takes no slot;
  - `ModelReached` is false only for a first-call error with `Reached=false`;
  - text is streamed in order.
- **`provider_gemini_test.go`** covers:
  - the choice → ToolConfig mapping, where Auto must give **nil** and not an explicit AUTO;
  - the tool schema conversion, where a tool with no parameters gets nil Parameters;
  - a golden wire test. `genai.NewClient(option.WithAPIKey("k"), option.WithEndpoint(httptest URL))` records request bodies and replays canned stream bodies for a 2-round turn.

Modified files:

- `llm_client.go` shrinks to a facade, `LLMClient{provider; engine; model; maxOutputTokens}`. `NewLLMClient` keeps its signature, and `ChatStream` delegates. The unused `Chat()` is deleted.
- `cost_metrics.go`: `GeminiUsage` → `TokenUsage` and `recordGeminiRequest` → `recordModelRequest`. For Gemini, the event, its attributes and its span attributes stay exactly the same.
- `chat_limits.go`: `completionTokens(TokenUsage)`.
- The tests that build `&LLMClient{client: …}` move to a helper.

Commit the golden wire test against the current code FIRST. The refactor must then pass it unchanged.

Verify:

- `cd services && GOWORK=off go test ./chat-service/...`, golangci-lint and `task verify`.
- The live grounding eval (`CHAT_EVAL=1 … CHAT_EVAL_MIN_CORRECT=0.95 CHAT_EVAL_MIN_GROUNDED=0.95`) on the old and new binaries should give the same pass profile.
- go.mod does not change.

### P2: OpenAI-compatible adapter, catalog, fallback (selected by env only; prod default unchanged)

**`provider_openai_compat.go`** uses raw `net/http` and SSE:

- **Request.** POST `{BaseURL}/chat/completions` with `Authorization: Bearer` and `User-Agent: shorted-chat/1.0`.
  - The messages are the system prompt, then history text, then this turn's messages.
  - `tools` are `{type:"function",function:{name,description,parameters}}`. A tool with no parameters gets `{"type":"object","properties":{}}`, and nothing is sent as `strict`.
  - Always sent: `tool_choice`, `stream:true`, `stream_options:{include_usage:true}`, `max_tokens`, and `temperature` when set.
  - Dialect extras: `thinking:{type:"disabled"}` for DeepSeek, the `user_id` or `user` field set to EndUser, and `provider:{require_parameters:true, only:[…], data_collection:"deny"}` for OpenRouter.
- **Messages.** An assistant message omits empty content and carries `tool_calls:[{id,type,function:{name,arguments}}]`. Each result is a tool message, `{role:"tool", tool_call_id, content}`, one per result and in order.
- **SSE parsing.**
  - Lines starting with `:` and blank lines are ignored, and `data: [DONE]` ends the stream.
  - `delta.content` is emitted to the user. `delta.reasoning_content` is kept with the transcript and never emitted.
  - `delta.tool_calls` are assembled by `index`. The id and name arrive first, and argument fragments are concatenated.
  - At the end, the arguments are unmarshalled: an empty string means `{}`, and a failure sets `ArgsError`.
  - Usage is read from `prompt_tokens`. Cached tokens are the larger of `prompt_cache_hit_tokens` and `prompt_tokens_details.cached_tokens`. Output and reasoning come from `completion_tokens` and `completion_tokens_details.reasoning_tokens`, and cost from `usage.cost`.
  - A finish of `insufficient_system_resource` with no text is a retryable error.
- **Errors.** A non-200 before any chunk is `Reached=false`; 429 and 5xx are retryable. Only `error.message` is read from the body, at most 4 KB, run through `redactSecrets` and `providerError`. Request bodies are never logged.

**`provider_catalog.go`**:

| Provider | Models | Forced | Activatable |
|---|---|---|---|
| gemini | gemini-2.5-flash, gemini-2.5-flash-lite | ✓ | ✓ |
| gemini | gemini-3.1-flash-lite | | test-only until P6 |
| deepseek (`https://api.deepseek.com`, `DEEPSEEK_API_KEY`) | deepseek-flash | ✓ (thinking off) | ✓ |
| deepseek | deepseek-v4-pro | ✓ | ✓ ("not cheaper") |
| openrouter (`OPENROUTER_API_KEY_CHAT`) | deepseek/deepseek-v4-flash (only deepinfra, azure), openai/gpt-5-mini | ✓ | ✓ |
| openrouter | qwen/qwen3.8-flash | ✗ (verify) | ✓ |
| groq / together / mistral / dashscope / moonshot | none yet | | test-only until each one's tool_choice is verified |

Each provider's key comes from env, and startup calls `registerSecrets(key)` for it. Every price carries its as-of date and source.

**`pricing.go`** holds `EstimateCostMicroUSD` and DeepSeek's `IsOffPeak` (peak is 01–04 and 06–10 UTC, Mon–Fri).

**`model_router.go`** is env-only in this phase:

- `CHAT_PROVIDER` / `CHAT_MODEL` choose the primary.
- `CHAT_FALLBACK_*` choose the fallback. When unset and the primary isn't Gemini, the fallback is env Gemini.
- It implements §3 rules 4–6.

**Config:**

- `CHAT_PROVIDER` (default `gemini`).
- `CHAT_MODEL` (defaults to `GEMINI_MODEL`, then `gemini-2.5-flash`).
- `CHAT_MAX_OUTPUT_TOKENS`.
- `CHAT_FALLBACK_*`.
- `DEEPSEEK_API_KEY` and `OPENROUTER_API_KEY_CHAT`, plus optional keys for the other providers.
- `CHAT_TURN_TIMEOUT` and `CHAT_PROVIDER_FIRST_BYTE_TIMEOUT` are unset by default, and the router picks the mode's value. With a fallback they are 50s and 15s. Alone (the prod Gemini default) they are 55s and 30s. The 55s budget leaves the web proxy's 60s a margin, and a late answer beats an error when nothing else can answer.
- `CHAT_ALLOW_PRC_HOSTED_PROVIDER` (default unset). In production, `CHAT_PROVIDER=deepseek` or `CHAT_FALLBACK_PROVIDER=deepseek` is refused unless this is `true`. DeepSeek's direct API is hosted in the PRC, so set it only once the §11.2 privacy review is done. OpenRouter routes pinned to US or EU hosts are not affected.
- In production, the routed model must be in the catalog, activatable, and from a provider that is not test-only. Config load refuses anything else. Elsewhere those routes are allowed for tests and smoke runs.

**Tests:**

- SSE fixtures under `testdata/sse/`: `text_only`, `tool_call_split_args`, `parallel_tool_calls`, `keepalive_comments`, `usage_last_chunk`, `invalid_args`, `finish_length`, `mid_stream_disconnect`, `http_429_json`, `http_402_json` and `http_400_json`.
- Request-body assertions:
  - the first call sends `"required"`;
  - a call with no budget left sends `"none"`;
  - DeepSeek always sends `thinking.type == "disabled"`;
  - `include_usage` is set;
  - `tool_call_id` appears in order;
  - `user_id` matches `^u_[0-9a-f]{24}$`;
  - OpenRouter sends `require_parameters:true`;
  - nothing is sent as `strict`.
- Pricing boundaries.
- Router behaviour:
  - fallback happens only before any text, and never on a cancel;
  - the same-provider retry happens only when `!Reached`;
  - the breaker opens and then goes half-open.
- The engine's verify policy and the violation retry.
- Redaction: the Bearer key never appears in errors or logs.

**Verify:** run the full live eval at 0.95 for deepseek-flash, gemini-2.5-flash-lite and OpenRouter deepseek-v4-flash pinned to DeepInfra. The PR carries a comparison table of correct, grounded, noDataChosen, violations, p50/p90 and est cost.

### P3a: in-process eval, migrations, DB-backed router (after the Go 1.27 PR merges)

- **`grounding_eval.go`.** Move the question set, truth fetching and scoring out of `chat_grounding_eval_test.go` into non-test code. `sendEvalTurn` stays in the test.
- **`eval_runner.go`.**
  - The smoke suite is d01, d08, n01 and n02 (45s). The gate suite is all 16 questions at concurrency 4 (80s).
  - Gate thresholds: correct ≥ 0.90 (11/12), grounded = 1.0, errored = 0, noDataChosen = 0, first-call violations on data turns = 0, p90 ≤ 20s.
  - Runs are synchronous with no background goroutines, because Cloud Run sets `cpu_idle=true`.
  - A turn unfinished at the budget counts as errored.
- **Store and router.** Superseded by §12: no `routing_store.go`. The flagged routes come from `buildChatModelRoutes` (`model_flag_routes.go`), and the selector is `model_flag.go`.
- **Migrations.** The two migrations with down files, plus `.test.mjs` guards cloned from `chat_message_partial.test.mjs`, and the allowlist lines.
- **Usage columns.** `chat_limits.go` writes the new usage columns, falling back on 42703.

### P3b: `ChatAdminService` and `served_by`

- Add `proto/shortedapi/chatadmin/v1/chat_admin.proto` and run `buf generate` (it writes Go, TypeScript and Java).
- Add a `ServedBy {provider, model, route}` message on the final `SendMessageResponse` frame.
- Add `admin_handler.go` with tests covering:
  - Unauthenticated without the secret or the actor;
  - FailedPrecondition for stable without a gate, a self-preview for another uid, a stale `expected_snapshot_id`, or a missing key;
  - a model that cannot be forced being stage-only;
  - rollback and reset never being gated;
  - no key material in any response.
- Mount it in `main.go` under `requireInternalSecret`.

### P4: admin MCP tools (shorts API)

- **`admin.go`:** `ScopeChatAdmin = "chat:admin"`, appended last, with `AdminChatOperator` and the tools. The two model-selection tools are superseded by §12.
- **`admin_chat.go`:** handlers that check the scope first, with the bounds in §6. They log `admin <tool>: actor=…`.
- **`mcp_admin_chat.go` (shorts):** `newChatAdminClientFromEnv()`. It needs `CHAT_SERVICE_URL` and `INTERNAL_SERVICE_SECRET`; with either missing, the tools return "not configured".
- **`consent.go`:** the scope description, plus a test that every `AdminScopes` entry has one.
- **Terraform:** `chat_service_url` in the shorts-api module, set from `module.chat_service.service_url`.
- **Docs:** `docs/mcp-admin.md`, and the admin MCP paragraph in `CLAUDE.md`.

### P5: admin web UI and paid-probe model reporting

- **Pages and actions:** `web/src/app/admin/chat/page.tsx`, `chat-model-console.tsx` and `web/src/app/actions/admin/chatModels.ts`, plus a link from `/admin`, with `'admin/chat': 120` in `scripts/verify-vercel-function-limits.mjs`. Superseded by §12 for the activation controls; the eval and usage panels stay.
- **Probe:** `servedBy` is passed to `data-shorted-final` only for `svc-paid-probe` and admins. `checkChat` reports `model=<provider>/<model> (<route>)`, so Telesis `paid-feature: chat` shows the active model.

### P1b: chat's Gemini adapter on `google.golang.org/genai` (decided 2026-10-24, right after P1)

It comes this early for three reasons:

- The legacy SDK is archived.
- Its stream reader broke on Go 1.27 and works only because gax-go is pinned at v2.27.0.
- It cannot send back thought signatures, which blocks Gemini 3.x tool calling.

P1 confines it to one file, so the swap touches only that adapter.

- **`provider_genai.go`** implements `ChatProvider` as `gemini`, using `genai.NewClient(ctx, &genai.ClientConfig{APIKey, Backend: genai.BackendGeminiAPI})`. Each session keeps its own `[]*genai.Content` transcript, not a `Chats` session:
  - The first call appends the user text.
  - Each call streams through `client.Models.GenerateContentStream(ctx, model, transcript, cfg)`. Text deltas are emitted, but parts with `Thought=true` never reach the user.
  - Every streamed part of the model's turn is collected into ONE `Content` and appended verbatim, `ThoughtSignature` and function-call parts included. Text parts are merged as the legacy SDK merged them.
  - Tool results are appended as one user-role `Content` holding a `FunctionResponse` part per call, in order.
- **Config mapping:**
  - `SystemInstruction`, and `Tools` as `FunctionDeclarations` with the same schema as `buildGeminiTools`.
  - `ToolConfig`: Auto → nil, Required → `ANY`, None → `NONE`.
  - `MaxOutputTokens`, and `Temperature` only when set.
  - No `ThinkingConfig`, so the model keeps today's default thinking.
  - Usage comes from `UsageMetadata` (prompt, cached, candidates, thoughts, total).
- **Errors** are wrapped as `ProviderError`. `Reached` means a chunk arrived. 429 and 5xx (`genai.APIError.Code`) are retryable. Every message goes through `providerError`.
- **Tests:**
  - A golden wire test against an httptest server via `HTTPOptions.BaseURL`, covering a 2-round turn, the tool-config mapping, and the thought signature being replayed in the second request.
  - The engine tests unchanged.
- **Live gate:** the 56-turn grounding eval at 0.95, run on the legacy adapter and on the genai adapter, both built locally with go1.27.2. The PR carries both summaries. Merge only if genai is no worse.
- **Cleanup:** delete the legacy chat adapter. The gax regression test stays until P1c.

### P1c: batch jobs off `generative-ai-go`, then remove the dependency

- Move `services/jobs/internal/jobs/{news,weeklyreport,reportextract,influence}`, `services/pkg/enrichment` and `services/weekly-report-generator` to `genai`. These are non-streaming `GenerateContent` calls plus JSON-schema output; keep each job's prompts and output contract byte for byte.
- Then drop `github.com/google/generative-ai-go` from both modules, delete `TestGeminiProtoJSONStreamDecodesFullArray`, and un-pin `cloud.google.com/go/ai`.
- Verify with each job's existing tests plus one dry run per job (`-dry-run`/`-print-prompt`, where they exist).

### P6: later

- Make Gemini 3.x catalog entries activatable once their gate passes on the genai adapter.
- **Optional:** an Anthropic Messages adapter (`tool_choice {"type":"any"}`), and auto-disabling the candidate when the breaker opens repeatedly.

## 9. Secrets, Terraform and deploy

- **The chat-model flag (§12) secrets.** `FLAGGR_API_KEY` (the project token, `fgr_...`), `FLAGGR_SERVICE_ID` and `DEEPSEEK_API_KEY`. The workflow syncs each to Secret Manager only when its GitHub secret is set, and sets the matching Terraform input (`flaggr_api_key_secret_name`, `flaggr_service_id`, `deepseek_api_key_secret_name`). An unset value adds no env var and no grant. `validate-secrets` does not require them.
- **Cuttlefish holds the deploy secrets.** Set them with `printf '%s' "$KEY" | cuttle secrets set DEEPSEEK_API_KEY --project shorted`, and the same for `OPENROUTER_API_KEY_CHAT`. Use a chat-only DeepSeek key with a low prepaid balance, where a 402 becomes a graceful Gemini fallback plus an alert, and an OpenRouter key with a credit limit.
- **Add the validator `scripts/validate-openai-compatible-key.sh [-|KEY] BASE_URL MODEL`.**
  - Follow the contract of `validate-gemini-key.sh`: the key comes on stdin and never appears in argv, and `set +x` is set.
  - Exit codes: 0 ok, 2 rejected, 3 unverified, 4 empty, 1 usage.
  - It makes a real generation call (`max_tokens` 5, with `thinking` disabled on DeepSeek).
  - It comes with a `.test.mjs`.
- **`terraform-deploy.yml`.** Use `ensure_llm_secret` next to `ensure_gemini_secret` in both "Ensure secrets exist" steps, and pin it in the workflow tests.
- **`terraform/modules/chat-service`.**
  - The `deepseek_secret_name` and `openrouter_secret_name` variables, both defaulting to `""`.
  - IAM resources gated by count.
  - Env through `secret_key_ref` only, never a plain value.
  - `chat-lockdown.test.mjs` extended to cover these rules.
- **Ordering.**
  1. Merge the module change with the secret name `""`.
  2. Confirm the secret exists after a deploy whose validator printed `ok`.
  3. Then set the name in `terraform/environments/prod/main.tf`.

  Cloud Run rejects a revision that references a missing secret.
- **Vercel** needs `CHAT_SERVICE_ADMIN_URL`, the run.app origin.
- **Rotation:** Cuttlefish, then deploy, then Secret Manager. Cloud Run reads `latest` at instance start.

## 10. Landmines

1. **Migration allowlist.** It is replayed on every deploy. Files must be replay-safe and sit after 000147 and before 000138 (which stays last). Re-check the number at merge. A bare `ADD COLUMN` fails `migration-drift.test.mjs`.
2. **`CHAT_SERVICE_INTERNAL_URL` lives in the Vercel dashboard.** If it is `https://api.shorted.com.au`, `/chatadmin.v1.*` reaches the shorts API and returns 404. Use `CHAT_SERVICE_ADMIN_URL`.
3. **The shared `INTERNAL_SERVICE_SECRET` now also controls model routing.**
   - Mitigations: the required actor header, the append-only audit, catalog-only activation, ungated rollback and the eval gate.
   - Never put the admin service in `chat.v1`.
4. **Cloud Run `cpu_idle = true`.** Evals must be synchronous. The budgets stack: 80s gate ≤ 85s MCP bound ≤ 90s `StreamLifetime` ≤ 120s.
5. **DeepSeek can hold a queued request open with keep-alives for 10 minutes.** Without the first-byte timeout, the web proxy (60s) times out instead of falling back.
6. **DeepSeek's defaults.** Thinking is on by default. Legacy names silently remap. Prices change, and off-peak halves them.
7. **OpenRouter** may drop `tool_choice` or route to fp4 endpoints, so always send `require_parameters`, pin `only`, and keep the violation check. OpenRouter's `deepseek-v4-flash` (V4 0423) is a different model from DeepSeek direct's `deepseek-flash` (V4.1).
8. **The legacy Gemini SDK.** Never make Gemini 3.x activatable on it. The gax-go pin and its regression test must survive until P1c removes the legacy SDK everywhere.
9. **Redaction.** Call `registerSecrets` for every key. Never log request bodies. `EndUser` must be a hash.
10. **Observability.** Keep `event_type:"gemini_request"` for Gemini.
11. **pgx in simple-protocol mode.** Pass JSONB as strings, take transaction-scoped advisory locks only, and use no `TEXT[]` parameters. `MaxConns=5`, so keep router reads cached.
12. **Fallback can hide our own bugs.** A 400 from a bad request would quietly fall back to Gemini. Alert on the `chat_provider_fallback` rate and show fallbacks in `GetModelUsage`.
13. **The 12-turn gate is a tripwire, not proof.** A model that is truly 95% correct passes it about 88% of the time. Before switching provider families, also require the offline 56-turn harness at 0.95.
14. **`svc-paid-probe` sits in a fixed percent bucket.** Add it to `user_ids` when the probe should cover the candidate.
15. **Codegen.** `buf generate` writes Go, TypeScript and Java. Keep `_UNSPECIFIED` enum zero values, and never import a Connect client in a client component.

Client choices:

- **Raw `net/http` for the OpenAI-compatible adapter.** The existing `sashabaranov/go-openai` cannot send `thinking: disabled`. `openai-go` v3 could, but it is a large, fast-moving dependency. The surface we need is one POST plus an SSE parser.
- **Gemini moves to `genai` in P1b, after P1.** P1 keeps the legacy SDK so the refactor is proven with no behaviour change (the same `ChatSession`, the same wire bytes). P1b then swaps one adapter, gated on the grounding eval.

## 11. Decisions for the product owner (recommended defaults)

1. **Which providers first:** a gate run on `gemini-2.5-flash-lite` (config only, about 70% cheaper), then DeepSeek direct `deepseek-flash` with thinking off. OpenRouter for experiments, pinned to endpoints that honour forced tool choice.
2. **Data handling:** DeepSeek direct is hosted in the PRC. Admin self-preview is allowed, but percent or all rollout waits for a privacy review and a privacy-policy update. The alternative is OpenRouter with `data_collection:"deny"` / `zdr` on US endpoints.
   - **Decided 2026-10-25 (product owner):** prod sets `CHAT_ALLOW_PRC_HOSTED_PROVIDER=true`, so DeepSeek direct is selectable through the `chat-model` flag. It is never the default, and no user reaches it unless Flaggr targets them. The privacy review and the privacy-policy update are still open.
3. **Routing:** superseded by §12. The model is chosen per user by the Flaggr `chat-model` flag, and the default stays the env model. Per-tier routing is deferred.
4. **Eval-gate bypass:** only for self-preview. Percent, all and promote always need a gate passed within 7 days on the exact config. Rollback and reset are never gated.
5. **Gate thresholds:** ≥ 11/12 correct, 12/12 grounded, 0 errored, 0 first-call violations, p90 ≤ 20s. Plus the offline 56-turn harness at 0.95 before switching provider families.
6. **Custom model IDs:** allowed for test and smoke only. Activation is catalog-only.
7. **Automatic fallback:** on, to env Gemini, with an alert on its rate.
8. **Keys and spend caps:** a separate chat-only key for each provider, with a spend cap.
9. **Showing the model to users:** no. `served_by` reaches admins and the probe only.

## 12. Switching the chat model with Flaggr

The model is chosen per user by the Flaggr flag `chat-model`. Code: `model_flag.go`
(the selector), `model_flag_routes.go` (the registry) and `service.go` (`runTurn`).
The default route is the env router, unchanged, so with no flag the service does
exactly what it did before.

**The flag.** Key `chat-model`, a string flag, in the `production` environment of
the Flaggr service whose id is `FLAGGR_SERVICE_ID`. The value is a route id,
`<provider>:<model>`. `""` or `"default"` means the env default, which is
`gemini:gemini-2.5-flash` in prod. The activatable route ids are:

- `gemini:gemini-2.5-flash` (the default), `gemini:gemini-2.5-flash-lite`
- `deepseek:deepseek-flash`, `deepseek:deepseek-v4-pro`
- `openrouter:deepseek/deepseek-v4-flash`, `openrouter:openai/gpt-5-mini`

`CatalogRouteIDs()` lists them from the catalog. A route is offered only when the
service runs it: its key is set, `validateRoute` accepts it for the environment,
and it is activatable. The startup log `chat model flag on: default=... flagged_routes=[...]`
lists what this deployment offers. In prod, OpenRouter's key is not wired yet, so
its two routes are not offered. A value outside that list is a default with
`default_unknown_route`, never an error. The flag cannot choose a route the
deploy-time guards refuse.

**Targeting.** Flaggr targets by the user id (`TargetingKey`). Before you enable it
for anyone else, add a rule for your own uid and check the route on your own turn
(`route=` and `route_source=flag` in the `chat turn:` log line).

**Fail-open.** Every failure returns the default, and the turn is answered with no
error. That covers an unset key or service id (no client, no call), a timeout (200ms
per lookup, so a new user's first turn adds at most that), a transport error, a
401, 403, 429 or 5xx, a malformed answer, `NOT_FOUND`, a disabled flag, an unknown
or wrong-type value, and a panic. After 3 consecutive failures Flaggr is not called
for 60s; the breaker logs once when it opens and once when it closes. Answers are cached per
user for 30s (`CHAT_MODEL_FLAG_TTL`), and a stale answer is served while one background
refresh runs. A flagged route that fails before any text still falls back to the Gemini
default, through the router's usual rules.

**Watch.** The counter `shorted.chat.model_flag_evaluations_total{outcome}`, with
outcomes `flag`, `cache`, `stale` and the `default_*` reasons. A rising
`default_timeout` or `default_breaker` means Flaggr is slow or down. A rising
`default_error` means its answers are failing. Rate-limit warnings are on the
`chat model flag:` log lines, at most one a minute per kind. Flaggr allows 1,000
requests a minute from one IP, so watch `default_error` for 429s.

**Operator steps to switch it on.**

1. Create the Flaggr project and the `chat-model` string flag in its `production`
   environment, with a rule for your uid. Copy the service id from its Connection
   tab, and create a project API token (`fgr_...`).
2. Set the GitHub secrets `FLAGGR_API_KEY` (the token), `FLAGGR_SERVICE_ID`
   (the service id) and `DEEPSEEK_API_KEY` (a chat-only key with a low balance).
   Cuttlefish holds the deploy values: `cuttle secrets set NAME --project shorted`.
   The workflow syncs each to Secret Manager, and sets the Terraform inputs for you.
   No Terraform variable needs setting by hand.
3. Deploy. Prod already sets `CHAT_ALLOW_PRC_HOSTED_PROVIDER=true`, and the default
   stays Gemini. Check the startup log for `chat model flag on` and the route list.

**Off.** Remove the `FLAGGR_API_KEY` GitHub secret and deploy: the next plan drops its
env var and grant, and with no key the selector makes no calls. To stop it at once,
remove the `FLAGGR_API_KEY` env var from the Cloud Run revision, then remove the
secret so the next deploy does not restore it.
