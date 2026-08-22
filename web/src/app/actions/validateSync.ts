"use server";

import { SHORTS_API_URL } from "./config";
import { requireAdmin } from "~/server/admin";

/**
 * Per-stock, READ-ONLY validation of the ASIC short-positions sync.
 *
 * Same posture as runJob.ts: admin-gated IN the action (server actions are
 * addressable by action-id, so /admin middleware is not the gate), and the
 * INTERNAL_SERVICE_SECRET never leaves the server.
 *
 * The action forwards stock codes and an optional window size, and nothing
 * else. The backend builds the job arguments itself
 * (`short-data-sync -shadow -stocks <codes> [-validate-days N]`) — this action
 * is a courier and cannot influence what the run does. The window is an int,
 * range-checked server-side and rendered with strconv there, so it can widen
 * the read and nothing more: there is no way from here to start a WRITING run
 * of the sync.
 */

const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

/** Machine-readable refusal codes emitted by /api/admin/jobs/validate-sync. */
export type ValidateSyncCode =
  | "invalid_stocks"
  | "invalid_days"
  | "invalid_execution"
  | "invalid_body"
  | "unknown_job"
  | "retired"
  | "not_executable"
  | "not_configured"
  | "validation_failed"
  | "summary_not_found"
  | "request_failed";

/** One (code, date) row of the report. Mirrors the job's `stocks.observations`. */
export interface StockObservation {
  code: string;
  date: string;
  file?: string;
  status: "new" | "unchanged" | "changed" | "missing-from-file";
  file_values?: StockValues;
  db_values?: StockValues;
  changed_fields?: string[];
  would_insert?: boolean;
  would_update?: boolean;
  would_skip?: boolean;
}

export interface StockValues {
  product: string;
  reported_short_positions: number;
  total_product_in_issue: number;
  percent: number;
}

/** The `stocks` section of the shadow summary. */
export interface StocksSection {
  requested: string[];
  /**
   * Codes that appeared in NO file of the window — a real signal (delisted or
   * never shorted). NOT the same as "there was no window": that is
   * `window_empty`, which every renderer must check FIRST, because with no
   * files `not_found` is vacuous.
   */
  not_found: string[];
  observations: StockObservation[];
  counts: Record<string, number>;
  /** Rows the comparison SELECT returned FOR THE REQUESTED CODES. */
  db_rows_in_window: number;
  files_in_window?: number;
  window_empty?: boolean;
}

/**
 * The window a validation run scanned — the last N *published* ASIC dates,
 * deliberately independent of what is already ingested. Present only on a
 * `-stocks` run.
 */
export interface ValidationWindow {
  days: number;
  from?: string;
  to?: string;
  files: string[];
  /** The date a normal sync would have started at, ignored for validation. */
  ignored_cutoff?: string;
  /** Set ONLY when the window came out empty — the one real failure mode. */
  problem?: string;
}

/**
 * The job's shadow summary. Only the fields the console renders are typed;
 * everything else travels but is not depended on, so a job-side addition never
 * breaks this surface.
 */
export interface ShadowSummary {
  mode: string;
  schema_version: number;
  generated_at: string;
  sync_days: number;
  last_shorts_date?: string;
  already_up_to_date?: boolean;
  files_selected: number;
  files_parsed: number;
  files_failed?: { file: string; error: string }[];
  rows_parsed: number;
  would_insert: number;
  would_update: number;
  duplicate_keys?: number;
  checksum?: string;
  stocks?: StocksSection;
  validation?: ValidationWindow;
}

export interface StartValidationResult {
  ok: boolean;
  executionName?: string;
  /** The argv the BACKEND constructed. Display only — it is never sent by us. */
  args?: string[];
  stocks?: string[];
  message: string;
  code?: ValidateSyncCode;
}

export interface ValidationReport {
  ok: boolean;
  status?: "running" | "succeeded" | "failed" | "unknown";
  executionName?: string;
  startedAt?: string;
  completedAt?: string;
  logUri?: string;
  message?: string;
  logTail?: string[];
  summary?: ShadowSummary;
  code?: ValidateSyncCode;
}

interface ApiError {
  error?: string;
  message?: string;
}

function headers() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${INTERNAL_SECRET}`,
    "x-internal-secret": INTERNAL_SECRET,
    "User-Agent": "Mozilla/5.0 (compatible; ShortedAdmin)",
  } as Record<string, string>;
}

/** Client-side-friendly pre-check, mirroring the backend's contract. */
const CODE_PATTERN = /^[A-Z0-9]{1,5}$/;
const MAX_CODES = 20;
/** Mirrors the backend cap on `-validate-days`. */
export const MAX_VALIDATE_DAYS = 30;

/**
 * Splits and validates a raw operator string. Exported so the input can refuse
 * bad codes before costing a Cloud Run execution — the backend re-validates
 * regardless, because a client check is a convenience, never a gate.
 */
export async function normalizeStockInput(
  raw: string,
): Promise<{ codes: string[]; error?: string }> {
  const codes: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const code = part.trim().toUpperCase();
    if (!code) continue;
    if (!CODE_PATTERN.test(code)) {
      return { codes: [], error: `"${part}" is not an ASX product code` };
    }
    if (!codes.includes(code)) codes.push(code);
  }
  if (codes.length === 0) return { codes: [], error: "Enter at least one stock code" };
  if (codes.length > MAX_CODES) {
    return { codes: [], error: `Too many codes: ${codes.length} (max ${MAX_CODES})` };
  }
  return { codes };
}

/**
 * Starts a validation run. Returns as soon as Cloud Run accepts it (202).
 *
 * `days` is optional and, when omitted, is left OUT of the body entirely so the
 * job's own default window stays the single source of truth. The backend
 * range-checks it regardless; this is a convenience, never a gate.
 */
export async function startSyncValidation(input: {
  stocks: string[];
  days?: number;
}): Promise<StartValidationResult> {
  const admin = await requireAdmin();
  const payload: { stocks: string[]; days?: number } = { stocks: input.stocks };
  if (typeof input.days === "number" && Number.isInteger(input.days) && input.days > 0) {
    payload.days = Math.min(input.days, MAX_VALIDATE_DAYS);
  }

  // No retries: this is a MUTATION (it creates a Cloud Run execution). A
  // retried POST after a timeout would start a second one.
  try {
    const response = await fetch(`${SHORTS_API_URL}/api/admin/jobs/validate-sync`, {
      method: "POST",
      headers: { ...headers(), "x-admin-actor": admin.email },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const body = (await response.json().catch(() => ({}))) as ApiError & {
      executionName?: string;
      args?: string[];
      stocks?: string[];
    };

    if (!response.ok) {
      return {
        ok: false,
        code: (body.error as ValidateSyncCode) ?? "request_failed",
        message: body.message ?? `Request failed (HTTP ${response.status})`,
      };
    }
    return {
      ok: true,
      executionName: body.executionName,
      args: body.args,
      stocks: body.stocks,
      message: body.executionName
        ? `Validation started: ${body.executionName}`
        : "Validation started",
    };
  } catch (err) {
    console.error("Failed to start sync validation:", err);
    return {
      ok: false,
      code: "request_failed",
      message: err instanceof Error ? err.message : "Request failed",
    };
  }
}

/**
 * Polls one validation execution.
 *
 * A still-running execution is a SUCCESSFUL call with status "running" — the
 * caller keeps polling. Only a transport/permission problem is `ok: false`.
 */
export async function getSyncValidation(executionName: string): Promise<ValidationReport> {
  await requireAdmin();

  try {
    const url = `${SHORTS_API_URL}/api/admin/jobs/validate-sync?execution=${encodeURIComponent(
      executionName,
    )}`;
    const response = await fetch(url, { headers: headers(), cache: "no-store" });
    const body = (await response.json().catch(() => ({}))) as ApiError &
      Partial<ValidationReport> & { summary?: ShadowSummary };

    if (!response.ok) {
      return {
        ok: false,
        code: (body.error as ValidateSyncCode) ?? "request_failed",
        status: body.status,
        message: body.message ?? `Request failed (HTTP ${response.status})`,
        logTail: body.logTail,
        logUri: body.logUri,
      };
    }
    return {
      ok: true,
      status: body.status ?? "unknown",
      executionName: body.executionName,
      startedAt: body.startedAt,
      completedAt: body.completedAt,
      logUri: body.logUri,
      message: body.message,
      logTail: body.logTail,
      summary: body.summary,
    };
  } catch (err) {
    console.error("Failed to poll sync validation:", err);
    return {
      ok: false,
      code: "request_failed",
      message: err instanceof Error ? err.message : "Request failed",
    };
  }
}
