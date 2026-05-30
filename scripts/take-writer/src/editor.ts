// Editor agent — the assignment desk. Reads the day's signal board,
// applies a novelty gate (don't re-cover a stock without a new
// development), and asks Gemini to commission the day's stories with an
// angle and a tier (take | deep_dive).

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { Client as PgClient } from "pg";
import { buildSignalBoard, type SignalBoardRow } from "./journalism.js";

export interface Assignment {
  stockCode: string;
  industry: string | null;
  angle: string;
  tier: "take" | "deep_dive";
  rationale: string;
}

export interface EditorOptions {
  poolSize?: number;
  maxTakes?: number;
  maxDeepDives?: number;
  model?: string;
}

const SHORT_REGIME_CHANGE_PCT = 2.0; // |current - 90d avg| beyond this = regime change

/**
 * Pure novelty gate. A stock is worth covering if it has never been
 * covered, OR something material happened after the last take:
 *  - a price-sensitive headline dated after lastTakeDate
 *  - a short-position regime change (|shortPctChange90d| >= threshold)
 *  - a director trade dated after lastTakeDate
 */
export function hasNewDevelopment(row: SignalBoardRow): boolean {
  if (!row.lastTakeDate) return true;
  const since = row.lastTakeDate;
  if (row.recentPriceSensitiveHeadlines.some((h) => h.date > since)) return true;
  if (Math.abs(row.signals.shortPctChange90d ?? 0) >= SHORT_REGIME_CHANGE_PCT) return true;
  if (row.signals.directorMostRecentDate && row.signals.directorMostRecentDate > since) return true;
  return false;
}

const EDITOR_SYSTEM = `You are the editor of Shorted, an ASX short-position
publication. From the signal board, commission the day's stories. Be
selective — only stories with a genuine angle a reader would click.

For each story pick:
- angle: one sharp sentence naming what the story IS (not a headline).
- tier: "deep_dive" only when there is a rich, multi-thread story worth
  600-1200 words (a probe with a timeline, a director-vs-data divergence,
  a sector unwind). Otherwise "take".

Return STRICT JSON: {"assignments":[{"stockCode","angle","tier","rationale"}]}.
No prose outside the JSON.`;

export async function commissionAssignments(
  pg: PgClient,
  opts: EditorOptions = {},
): Promise<Assignment[]> {
  const maxTakes = opts.maxTakes ?? 10;
  const maxDeepDives = opts.maxDeepDives ?? 2;
  const model = opts.model ?? process.env.EDITOR_MODEL ?? "gemini-3.5-flash";

  const board = await buildSignalBoard(pg, opts.poolSize ?? 30);
  const fresh = board.filter(hasNewDevelopment);
  if (fresh.length === 0) return [];

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const boardText = fresh.map((r) => {
    const s = r.signals;
    return [
      `${r.stockCode} (${r.name ?? "?"}, ${r.industry ?? "?"})`,
      `  short ${s.currentShortPct?.toFixed(1)}% (Δ90d ${s.shortPctChange90d?.toFixed(1)}), price 3m ${s.priceChange3m?.toFixed(0)}%, corr ${s.priceShortsCorrelation30d?.toFixed(2)}`,
      `  news30d ${s.newsArticlesLast30d} (ps ${s.priceSensitiveLast30d}), sentiment ${s.sentimentTrendLast30d}, director net A$${s.directorNetValueLast90d.toFixed(0)}`,
      `  last covered: ${r.lastTakeDate ?? "never"}; recent price-sensitive: ${r.recentPriceSensitiveHeadlines.map((h) => `${h.date} ${h.headline}`).join(" | ") || "none"}`,
    ].join("\n");
  }).join("\n\n");

  const ai = new GoogleGenerativeAI(apiKey);
  const geminiModel = ai.getGenerativeModel({
    model,
    systemInstruction: EDITOR_SYSTEM,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          assignments: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                stockCode: { type: SchemaType.STRING },
                angle: { type: SchemaType.STRING },
                tier: { type: SchemaType.STRING, enum: ["take", "deep_dive"], format: "enum" },
                rationale: { type: SchemaType.STRING },
              },
              required: ["stockCode", "angle", "tier", "rationale"],
            },
          },
        },
        required: ["assignments"],
      },
      temperature: 0.4,
    },
  });
  const resp = await geminiModel.generateContent(
    `Signal board (${fresh.length} stocks with a new development):\n\n${boardText}\n\nCommission up to ${maxTakes} takes and ${maxDeepDives} deep-dives. Return the JSON now.`,
  );
  let parsed: { assignments?: Array<{ stockCode: string; angle: string; tier: "take" | "deep_dive"; rationale: string }> };
  try { parsed = JSON.parse(resp.response.text()); } catch { return []; }

  const all = (parsed.assignments ?? []).filter((a) => a.stockCode && (a.tier === "take" || a.tier === "deep_dive"));

  // Enforce caps defensively (the model may over-commission).
  const deepDives = all.filter((a) => a.tier === "deep_dive").slice(0, maxDeepDives);
  const takes = all.filter((a) => a.tier === "take").slice(0, maxTakes);
  const industryByCode = new Map(fresh.map((r) => [r.stockCode, r.industry]));
  return [...deepDives, ...takes].map((a) => {
    const code = a.stockCode.toUpperCase();
    return { ...a, stockCode: code, industry: industryByCode.get(code) ?? null };
  });
}
