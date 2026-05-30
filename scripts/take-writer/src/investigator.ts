// Investigation agent — the agentic core. Given an assignment, it runs
// Claude in a tool-calling loop over the drill-down tools, registering
// every retrieved source into the ledger, and finalises a structured
// Dossier via a special emit_dossier tool. Turn-capped; if the cap is
// hit before emit_dossier, we finalise with whatever was gathered.

import type Anthropic from "@anthropic-ai/sdk";
import type { Queryable } from "./drilldowns.js";
import type { CitationLedger } from "./ledger.js";
import { TOOL_DEFS, dispatchTool } from "./tools.js";
import type { Assignment } from "./editor.js";

export interface DossierThread { claim: string; evidenceRefIds: string[]; note?: string }
export interface DossierTimelineItem { date: string; event: string; refIds: string[] }
export interface DossierKeyNumber { label: string; value: string; refId?: string }
export interface Dossier {
  stockCode: string;
  tier: "take" | "deep_dive";
  angle: string;
  summary: string;
  threads: DossierThread[];
  timeline?: DossierTimelineItem[];
  keyNumbers: DossierKeyNumber[];
}

/** The subset of Anthropic's client.messages.create we depend on. */
export type MessagesCreate = (body: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export interface InvestigateOptions {
  maxTurns?: number;
  model: string;
  maxTokens?: number;
}

const EMIT_DOSSIER_TOOL: Anthropic.Tool = {
  name: "emit_dossier",
  description: "Call this ONCE when your investigation is complete to hand off your findings. Cite evidence ONLY by the refIds returned to you by other tools.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "2-3 sentence neutral summary of what you found." },
      threads: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            evidenceRefIds: { type: "array", items: { type: "string" } },
            note: { type: "string" },
          },
          required: ["claim", "evidenceRefIds"],
        },
      },
      timeline: {
        type: "array",
        items: {
          type: "object",
          properties: { date: { type: "string" }, event: { type: "string" }, refIds: { type: "array", items: { type: "string" } } },
          required: ["date", "event"],
        },
      },
      keyNumbers: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, value: { type: "string" }, refId: { type: "string" } },
          required: ["label", "value"],
        },
      },
    },
    required: ["summary", "threads", "keyNumbers"],
  },
};

function systemPrompt(a: Assignment): string {
  return `You are an investigative reporter for Shorted (ASX short positions).
Assignment: ${a.stockCode} — ${a.angle}
Tier: ${a.tier} (${a.tier === "deep_dive" ? "rich, multi-thread; build a timeline" : "tight, single sharp thread"}).

Investigate using the tools. Drill into spikes, follow peers, align
director trades to price, pull reported numbers. Every factual claim in
your dossier MUST be backed by a refId a tool returned to you — do not
invent sources or numbers. When done, call emit_dossier exactly once.
Keep it to ${a.tier === "deep_dive" ? "at most 10" : "at most 4"} investigative tool calls before emitting.`;
}

/**
 * Run the agentic investigation loop and return a Dossier.
 * NOTE: this may THROW if the injected `create` (Anthropic API call)
 * fails — callers running this in a batch MUST wrap each invocation in
 * try/catch so one failed assignment doesn't abort the whole run.
 */
export async function investigate(
  create: MessagesCreate,
  pg: Queryable,
  assignment: Assignment,
  ledger: CitationLedger,
  opts: InvestigateOptions,
): Promise<Dossier> {
  const maxTurns = opts.maxTurns ?? (assignment.tier === "deep_dive" ? 14 : 6);
  const tools = [...TOOL_DEFS, EMIT_DOSSIER_TOOL];
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: `Begin your investigation of ${assignment.stockCode}. Angle: ${assignment.angle}.`,
  }];

  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4000,
      system: systemPrompt(assignment),
      tools,
      messages,
    });

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      // Model replied with text but called no tool. Nudge it back to
      // emit_dossier once; if it still won't, finalise with what we have
      // rather than silently discarding the investigation.
      if (resp.stop_reason === "end_turn" && turn < maxTurns - 1) {
        messages.push({ role: "assistant", content: resp.content });
        messages.push({ role: "user", content: "You have not called emit_dossier yet. Call emit_dossier now with your findings, citing only refIds the tools returned." });
        continue;
      }
      break;
    }

    // Did it emit the dossier? Finalise.
    const emit = toolUses.find((t) => t.name === "emit_dossier");
    if (emit) {
      const input = emit.input as Partial<Dossier>;
      return finalise(assignment, input);
    }

    // Otherwise run the requested tools and feed results back.
    messages.push({ role: "assistant", content: resp.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      const result = await dispatchTool(pg, ledger, t.name, t.input as Record<string, unknown>, assignment.stockCode);
      toolResults.push({ type: "tool_result", tool_use_id: t.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Turn cap hit without emit_dossier — finalise minimally with what's gathered.
  return finalise(assignment, {});
}

function finalise(assignment: Assignment, input: Partial<Dossier>): Dossier {
  return {
    stockCode: assignment.stockCode,
    tier: assignment.tier,
    angle: assignment.angle,
    summary: typeof input.summary === "string" && input.summary.trim() ? input.summary : assignment.angle,
    threads: Array.isArray(input.threads)
      ? input.threads.filter(
          (t): t is DossierThread =>
            typeof t === "object" && t !== null &&
            typeof (t as DossierThread).claim === "string" &&
            Array.isArray((t as DossierThread).evidenceRefIds),
        )
      : [],
    timeline: Array.isArray(input.timeline)
      ? input.timeline
          .filter(
            (t): t is DossierTimelineItem =>
              typeof t === "object" && t !== null &&
              typeof (t as DossierTimelineItem).date === "string" &&
              typeof (t as DossierTimelineItem).event === "string",
          )
          .map((t) => ({ ...t, refIds: Array.isArray(t.refIds) ? t.refIds : [] }))
      : undefined,
    keyNumbers: Array.isArray(input.keyNumbers)
      ? input.keyNumbers.filter(
          (n): n is DossierKeyNumber =>
            typeof n === "object" && n !== null &&
            typeof (n as DossierKeyNumber).label === "string" &&
            typeof (n as DossierKeyNumber).value === "string",
        )
      : [],
  };
}
