// Investigation agent — the agentic core, on Gemini function-calling.
// Given an assignment, it runs Gemini in a tool-calling loop over the
// drill-down tools, registering every retrieved source into the ledger,
// and finalises a structured Dossier via a special emit_dossier tool.
// Turn-capped; if the cap (or a text-only stop) is hit before
// emit_dossier, we finalise with whatever was gathered.

import { SchemaType, type FunctionDeclaration, type Content, type Part } from "@google/generative-ai";
import type { Queryable } from "./drilldowns.js";
import type { CitationLedger } from "./ledger.js";
import { GEMINI_TOOL_DECLS, dispatchTool } from "./tools.js";
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

/** One model turn, normalised so the loop + tests don't depend on the
 *  raw SDK response shape. */
export interface GeminiTurn {
  functionCalls(): Array<{ name: string; args: Record<string, unknown> }> | undefined;
  /** The model Content to append to history (its functionCall parts). */
  modelContent(): Content;
}

export interface GenerateParams {
  systemInstruction: string;
  tools: FunctionDeclaration[];
  contents: Content[];
}

/** Injected so the loop is unit-testable without a live API. The
 *  production impl (newsroom.ts) builds a Gemini model with the given
 *  systemInstruction + tools and calls generateContent({ contents }). */
export type GeminiGenerate = (p: GenerateParams) => Promise<GeminiTurn>;

export interface InvestigateOptions {
  maxTurns?: number;
}

const EMIT_DOSSIER_DECL: FunctionDeclaration = {
  name: "emit_dossier",
  description: "Call this ONCE when your investigation is complete to hand off your findings. Cite evidence ONLY by the refIds returned to you by other tools.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      summary: { type: SchemaType.STRING, description: "2-3 sentence neutral summary of what you found." },
      threads: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            claim: { type: SchemaType.STRING },
            evidenceRefIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            note: { type: SchemaType.STRING },
          },
          required: ["claim", "evidenceRefIds"],
        },
      },
      timeline: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            date: { type: SchemaType.STRING },
            event: { type: SchemaType.STRING },
            refIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          },
          required: ["date", "event"],
        },
      },
      keyNumbers: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            label: { type: SchemaType.STRING },
            value: { type: SchemaType.STRING },
            refId: { type: SchemaType.STRING },
          },
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
 * NOTE: this may THROW if the injected `generate` (Gemini API call)
 * fails — callers running this in a batch MUST wrap each invocation in
 * try/catch so one failed assignment doesn't abort the whole run.
 */
export async function investigate(
  generate: GeminiGenerate,
  pg: Queryable,
  assignment: Assignment,
  ledger: CitationLedger,
  opts: InvestigateOptions = {},
): Promise<Dossier> {
  const maxTurns = opts.maxTurns ?? (assignment.tier === "deep_dive" ? 14 : 6);
  const tools = [...GEMINI_TOOL_DECLS, EMIT_DOSSIER_DECL];
  const sys = systemPrompt(assignment);
  const contents: Content[] = [{
    role: "user",
    parts: [{ text: `Begin your investigation of ${assignment.stockCode}. Angle: ${assignment.angle}.` }],
  }];
  let nudged = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await generate({ systemInstruction: sys, tools, contents });
    const calls = resp.functionCalls() ?? [];

    if (calls.length === 0) {
      // Model replied with text but called no tool. Nudge once back to
      // emit_dossier before giving up, rather than silently discarding.
      if (!nudged && turn < maxTurns - 1) {
        nudged = true;
        contents.push(resp.modelContent());
        contents.push({ role: "user", parts: [{ text: "You have not called emit_dossier yet. Call emit_dossier now with your findings, citing only refIds the tools returned." }] });
        continue;
      }
      break;
    }

    const emit = calls.find((c) => c.name === "emit_dossier");
    if (emit) return finalise(assignment, emit.args as Partial<Dossier>);

    contents.push(resp.modelContent());
    const parts: Part[] = [];
    for (const c of calls) {
      const result = await dispatchTool(pg, ledger, c.name, c.args, assignment.stockCode);
      parts.push({ functionResponse: { name: c.name, response: { result } } });
    }
    contents.push({ role: "user", parts });
  }

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
