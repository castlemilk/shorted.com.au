package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
	"strings"
	"time"
)

// turnError is what a turn returns when it fails. ModelReached says whether the
// model answered at all. A request it refuses before any response is not billed,
// so the send must not count against the caller's limits. A failure after the
// first response did reach the model, and counts. Billed is what the calls that
// reached the model cost, so the ledger and the turn's cost keep it even when a
// fallback then answers.
type turnError struct {
	ModelReached bool
	Billed       turnTally
	err          error
}

func (e *turnError) Error() string { return e.err.Error() }

func (e *turnError) Unwrap() error { return e.err }

// modelAnswered reports whether a failed turn got as far as the model.
func modelAnswered(err error) bool {
	var te *turnError
	return errors.As(err, &te) && te.ModelReached
}

// billedBy returns what a failed turn spent on the model, or zero when the error
// carries no turnError.
func billedBy(err error) turnTally {
	var te *turnError
	if errors.As(err, &te) {
		return te.Billed
	}
	return turnTally{}
}

// withBilled adds spend to a failed turn's error. Any spend means a call reached
// the model, so the error counts against the caller's limits.
func withBilled(err error, spent turnTally) error {
	if spent.calls == 0 {
		return err
	}
	var te *turnError
	if !errors.As(err, &te) {
		return &turnError{ModelReached: true, Billed: spent, err: err}
	}
	total := te.Billed
	total.merge(spent)
	return &turnError{ModelReached: true, Billed: total, err: te.err}
}

// LLMResponse represents a response from the LLM. Provider, Model and Route name
// the model that answered: Route is "env_default" or "fallback".
type LLMResponse struct {
	Content            string
	ToolCalls          []ToolCallRecord
	Citations          []Citation
	Usage              TokenUsage
	Provider           string
	Model              string
	Route              string
	FirstCallViolation bool  // the first call and its retry both chose no tool
	EstCostMicroUSD    int64 // the estimated cost of every call that succeeded
}

// ToolCallRecord records a tool call made during the conversation.
type ToolCallRecord struct {
	Name   string         `json:"name"`
	Args   map[string]any `json:"args"`
	Result string         `json:"result"`
}

// Citation references data used in the response.
type Citation struct {
	Source string `json:"source"`
	Text   string `json:"text"`
}

// turnMeta names the provider and model a turn runs on, and what the model
// costs, for its metrics.
type turnMeta struct {
	Provider string
	Model    string
	Pricing  Pricing
	Start    time.Time // the turn's start, which decides off-peak pricing
}

// firstCallNudge is the sentence the verify policy adds to the system prompt. A
// retry after a first call that chose no tool adds it too.
const firstCallNudge = "Before you answer, call a tool: a data tool, or answer_without_data when no data is needed."

// turnSpec is one turn as the engine runs it. The engine opens a session for the
// first call and another for a retry, so it holds the provider, not a session.
type turnSpec struct {
	provider ChatProvider
	cfg      SessionConfig // cfg.System is the base prompt
	userText string
	// forcedFirstCall says the model honours a required choice, so its first call
	// must call a tool. Otherwise the verify policy applies: the first call is
	// Auto, and the prompt carries the nudge.
	forcedFirstCall bool
	meta            turnMeta
}

// turnTally is the usage and cost of the calls that reached the model: the ones
// that succeeded, and any that failed after the model had billed them.
type turnTally struct {
	usage TokenUsage
	cost  int64
	calls int
}

// TurnEngine runs one chat turn over a model session: the tool rounds, their
// budgets, the answers to refused calls, the first-call check and the usage. It
// makes no provider call itself, so the same rules apply to every provider.
type TurnEngine struct {
	tools *ToolExecutor
}

// run plays one turn. Its first call must choose a tool. A first reply with no
// tool call is retried once on a fresh session with the nudge; if the retry also
// calls no tool, its text is the answer and the turn is marked. Each later call
// answers every call of the previous reply, and offers tools only while the round
// has budget. Text reaches onChunk once it is known to be the answer.
//
// A failed turn keeps what its calls billed, so the router can charge it to the
// answer that follows, or to the ledger when none comes.
func (e *TurnEngine) run(ctx context.Context, spec turnSpec, onChunk func(text string)) (*LLMResponse, error) {
	var tally turnTally
	resp, err := e.play(ctx, spec, onChunk, &tally)
	if err != nil {
		return nil, withBilled(err, tally)
	}
	return resp, nil
}

// play is run's body. It adds each call's usage to tally, including a failed call
// the model billed.
func (e *TurnEngine) play(ctx context.Context, spec turnSpec, onChunk func(text string), tally *turnTally) (*LLMResponse, error) {
	var allToolCalls []ToolCallRecord

	system := spec.cfg.System
	if !spec.forcedFirstCall {
		system = withNudge(system)
	}
	session, reply, held, err := e.sendFirst(ctx, spec, system, tally)
	if err != nil {
		return nil, err
	}

	if len(reply.ToolCalls) == 0 {
		recordFirstCallViolation(ctx, spec.meta.Provider, spec.meta.Model)
		session, reply, held, err = e.sendFirst(ctx, spec, withNudge(spec.cfg.System), tally)
		if err != nil {
			return nil, err
		}
		if len(reply.ToolCalls) == 0 {
			for _, text := range held {
				onChunk(text)
			}
			return &LLMResponse{
				Content:            strings.Join(held, ""),
				Usage:              tally.usage,
				EstCostMicroUSD:    tally.cost,
				FirstCallViolation: true,
			}, nil
		}
	}
	// The first call chose a tool. Text it wrote before the call is a preamble,
	// and it is shown here, as it was before first-call text was held back.
	for _, text := range held {
		onChunk(text)
	}
	pending := reply.ToolCalls

	// Rounds 0 to maxToolRounds-1 run tools. The round after them runs none:
	// every call still pending is answered with a notice, and the model is asked
	// for text with function calling off. A turn therefore never ends on a
	// request the model made and never got an answer to, and never ends without
	// text while the model still had calls to make.
	for round := 0; len(pending) > 0; round++ {
		hasBudget := roundHasBudget(round)
		choice := choiceForCall(false, hasBudget)

		calls := pending
		decisions := planRoundCalls(calls, hasBudget)

		results := make([]ToolResult, 0, len(calls))
		for i, call := range calls {
			if decisions[i] != toolCallExecute {
				notice, _ := json.Marshal(toolCallNotice(decisions[i]))
				results = append(results, ToolResult{CallID: call.ID, Name: call.Name, JSON: string(notice)})
				continue
			}

			args := make(map[string]any)
			maps.Copy(args, call.Args)

			log.Printf("Executing tool: %s with args: %v", call.Name, args)
			result, execErr := e.tools.Execute(ctx, call.Name, args)
			status := "success"
			if execErr != nil {
				status = "error"
				result = "Error: " + redactSecrets(execErr.Error())
			}
			allToolCalls = recordToolRun(ctx, allToolCalls, call.Name, args, result, status)
			results = append(results, ToolResult{CallID: call.ID, Name: call.Name, JSON: result})
		}

		// Send the results, and stream the answer. Tool rounds run only after the
		// model has answered the first call, so a failure here always counts.
		reply, err := session.Send(ctx, SendInput{ToolResults: results}, choice, e.emitter(onChunk))
		cost := EstimateCostMicroUSD(spec.meta.Pricing, reply.Usage, spec.meta.Start)
		if err != nil {
			recordModelRequest(ctx, spec.meta.Provider, spec.meta.Model, "tool_response", "error", reply.Usage, cost)
			if providerReached(err) {
				tally.add(reply.Usage, cost)
			}
			return nil, &turnError{ModelReached: true, err: err}
		}
		recordModelRequest(ctx, spec.meta.Provider, spec.meta.Model, "tool_response", "success", reply.Usage, cost)
		tally.add(reply.Usage, cost)
		pending = reply.ToolCalls

		// Without budget there is no round left to run calls in, so anything
		// the model requested in this response is dropped rather than looped on.
		if !hasBudget {
			break
		}
	}

	return &LLMResponse{
		ToolCalls:       allToolCalls,
		Usage:           tally.usage,
		EstCostMicroUSD: tally.cost,
	}, nil
}

// sendFirst opens a session with the given system prompt and makes its first call.
// The call's text deltas are returned in order, not emitted: the caller decides
// whether they are the answer.
func (e *TurnEngine) sendFirst(ctx context.Context, spec turnSpec, system string, tally *turnTally) (ModelSession, ModelReply, []string, error) {
	cfg := spec.cfg
	cfg.System = system
	session, err := spec.provider.NewSession(cfg)
	if err != nil {
		return nil, ModelReply{}, nil, providerError("start session", err)
	}

	choice := ToolChoiceAuto
	if spec.forcedFirstCall {
		choice = ToolChoiceRequired
	}
	var held []string
	reply, err := session.Send(ctx, SendInput{UserText: spec.userText}, choice, func(ev ModelEvent) {
		if ev.Kind == EventTextDelta && ev.Text != "" {
			held = append(held, ev.Text)
		}
	})
	cost := EstimateCostMicroUSD(spec.meta.Pricing, reply.Usage, spec.meta.Start)
	if err != nil {
		recordModelRequest(ctx, spec.meta.Provider, spec.meta.Model, "initial", "error", reply.Usage, cost)
		if providerReached(err) {
			tally.add(reply.Usage, cost)
		}
		return nil, ModelReply{}, nil, &turnError{ModelReached: providerReached(err), err: err}
	}
	recordModelRequest(ctx, spec.meta.Provider, spec.meta.Model, "initial", "success", reply.Usage, cost)
	tally.add(reply.Usage, cost)
	return session, reply, held, nil
}

// emitter passes text deltas to onChunk.
func (e *TurnEngine) emitter(onChunk func(string)) func(ModelEvent) {
	return func(ev ModelEvent) {
		if ev.Kind == EventTextDelta && ev.Text != "" {
			onChunk(ev.Text)
		}
	}
}

// add counts one call that reached the model into the turn.
func (t *turnTally) add(usage TokenUsage, cost int64) {
	t.usage.Add(usage)
	t.cost += cost
	t.calls++
}

// merge adds another tally's spend to this one.
func (t *turnTally) merge(other turnTally) {
	t.usage.Add(other.usage)
	t.cost += other.cost
	t.calls += other.calls
}

// withNudge returns the system prompt with the first-call sentence appended.
func withNudge(system string) string {
	if system == "" {
		return firstCallNudge
	}
	return system + "\n\n" + firstCallNudge
}

// maxToolRounds is how many rounds of tool calls one turn may run.
const maxToolRounds = 5

// maxToolCallsPerRound caps the calls one model response may make. The model
// can ask for many at once, and each one is a database-backed tool call.
const maxToolCallsPerRound = 4

// roundHasBudget reports whether a zero-based round may still run tools.
func roundHasBudget(round int) bool {
	return round < maxToolRounds
}

// choiceForCall returns the tool choice for one model call of a turn. The first
// call must choose a tool. ToolChoiceRequired forces the choice, not the
// grounding: a figure can still follow answer_without_data, and the eval reads
// that as a no-data choice (noDataChosen). Later calls may answer in text
// when the round has no budget left, and otherwise leave the choice to the model.
func choiceForCall(firstCall, roundHasBudget bool) ToolChoice {
	if firstCall {
		return ToolChoiceRequired
	}
	if roundHasBudget {
		return ToolChoiceAuto
	}
	return ToolChoiceNone
}

// toolCallDecision says what happens to one call a model response requested.
type toolCallDecision int

const (
	toolCallExecute toolCallDecision = iota
	// toolCallOverCap: the response asked for more calls than one round runs.
	toolCallOverCap
	// toolCallNoBudget: the turn has no tool rounds left.
	toolCallNoBudget
	// toolCallBadArgs: the call's argument JSON did not parse, so it did not run.
	toolCallBadArgs
)

// planToolCalls decides, for each of the n calls one response requested,
// whether it runs. Calls past the cap, or in a round without budget, are not
// run, but each still gets a response, because the model rejects a history with
// an unanswered call.
func planToolCalls(n int, roundHasBudget bool) []toolCallDecision {
	decisions := make([]toolCallDecision, n)
	for i := range decisions {
		switch {
		case !roundHasBudget:
			decisions[i] = toolCallNoBudget
		case i >= maxToolCallsPerRound:
			decisions[i] = toolCallOverCap
		default:
			decisions[i] = toolCallExecute
		}
	}
	return decisions
}

// toolCallNotice is the function response for a call that did not run. The
// wording is for the model, which reads it and answers the user.
func toolCallNotice(d toolCallDecision) map[string]any {
	if d == toolCallOverCap {
		return map[string]any{"error": fmt.Sprintf(
			"Only %d tool calls run per reply, so this call did not run. If it is still needed, ask for it in a later message.",
			maxToolCallsPerRound,
		)}
	}
	if d == toolCallBadArgs {
		return map[string]any{"error": "The arguments for this call were not valid JSON, so it did not run. Call it again with valid JSON arguments."}
	}
	return map[string]any{"error": "The tool budget for this reply is spent, so this call did not run. Answer from the data already retrieved, and say plainly what is missing."}
}

// isDataTool reports whether a call is a data tool. answer_without_data is not:
// it reads nothing from the API, so it does not count toward the per-round cap,
// the reply's tool calls or the tool-call metrics.
func isDataTool(name string) bool {
	return name != answerWithoutDataTool
}

// planRoundCalls decides, for each call one model response requested, whether it
// runs. answer_without_data always runs, because it is instant and makes no
// request, so it takes no cap slot and no budget. The data calls are planned by
// planToolCalls.
//
// A data call whose arguments did not parse still takes its cap slot, and gets
// the bad-arguments notice in place of a run. answer_without_data reads no
// arguments, so it always runs.
func planRoundCalls(calls []ToolCall, roundHasBudget bool) []toolCallDecision {
	dataCalls := 0
	for _, call := range calls {
		if isDataTool(call.Name) {
			dataCalls++
		}
	}
	dataDecisions := planToolCalls(dataCalls, roundHasBudget)

	decisions := make([]toolCallDecision, len(calls))
	next := 0
	for i, call := range calls {
		if !isDataTool(call.Name) {
			decisions[i] = toolCallExecute
			continue
		}
		decisions[i] = dataDecisions[next]
		if decisions[i] == toolCallExecute && call.ArgsError != "" {
			decisions[i] = toolCallBadArgs
		}
		next++
	}
	return decisions
}

// recordToolRun keeps an executed data call in the reply's tool calls and counts
// it in the tool-call metrics, and returns the updated records. answer_without_data
// is neither, so the web never shows it as a tool card.
func recordToolRun(ctx context.Context, calls []ToolCallRecord, name string, args map[string]any, result, status string) []ToolCallRecord {
	if !isDataTool(name) {
		return calls
	}
	recordToolCall(ctx, name, len([]byte(result)), status)
	return append(calls, ToolCallRecord{
		Name:   name,
		Args:   args,
		Result: result,
	})
}

// chatToolDefinitions is every tool the model is offered on a turn.
func chatToolDefinitions() []ToolDefinition {
	return append(GetToolDefinitions(), answerWithoutDataDefinition())
}
