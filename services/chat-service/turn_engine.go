package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
)

// turnError is what a turn returns when it fails. ModelReached says whether the
// model answered at all. A request it refuses before any response is not billed,
// so the send must not count against the caller's limits. A failure after the
// first response did reach the model, and counts.
type turnError struct {
	ModelReached bool
	err          error
}

func (e *turnError) Error() string { return e.err.Error() }

func (e *turnError) Unwrap() error { return e.err }

// modelAnswered reports whether a failed turn got as far as the model.
func modelAnswered(err error) bool {
	var te *turnError
	return errors.As(err, &te) && te.ModelReached
}

// LLMResponse represents a response from the LLM.
type LLMResponse struct {
	Content   string
	ToolCalls []ToolCallRecord
	Citations []Citation
	Usage     TokenUsage
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

// turnMeta names the provider and model a turn runs on, for its metrics.
type turnMeta struct {
	Provider string
	Model    string
}

// TurnEngine runs one chat turn over a model session: the tool rounds, their
// budgets, the answers to refused calls, and the usage. It makes no provider
// call itself, so the same rules apply to every provider.
type TurnEngine struct {
	tools *ToolExecutor
}

// run plays one turn. The first call sends the user's text and must choose a
// tool. Each later call answers every call of the previous reply, and offers
// tools only while the round has budget. Text is passed to onChunk as it streams.
func (e *TurnEngine) run(ctx context.Context, session ModelSession, meta turnMeta, userText string, onChunk func(text string)) (*LLMResponse, error) {
	emit := func(ev ModelEvent) {
		if ev.Kind == EventTextDelta && ev.Text != "" {
			onChunk(ev.Text)
		}
	}

	var allToolCalls []ToolCallRecord
	var totalUsage TokenUsage

	// First call: a data tool, or answer_without_data when no data is needed.
	reply, err := session.Send(ctx, SendInput{UserText: userText}, choiceForCall(true, true), emit)
	if err != nil {
		recordModelRequest(ctx, meta.Provider, meta.Model, "initial", "error", reply.Usage)
		return nil, &turnError{ModelReached: providerReached(err), err: err}
	}
	recordModelRequest(ctx, meta.Provider, meta.Model, "initial", "success", reply.Usage)
	totalUsage.Add(reply.Usage)
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
		reply, err := session.Send(ctx, SendInput{ToolResults: results}, choice, emit)
		if err != nil {
			recordModelRequest(ctx, meta.Provider, meta.Model, "tool_response", "error", reply.Usage)
			return nil, &turnError{ModelReached: true, err: err}
		}
		recordModelRequest(ctx, meta.Provider, meta.Model, "tool_response", "success", reply.Usage)
		totalUsage.Add(reply.Usage)
		pending = reply.ToolCalls

		// Without budget there is no round left to run calls in, so anything
		// the model requested in this response is dropped rather than looped on.
		if !hasBudget {
			break
		}
	}

	return &LLMResponse{
		ToolCalls: allToolCalls,
		Usage:     totalUsage,
	}, nil
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
